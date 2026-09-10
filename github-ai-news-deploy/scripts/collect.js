#!/usr/bin/env node
// AI News 多源采集脚本（零第三方依赖，Node >= 18 原生 fetch）
// 用法：
//   API_BASE_URL=https://xxx.workers.dev INGEST_TOKEN=xxx [NEWS_HOURS=24] node scripts/collect.js
// 流程：读取 sources.json -> 逐源抓取解析 -> 过滤最近 N 小时 -> 去重 ->
//       分批写入 Worker /api/news/batch -> 回写采集日志 /api/collection/log
// 输出约定：OK: 来源名: N items   /   WARNING: 来源名: 原因

const fs = require("fs");
const path = require("path");

const API_BASE_URL = (process.env.API_BASE_URL || "").replace(/\/+$/, "");
const INGEST_TOKEN = process.env.INGEST_TOKEN || "";
const NEWS_HOURS = Math.max(1, parseInt(process.env.NEWS_HOURS || "24") || 24);
const CONCURRENCY = Math.max(1, parseInt(process.env.COLLECT_CONCURRENCY || "5") || 5);
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 AI-News-Collector/1.0";

async function httpGet(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json, application/xml, application/rss+xml, text/xml, */*" },
    signal: AbortSignal.timeout(20000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get("content-type") || "").toLowerCase();
  const body = await res.text();
  return { status: res.status, type, body };
}

function decodeHtml(s) {
  return String(s || "")
    .replace(/<![^>]*>/g, "")
    .replace(/<\/(p|div|br|li|h[1-6]|tr)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extract(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? decodeHtml(m[1]) : "";
}

function extractAttrHref(block) {
  const m = block.match(/<link[^>]*href="([^"]+)"/i);
  return m ? m[1].trim() : "";
}

function parseDate(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return isNaN(t) ? null : new Date(t);
}

function parseRss(xml) {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  return items.map((b) => {
    const link = extract(b, "link") || extractAttrHref(b);
    return {
      title: extract(b, "title"),
      url: link,
      published_at: (extract(b, "pubDate") || extract(b, "date") || "").trim(),
      summary: extract(b, "description"),
    };
  });
}

function parseAtom(xml) {
  const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return entries.map((b) => {
    const d = b.match(/<(published|updated)[^>]*>([\s\S]*?)<\/\1>/i);
    return {
      title: extract(b, "title"),
      url: extractAttrHref(b) || extract(b, "id"),
      published_at: d ? d[2].trim() : "",
      summary: extract(b, "summary") || extract(b, "content"),
    };
  });
}

function getByPath(obj, p) {
  return p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function parseJson(body, cfg) {
  const data = JSON.parse(body);
  const arr = cfg.path ? getByPath(data, cfg.path) : data;
  if (!Array.isArray(arr)) throw new Error("json path is not an array");
  return arr.map((it) => ({
    title: it.title || "",
    url: it.url || "",
    published_at: it.created_at || "",
    summary: it.story_text || it.comment_text || it._tags ? "" : "",
  }));
}

function parseReddit(body) {
  const data = JSON.parse(body);
  const children = (data && data.data && data.data.children) || [];
  return children.map((c) => {
    const d = c && c.data ? c.data : {};
    const t = d.created_utc ? new Date(d.created_utc * 1000).toISOString() : "";
    return {
      title: d.title || "",
      url: d.url || (d.permalink ? "https://www.reddit.com" + d.permalink : ""),
      published_at: t,
      summary: d.selftext || "",
    };
  });
}

// 从 HTML 中提取外链列表（用于无 RSS 的聚合站，如经 reader 代理的 AINews）
// 无发布时间字段，main() 中对 html-links 类型以采集时刻作为 published_at 并备注
function parseHtmlLinks(body) {
  const links = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(body))) {
    let href = (m[1] || "").trim();
    const title = decodeHtml(m[2]).replace(/\s+/g, " ").trim();
    if (!href || !title || title.length < 15) continue;
    if (href.startsWith("#") || href.startsWith("/") || href.startsWith("javascript")) continue;
    if (href.startsWith("//")) href = "https:" + href;
    if (!/^https?:/i.test(href)) continue;
    links.push({ title, url: href, published_at: "", summary: "" });
  }
  return links;
}

async function parseGithub(cfg) {
  const out = [];
  const repos = cfg.repos || [];
  let okRepos = 0;
  for (const repo of repos) {
    try {
      const { body } = await httpGet(`https://api.github.com/repos/${repo}/releases/latest`);
      const r = JSON.parse(body);
      if (r && r.tag_name) {
        okRepos++;
        out.push({
          title: `${repo} ${r.tag_name}`,
          url: r.html_url || `https://github.com/${repo}/releases`,
          published_at: r.published_at || r.created_at || "",
          summary: (r.body || "").slice(0, 500),
        });
      }
    } catch (e) {
      // 单个仓库失败不致命
    }
  }
  if (okRepos === 0) throw new Error("all GitHub repos failed (API limit or network)");
  return out;
}

// 抓取单个来源，返回 {ok, items, error}
async function fetchSource(src) {
  if (src.type === "github") {
    try {
      const items = await parseGithub(src);
      return { ok: true, items };
    } catch (e) {
      return { ok: false, items: [], error: e && e.message ? e.message : String(e) };
    }
  }
  const attempts = src.urls || [];
  let lastErr = "no url";
  for (const u of attempts) {
    try {
      const { body } = await httpGet(u);
      let items = [];
      if (src.type === "rss") items = parseRss(body);
      else if (src.type === "atom") items = parseAtom(body);
      else if (src.type === "json") items = parseJson(body, src);
      else if (src.type === "reddit") items = parseReddit(body);
      else if (src.type === "html-links") items = parseHtmlLinks(body);
      else throw new Error(`unknown type ${src.type}`);
      return { ok: true, items };
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
    }
  }
  return { ok: false, items: [], error: lastErr };
}

// 并发池：最多 CONCURRENCY 个抓取任务同时进行
async function mapPool(list, limit, fn) {
  const results = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next++;
      results[i] = await fn(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return results;
}

async function main() {
  if (!API_BASE_URL) {
    console.error("FATAL: env API_BASE_URL is required (e.g. https://workbuddy-ai-news.xxx.workers.dev)");
    process.exit(1);
  }
  if (!INGEST_TOKEN) {
    console.error("FATAL: env INGEST_TOKEN is required");
    process.exit(1);
  }

  const raw = fs.readFileSync(path.join(__dirname, "..", "sources.json"), "utf8");
  const cfg = JSON.parse(raw);
  const sources = cfg.sources || [];
  console.log(`[collect] sources=${sources.length} hours=${NEWS_HOURS} api=${API_BASE_URL}`);

  const sinceMs = Date.now() - NEWS_HOURS * 3600 * 1000;
  const seenUrl = new Set();
  const perSource = {};
  let sourcesOk = 0;
  let sourcesFailed = 0;
  const failedSources = [];
  let totalNew = 0;

  const fetched = await mapPool(sources, CONCURRENCY, (src) => fetchSource(src));

  for (let si = 0; si < sources.length; si++) {
    const src = sources[si];
    const { ok, items, error } = fetched[si];
    if (!ok) {
      sourcesFailed++;
      failedSources.push({ name: src.name, error });
      perSource[src.name] = { status: "failed", error, items: 0 };
      console.log(`WARNING: ${src.name}: ${error}`);
      continue;
    }
    // 过滤时间窗 + 去重
    let fresh = 0;
    const toSend = [];
    for (const it of items) {
      if (!it.title || !it.url) continue;
      let d = parseDate(it.published_at);
      // html-links 类型无发布时间，以采集时刻计（来源备注里说明为聚合站当前列表）
      if (!d && src.type === "html-links") d = new Date();
      if (!d || d.getTime() < sinceMs) continue;
      if (seenUrl.has(it.url)) continue;
      seenUrl.add(it.url);
      toSend.push({
        title: decodeHtml(it.title).slice(0, 2000),
        url: it.url.slice(0, 2000),
        source: src.name,
        category: src.category || "media",
        summary: decodeHtml(it.summary).slice(0, 4000),
        published_at: d.toISOString(),
      });
      fresh++;
    }
    perSource[src.name] = { status: "ok", items: fresh };
    // 分批写入
    let added = 0;
    for (let i = 0; i < toSend.length; i += 50) {
      const chunk = toSend.slice(i, i + 50);
      const res = await fetch(`${API_BASE_URL}/api/news/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${INGEST_TOKEN}`,
        },
        body: JSON.stringify({ items: chunk }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`batch write failed HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      }
      const j = await res.json().catch(() => ({}));
      added += j.inserted || 0;
    }
    totalNew += added;
    sourcesOk++;
    console.log(`OK: ${src.name}: ${added} items`);
    await new Promise((r) => setTimeout(r, 150)); // 轻微限速，避免被源站拒绝
  }

  // 回写采集日志
  const status = sourcesFailed === 0 ? "success" : sourcesOk > 0 ? "partial" : "failed";
  const logRes = await fetch(`${API_BASE_URL}/api/collection/log`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify({
      status,
      sources_total: sources.length,
      sources_ok: sourcesOk,
      sources_failed: sourcesFailed,
      items_added: totalNew,
      details: { failed_sources: failedSources, per_source: perSource },
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!logRes.ok) {
    console.error(`WARNING: collection log write failed HTTP ${logRes.status}`);
  }

  console.log(
    `[collect] done: ok=${sourcesOk} failed=${sourcesFailed} total_new=${totalNew} status=${status}`
  );
  if (sourcesOk === 0) {
    console.error("FATAL: all sources failed, no data collected");
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("FATAL:", e && e.message ? e.message : e);
    process.exit(1);
  });
}

module.exports = { parseRss, parseAtom, parseJson, parseReddit, parseHtmlLinks, parseGithub, decodeHtml, parseDate, httpGet, fetchSource, main };
