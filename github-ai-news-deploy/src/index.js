// AI News Worker —— 资讯 API + MCP 服务
// 鉴权：READ_TOKEN 用于读取（浏览器/WorkBuddy），INGEST_TOKEN 用于写入（采集任务）
// 端点：
//   GET  /health                   健康检查（无需密钥）
//   GET  /api/news                 新闻列表（READ_TOKEN）
//   GET  /api/news/:id             单条新闻（READ_TOKEN）
//   POST /api/news                 写入单条（INGEST_TOKEN）
//   POST /api/news/batch           批量写入，url 去重（INGEST_TOKEN）
//   GET  /api/collection/status    最近采集状态（READ_TOKEN）
//   POST /api/collection/log       采集结束回写日志（INGEST_TOKEN）
//   POST /mcp                      MCP Streamable HTTP（READ_TOKEN）

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400",
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...headers },
  });

const text = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS, ...headers } });

// Bearer 鉴权
function hasBearer(request, token) {
  if (!token) return false;
  const h = request.headers.get("Authorization") || "";
  return h === "Bearer " + token;
}

// SQLite datetime('now') -> 毫秒时间戳
function logTsToMs(ts) {
  if (!ts) return NaN;
  const d = new Date(ts.replace(" ", "T") + "Z");
  return d.getTime();
}

// 读取最近的新闻，支持 hours / category / per_source_limit / 分页
async function queryNews(env, { page, limit, category, hours, perSourceLimit }) {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  let sql = "SELECT * FROM news WHERE published_at >= ?";
  const args = [since];
  if (category) {
    sql += " AND category = ?";
    args.push(category);
  }
  sql += " ORDER BY published_at DESC LIMIT 1000";
  const result = await env.DB.prepare(sql).bind(...args).all();

  let items = result.results || [];
  // 每来源最多取 perSourceLimit 条（保持全局时间倒序）
  if (perSourceLimit > 0) {
    const seen = {};
    items = items.filter((it) => {
      const c = seen[it.source] || 0;
      if (c >= perSourceLimit) return false;
      seen[it.source] = c + 1;
      return true;
    });
  }
  const total = items.length;
  const offset = (page - 1) * limit;
  return { items: items.slice(offset, offset + limit), total };
}

// 批量插入（url 唯一，冲突忽略），返回新增数
async function insertBatch(env, items) {
  let inserted = 0;
  for (const it of items) {
    if (!it.title || !it.url) continue;
    let publishedAt = it.published_at;
    const t = Date.parse(publishedAt);
    if (isNaN(t)) publishedAt = new Date().toISOString();
    else publishedAt = new Date(t).toISOString();
    try {
      const r = await env.DB.prepare(
        "INSERT OR IGNORE INTO news (title, url, source, category, summary, content, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        it.title.slice(0, 2000),
        it.url,
        (it.source || "").slice(0, 200),
        (it.category || "").slice(0, 100),
        (it.summary || "").slice(0, 4000),
        (it.content || "").slice(0, 20000),
        publishedAt
      ).run();
      if (r.meta && r.meta.changes > 0) inserted++;
    } catch (e) {
      // 单条失败不中断整批
    }
  }
  return inserted;
}

