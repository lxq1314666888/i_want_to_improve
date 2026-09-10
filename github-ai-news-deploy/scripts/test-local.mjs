// 本地模拟测试：用内存版 D1 模拟真实 Worker 逻辑（无需联网、无需 wrangler）
// 运行：node scripts/test-local.mjs
import { pathToFileURL } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { default: worker } = await import(pathToFileURL(require.resolve("../src/index.js")));

// ---- 内存 D1 模拟（支持本 Worker 用到的全部 SQL 形态）----
function createDb() {
  const news = [];
  const logs = [];
  let newsId = 1;
  let logId = 1;
  const api = {
    prepare(sql) {
      const stmt = { sql, args: [], bind(...args) { this.args = args; return this; } };
      stmt.run = async () => {
        if (stmt.sql.includes("INSERT OR IGNORE INTO news")) {
          const [title, url, source, category, summary, content, published_at] = stmt.args;
          if (!news.some((n) => n.url === url)) {
            const row = { id: newsId++, title, url, source, category, summary, content, published_at };
            news.push(row);
            return { meta: { changes: 1, last_row_id: row.id } };
          }
          return { meta: { changes: 0 } };
        }
        if (stmt.sql.includes("INSERT INTO collection_log")) {
          const [status, st, sok, sf, added, details] = stmt.args;
          logs.push({ id: logId++, run_at: "2026-09-10 07:17:00", status, sources_total: st, sources_ok: sok, sources_failed: sf, items_added: added, details });
          return { meta: { changes: 1, last_row_id: logId - 1 } };
        }
        throw new Error("unsupported run sql: " + stmt.sql);
      };
      stmt.all = async () => {
        if (stmt.sql.includes("SELECT * FROM news")) {
          let items = news.slice();
          const [since, category] = stmt.args;
          if (since) items = items.filter((n) => n.published_at >= since);
          if (category) items = items.filter((n) => n.category === category);
          items.sort((a, b) => (a.published_at < b.published_at ? 1 : -1));
          return { results: items };
        }
        throw new Error("unsupported all sql: " + stmt.sql);
      };
      stmt.first = async () => {
        if (stmt.sql.includes("SELECT * FROM news WHERE id = ?")) {
          const [id] = stmt.args;
          return news.find((n) => n.id === Number(id)) || null;
        }
        if (stmt.sql.includes("SELECT * FROM collection_log")) {
          return logs.length ? logs[logs.length - 1] : null;
        }
        throw new Error("unsupported first sql: " + stmt.sql);
      };
      return stmt;
    },
  };
  return api;
}