// ---------- MCP 处理 ----------
async function handleMcp(request, env) {
  if (!hasBearer(request, env.READ_TOKEN)) {
    return json({ error: "Unauthorized" }, 401);
  }
  if (request.method === "GET") {
    // 带正确密钥但使用 GET 时返回 405（不是网页）
    return json({ error: "Method Not Allowed, use POST" }, 405);
  }
  if (request.method !== "POST") {
    return json({ error: "Method Not Allowed" }, 405);
  }
  let req;
  try {
    req = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON" }, 400);
  }
  const id = req.id !== undefined ? req.id : null;
  const method = req.method || "";
  const params = req.params || {};

  if (method === "initialize") {
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "ai-news", version: "1.0.0" },
      },
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return new Response(null, { status: 202, headers: { ...CORS } });
  }
  if (method === "ping") {
    return json({ jsonrpc: "2.0", id, result: {} });
  }
  if (method === "tools/list") {
    return json({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "get_news",
            description:
              "读取 AI 科技资讯列表。支持按分类、最近小时数、每来源条数、分页筛选；返回每条资讯的标题、来源、分类、发布时间、链接与摘要。",
            inputSchema: {
              type: "object",
              properties: {
                category: {
                  type: "string",
                  description:
                    "资讯分类：social / official_ai / engineering / research / releases / media / community，不传则返回全部。",
                },
                hours: { type: "number", description: "只看最近 N 小时，默认 24", default: 24 },
                limit: { type: "number", description: "返回条数上限，默认 20，最大 100", default: 20 },
                per_source_limit: {
                  type: "number",
                  description: "每个来源最多返回几条，默认 0 表示不限制",
                  default: 0,
                },
              },
            },
          },
          {
            name: "get_collection_status",
            description:
              "查看最近一次采集运行的状态：最后成功采集时间、是否过期（stale）、各来源成功/失败情况、新增条数。",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
  }
  if (method === "tools/call") {
    const name = params.name || "";
    const args = params.arguments || {};
    try {
      if (name === "get_news") {
        const page = Math.max(1, parseInt(args.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(args.limit) || 20));
        const hours = Math.max(1, parseInt(args.hours) || 24);
        const perSourceLimit = Math.max(0, parseInt(args.per_source_limit) || 0);
        const category = typeof args.category === "string" && args.category ? args.category : null;
        const { items, total } = await queryNews(env, { page, limit, category, hours, perSourceLimit });
        const out = {
          count: items.length,
          total,
          category: category || "all",
          hours,
          note:
            category === "social"
              ? "social 类内容来自 AINews 等二手摘要转述，标题/摘要时间与链接属于摘要本身，并非 X/Reddit 原帖；Telegram/Discord 未接入。"
              : undefined,
          items: items.map((it) => ({
            title: it.title,
            source: it.source,
            category: it.category,
            published_at: it.published_at,
            url: it.url,
            summary: it.summary || "",
          })),
        };
        return json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] },
        });
      }
      if (name === "get_collection_status") {
        const log = await env.DB.prepare("SELECT * FROM collection_log ORDER BY id DESC LIMIT 1").first();
        let details = {};
        try {
          details = log && log.details ? JSON.parse(log.details) : {};
        } catch (e) {}
        const lastMs = log ? logTsToMs(log.run_at) : NaN;
        const stale = !log || isNaN(lastMs) || Date.now() - lastMs > 26 * 3600 * 1000;
        const out = {
          last_run_at: log ? log.run_at : null,
          stale,
          status: log ? log.status : "never",
          sources_total: log ? log.sources_total : 0,
          sources_ok: log ? log.sources_ok : 0,
          sources_failed: log ? log.sources_failed : 0,
          items_added: log ? log.items_added : 0,
          failed_sources: details.failed_sources || [],
          per_source: details.per_source || {},
        };
        return json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] },
        });
      }
      return json(
        { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } },
        200
      );
    } catch (e) {
      return json(
        { jsonrpc: "2.0", id, error: { code: -32603, message: String(e && e.message ? e.message : e) } },
        200
      );
    }
  }
  return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } }, 200);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // 健康检查（无鉴权）
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "workbuddy-ai-news", time: new Date().toISOString() });
    }

    // MCP 端点
    if (url.pathname === "/mcp") {
      return handleMcp(request, env);
    }

    // 读取新闻列表
    if (url.pathname === "/api/news" && request.method === "GET") {
      if (!hasBearer(request, env.READ_TOKEN)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const page = Math.max(1, parseInt(url.searchParams.get("page") || "1") || 1);
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "20") || 20));
      const hours = Math.max(1, parseInt(url.searchParams.get("hours") || "24") || 24);
      const perSourceLimit = Math.max(0, parseInt(url.searchParams.get("per_source_limit") || "0") || 0);
      const category = url.searchParams.get("category") || null;
      const { items, total } = await queryNews(env, { page, limit, category, hours, perSourceLimit });
      return json({ data: items, page, limit, total });
    }

    // 单条新闻
    if (url.pathname.startsWith("/api/news/") && request.method === "GET") {
      if (!hasBearer(request, env.READ_TOKEN)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const id = url.pathname.split("/")[3];
      if (!/^\d+$/.test(id || "")) {
        return json({ error: "Not found" }, 404);
      }
      const item = await env.DB.prepare("SELECT * FROM news WHERE id = ?").bind(id).first();
      if (!item) return json({ error: "Not found" }, 404);
      return json(item);
    }

    // 写入单条
    if (url.pathname === "/api/news" && request.method === "POST") {
      if (!hasBearer(request, env.INGEST_TOKEN)) {
        return json({ error: "Unauthorized" }, 401);
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "Invalid JSON" }, 400);
      }
      const inserted = await insertBatch(env, [body]);
      if (inserted === 0 && (!body.title || !body.url)) {
        return json({ error: "title and url are required" }, 400);
      }
      return json({ success: true, inserted });
    }

    // 批量写入
    if (url.pathname === "/api/news/batch" && request.method === "POST") {
      if (!hasBearer(request, env.INGEST_TOKEN)) {
        return json({ error: "Unauthorized" }, 401);
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "Invalid JSON" }, 400);
      }
      const items = Array.isArray(body) ? body : body.items;
      if (!Array.isArray(items) || items.length === 0) {
        return json({ error: "items array required" }, 400);
      }
      const inserted = await insertBatch(env, items.slice(0, 500));
      return json({ success: true, received: items.length, inserted });
    }

    // 采集日志回写
    if (url.pathname === "/api/collection/log" && request.method === "POST") {
      if (!hasBearer(request, env.INGEST_TOKEN)) {
        return json({ error: "Unauthorized" }, 401);
      }
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "Invalid JSON" }, 400);
      }
      await env.DB.prepare(
        "INSERT INTO collection_log (status, sources_total, sources_ok, sources_failed, items_added, details) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(
        String(body.status || "unknown").slice(0, 50),
        parseInt(body.sources_total) || 0,
        parseInt(body.sources_ok) || 0,
        parseInt(body.sources_failed) || 0,
        parseInt(body.items_added) || 0,
        JSON.stringify(body.details || {}).slice(0, 50000)
      ).run();
      return json({ success: true });
    }

    // 采集状态（供 MCP 之外的 HTTP 读取）
    if (url.pathname === "/api/collection/status" && request.method === "GET") {
      if (!hasBearer(request, env.READ_TOKEN)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const log = await env.DB.prepare("SELECT * FROM collection_log ORDER BY id DESC LIMIT 1").first();
      let details = {};
      try {
        details = log && log.details ? JSON.parse(log.details) : {};
      } catch (e) {}
      const lastMs = log ? logTsToMs(log.run_at) : NaN;
      const stale = !log || isNaN(lastMs) || Date.now() - lastMs > 26 * 3600 * 1000;
      return json({
        last_run_at: log ? log.run_at : null,
        stale,
        status: log ? log.status : "never",
        sources_total: log ? log.sources_total : 0,
        sources_ok: log ? log.sources_ok : 0,
        sources_failed: log ? log.sources_failed : 0,
        items_added: log ? log.items_added : 0,
        failed_sources: details.failed_sources || [],
        per_source: details.per_source || {},
      });
    }

    return json({ error: "Not found" }, 404);
  },
};