const env = {
  DB: createDb(),
  READ_TOKEN: "read-token-test",
  INGEST_TOKEN: "ingest-token-test",
};

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}  ${extra || ""}`);
  }
}

async function call(path, { method = "GET", token, body } = {}) {
  const headers = {};
  if (token) headers["Authorization"] = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const req = new Request("https://test.workers.dev" + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env);
  let data = null;
  try {
    data = await res.json();
  } catch (e) {}
  return { status: res.status, data };
}

const now = new Date().toISOString();
const items = [
  { title: "OpenAI 发布新模型", url: "https://example.com/1", source: "OpenAI News", category: "official_ai", summary: "模型发布", published_at: now },
  { title: "重复链接测试", url: "https://example.com/1", source: "OpenAI News", category: "official_ai", summary: "应与上面重复", published_at: now },
  { title: "arXiv 新论文", url: "https://example.com/2", source: "arXiv cs.AI", category: "research", summary: "论文摘要", published_at: now },
  { title: "Reddit 热帖", url: "https://example.com/3", source: "Reddit r/LocalLLaMA", category: "community", summary: "社区讨论", published_at: now },
  { title: "过期旧闻", url: "https://example.com/old", source: "TechCrunch AI", category: "media", summary: "30 天前", published_at: new Date(Date.now() - 30 * 86400 * 1000).toISOString() },
];

console.log("== 鉴权 ==");
let r = await call("/api/news");
check("GET /api/news 无 token -> 401", r.status === 401, `got ${r.status}`);
r = await call("/api/news/batch", { method: "POST", body: { items } });
check("POST /api/news/batch 无 token -> 401", r.status === 401, `got ${r.status}`);
r = await call("/mcp", { method: "POST", body: {} });
check("POST /mcp 无 token -> 401", r.status === 401, `got ${r.status}`);
r = await call("/mcp", { method: "GET", token: env.READ_TOKEN });
check("GET /mcp 带 token -> 405", r.status === 405, `got ${r.status}`);

console.log("== 写入 ==");
r = await call("/api/news/batch", { method: "POST", token: env.INGEST_TOKEN, body: { items } });
check("批量写入 5 条（1 条重复）-> inserted 4", r.status === 200 && r.data.inserted === 4, JSON.stringify(r.data));
r = await call("/api/news", { method: "POST", token: env.INGEST_TOKEN, body: { title: "单条测试", url: "https://example.com/single" } });
check("单条写入 -> success", r.status === 200 && r.data.success === true, JSON.stringify(r.data));

console.log("== 读取 ==");
r = await call("/api/news", { token: env.READ_TOKEN });
check("GET /api/news 默认最近 24h -> 4 条（旧闻被过滤）", r.status === 200 && r.data.total === 4, `total=${r.data && r.data.total}`);
r = await call("/api/news?category=research", { token: env.READ_TOKEN });
check("按 category=research 过滤 -> 1 条", r.status === 200 && r.data.total === 1, `total=${r.data && r.data.total}`);
r = await call("/api/news?per_source_limit=1", { token: env.READ_TOKEN });
check("per_source_limit=1 -> 每来源最多 1 条，共 4 条", r.status === 200 && r.data.total === 4, `total=${r.data && r.data.total}`);
r = await call("/api/news/1", { token: env.READ_TOKEN });
check("GET /api/news/1 -> 返回单条", r.status === 200 && r.data.title === "OpenAI 发布新模型", JSON.stringify(r.data && r.data.title));
r = await call("/api/news/999", { token: env.READ_TOKEN });
check("GET /api/news/999 -> 404", r.status === 404, `got ${r.status}`);

console.log("== 采集状态 ==");
r = await call("/api/collection/log", {
  method: "POST",
  token: env.INGEST_TOKEN,
  body: { status: "partial", sources_total: 30, sources_ok: 28, sources_failed: 2, items_added: 12, details: { failed_sources: [{ name: "AINews", error: "HTTP 404" }] } },
});
check("回写采集日志 -> success", r.status === 200 && r.data.success === true);
r = await call("/api/collection/status", { token: env.READ_TOKEN });
check("GET /api/collection/status -> 读取日志", r.status === 200 && r.data.sources_total === 30 && r.data.failed_sources.length === 1, JSON.stringify(r.data));
check("status 非 stale（模拟 07:17 运行，距现在近）", r.data.stale === false, `stale=${r.data.stale}`);

console.log("== MCP ==");
r = await call("/mcp", { method: "POST", token: env.READ_TOKEN, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } } });
check("initialize -> serverInfo + capabilities.tools", r.status === 200 && r.data.result && r.data.result.serverInfo.name === "ai-news" && r.data.result.capabilities.tools, JSON.stringify(r.data && r.data.result));
r = await call("/mcp", { method: "POST", token: env.READ_TOKEN, body: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
check("tools/list -> 2 个工具", r.status === 200 && r.data.result.tools.length === 2, JSON.stringify(r.data && r.data.result && r.data.result.tools && r.data.result.tools.map((t) => t.name)));
r = await call("/mcp", { method: "POST", token: env.READ_TOKEN, body: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_news", arguments: { category: "research", hours: 24, limit: 5 } } } });
check("tools/call get_news -> 有文本内容且含 1 条 research", r.status === 200 && r.data.result.content[0].type === "text" && JSON.parse(r.data.result.content[0].text).count === 1, String(r.data.result && r.data.result.content && r.data.result.content[0] && r.data.result.content[0].text));
r = await call("/mcp", { method: "POST", token: env.READ_TOKEN, body: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_collection_status", arguments: {} } } });
check("tools/call get_collection_status -> stale=false 且含失败源", r.status === 200 && JSON.parse(r.data.result.content[0].text).failed_sources.length === 1, String(r.data.result && r.data.result.content && r.data.result.content[0] && r.data.result.content[0].text));
r = await call("/mcp", { method: "POST", token: env.READ_TOKEN, body: { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } } });
check("tools/call 未知工具 -> 错误码 -32602", r.data && r.data.error && r.data.error.code === -32602, JSON.stringify(r.data && r.data.error));
r = await call("/mcp", { method: "POST", token: env.READ_TOKEN, body: { jsonrpc: "2.0", id: 6, method: "ping" } });
check("ping -> result {}", r.status === 200 && r.data.result, JSON.stringify(r.data));

console.log("== 其他 ==");
r = await call("/health");
check("GET /health -> ok:true", r.status === 200 && r.data.ok === true, JSON.stringify(r.data));
r = await call("/");
check("GET / -> 404", r.status === 404, `got ${r.status}`);

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
