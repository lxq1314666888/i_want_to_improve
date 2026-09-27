/**
 * worker.js —— 赛博鸡蛋 · 云端版（Cloudflare Worker + D1）
 *
 * 与 server.js（本地版）功能对齐，差异：
 *  - 存储：本地文件 data/*.json → D1 kv 表（key: eggs/plans/models/meta，value: 整个集合 JSON 文本）
 *  - 静态资源：public/ 由 Worker Static Assets 托管（env.ASSETS.fetch 兜底）
 *  - 定时采集：scheduled 事件（Cron Trigger），仅采集 freeegg 源（国外信息），
 *    不采集本地候选 candidates（国内/本地录入留在本地版）
 *  - 抓取合并规则与本地版完全一致：本地自采 source=local、手动编辑 localEdit=true 不被覆盖
 *
 * 部署：
 *   1. npx wrangler d1 create workbuddy-freeegg   # 创建 D1，回填 database_id 到 wrangler.toml
 *   2. npx wrangler d1 execute workbuddy-freeegg --command "CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT)"
 *   3. CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account> npx wrangler deploy
 */
'use strict';

// ---------------------------------------------------------------------------
// 数据集合定义
// ---------------------------------------------------------------------------
const COLLECTIONS = {
  eggs: { key: 'eggs', remoteUrl: 'https://freeegg.top/data/eggs.json' },
  plans: { key: 'vendors', remoteUrl: 'https://freeegg.top/data/plans.json' },
  models: { key: 'models', remoteUrl: 'https://freeegg.top/data/models.json' },
};

const FETCH_TIMEOUT = 30000;

// ---------------------------------------------------------------------------
// D1 存取（整个集合 JSON 存一行，key = 集合名 / 'meta'）
// ---------------------------------------------------------------------------
async function dbRead(env, key, fallback) {
  try {
    const row = await env.DB.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first();
    if (!row || !row.value) return fallback;
    const obj = JSON.parse(row.value);
    return obj && typeof obj === 'object' ? obj : fallback;
  } catch {
    return fallback;
  }
}

async function dbWrite(env, key, obj) {
  await env.DB
    .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, JSON.stringify(obj))
    .run();
}

async function readCollection(env, name) {
  const def = COLLECTIONS[name];
  const data = await dbRead(env, name, { version: '', [def.key]: [] });
  const items = Array.isArray(data[def.key]) ? data[def.key].filter(Boolean) : [];
  return { version: data.version || '', items, data };
}

async function saveCollection(env, name, data) {
  await dbWrite(env, name, data);
}

async function readMeta(env) {
  return dbRead(env, 'meta', {
    lastImport: null,
    history: [],
    notes: 'freeegg 云端版数据来源记录：local=云端自采；freeegg=从 freeegg.top 爬取导入',
  });
}

async function writeMeta(env, meta) {
  await dbWrite(env, 'meta', meta);
}

// ---------------------------------------------------------------------------
// 校验与规范化（与本地版 server.js 完全一致）
// ---------------------------------------------------------------------------
function clampScore(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

function str(v, fallback) {
  const s = String(v == null ? '' : v).trim();
  return s === '' ? fallback : s;
}

function normalizeEgg(raw) {
  return {
    id: str(raw.id, 'local-' + Date.now()),
    title: str(raw.title, '未命名的蛋'),
    vendor: str(raw.vendor, '未知厂商'),
    category: ['token', 'credits', 'api-quota', 'other'].includes(raw.category) ? raw.category : 'other',
    score: clampScore(raw.score),
    tags: {
      duration: raw.tags && ['limited', 'longterm'].includes(raw.tags.duration) ? raw.tags.duration : 'unknown',
      region: raw.tags && ['cn', 'global'].includes(raw.tags.region) ? raw.tags.region : 'unknown',
    },
    expired: raw.expired === true,
    expiryDate: raw.expiryDate || null,
    summary: str(raw.summary, ''),
    content: str(raw.content, ''),
    images: Array.isArray(raw.images) ? raw.images.map(String).filter(Boolean) : [],
    link: str(raw.link, ''),
    startsAt: raw.startsAt || null,
    preview: raw.preview === true,
    publishedAt: str(raw.publishedAt, ''),
    updatedAt: str(raw.updatedAt, ''),
  };
}

function normalizeVendor(raw) {
  return {
    id: str(raw.id, 'local-' + Date.now()),
    name: str(raw.name, '未知平台'),
    product: str(raw.product, ''),
    tagline: str(raw.tagline, ''),
    models: Array.isArray(raw.models) ? raw.models.map(String).filter(Boolean) : [],
    quotaBasis: str(raw.quotaBasis, ''),
    status: ['available', 'limited', 'waitlist'].includes(raw.status) ? raw.status : 'available',
    highlights: Array.isArray(raw.highlights) ? raw.highlights.map(String).filter(Boolean) : [],
    entryPrice: str(raw.entryPrice, ''),
    entryPriceCny: Number.isFinite(Number(raw.entryPriceCny)) ? Number(raw.entryPriceCny) : null,
    plans: Array.isArray(raw.plans)
      ? raw.plans
          .filter((p) => p && typeof p === 'object')
          .map((p) => ({
            name: str(p.name, ''),
            price: str(p.price, ''),
            note: str(p.note, ''),
            features: Array.isArray(p.features) ? p.features.map(String).filter(Boolean) : [],
          }))
      : [],
    link: str(raw.link, ''),
    updatedAt: str(raw.updatedAt, ''),
  };
}

function normalizeModel(raw) {
  return {
    id: str(raw.id, 'local-' + Date.now()),
    name: str(raw.name, '未命名模型'),
    vendor: str(raw.vendor, '未知厂商'),
    releasedAt: raw.releasedAt || null,
    inputCost: Number.isFinite(Number(raw.inputCost)) ? Number(raw.inputCost) : null,
    outputCost: Number.isFinite(Number(raw.outputCost)) ? Number(raw.outputCost) : null,
    score: Number.isFinite(Number(raw.score)) ? Number(raw.score) : 0,
  };
}

const NORMALIZERS = { eggs: normalizeEgg, plans: normalizeVendor, models: normalizeModel };

// ---------------------------------------------------------------------------
// 二级抓取：freeegg 源（国外信息）抓取 + 合并（规则与本地版一致）
// ---------------------------------------------------------------------------
async function fetchRemoteJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'workbuddy-freeegg/1.0 (+personal mirror)' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function mergeRemote(collection, localData, remoteData) {
  const key = COLLECTIONS[collection].key;
  const remoteItems = Array.isArray(remoteData[key]) ? remoteData[key].filter(Boolean) : [];
  const localItems = Array.isArray(localData[key]) ? localData[key].filter(Boolean) : [];

  const byId = new Map();
  for (const it of localItems) byId.set(String(it.id), it);

  const report = { added: [], updated: [], keptEdited: [], keptLocal: [], keptUnchanged: [] };
  const out = [];
  const seen = new Set();

  for (const r of remoteItems) {
    const rid = String(r.id || '');
    if (!rid) continue;
    seen.add(rid);
    const existing = byId.get(rid);
    const normalized = NORMALIZERS[collection]({ ...r, source: 'freeegg', localEdit: false });
    normalized.source = 'freeegg';
    normalized.localEdit = false;
    if (!existing) {
      out.push(normalized);
      report.added.push(rid);
      continue;
    }
    if (existing.localEdit === true) {
      out.push(existing);
      report.keptEdited.push(rid);
      continue;
    }
    if (existing.source === 'local') {
      out.push(existing);
      report.keptLocal.push(rid);
      continue;
    }
    out.push(normalized);
    report.updated.push(rid);
  }

  for (const it of localItems) {
    if (!seen.has(String(it.id))) {
      out.push(it);
      report.keptUnchanged.push(it.id);
    }
  }

  return {
    collection,
    report,
    data: { version: String(remoteData.version || ''), [key]: out },
  };
}

// 仅跑 freeegg 源（云端不跑 candidates 本地候选源）
async function runFreeeggImport(env) {
  const meta = await readMeta(env);
  const now = new Date().toISOString();
  const result = { importedAt: now, collections: {}, summary: {} };
  let totalAdded = 0;
  let totalUpdated = 0;

  for (const [name, def] of Object.entries(COLLECTIONS)) {
    const localData = await readCollection(env, name);
    const remote = await fetchRemoteJson(def.remoteUrl);
    const merged = mergeRemote(name, localData.data, remote);
    await saveCollection(env, name, merged.data);
    const rep = merged.report;
    totalAdded += rep.added.length;
    totalUpdated += rep.updated.length;
    result.collections[name] = {
      sourceUrl: def.remoteUrl,
      remoteVersion: String(remote.version || ''),
      added: rep.added,
      updated: rep.updated,
      keptEdited: rep.keptEdited,
      keptLocal: rep.keptLocal,
      total: merged.data[def.key].length,
    };
  }

  result.summary = { added: totalAdded, updated: totalUpdated };
  meta.lastImport = result;
  meta.history = (meta.history || []).concat(result).slice(-20);
  await writeMeta(env, meta);
  return result;
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------
function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function handleApi(request, env, url, seg) {
  const method = request.method;

  // GET /api/meta
  if (seg[1] === 'meta' && method === 'GET') {
    const meta = await readMeta(env);
    const counts = {};
    for (const name of Object.keys(COLLECTIONS)) {
      const { items } = await readCollection(env, name);
      counts[name] = {
        total: items.length,
        local: items.filter((i) => i.source === 'local').length,
        freeegg: items.filter((i) => i.source === 'freeegg').length,
      };
    }
    return json(200, { meta, counts });
  }

  // POST /api/import/freeegg
  if (seg[1] === 'import' && seg[2] === 'freeegg' && method === 'POST') {
    try {
      const result = await runFreeeggImport(env);
      return json(200, { ok: true, result });
    } catch (e) {
      return json(502, { ok: false, error: '抓取失败: ' + e.message });
    }
  }

  // /api/<collection>[/:id]
  const name = seg[1];
  if (!COLLECTIONS[name]) return null;
  const def = COLLECTIONS[name];
  const key = def.key;
  const id = seg[2] ? decodeURIComponent(seg[2]) : null;

  const { items, version, data } = await readCollection(env, name);

  // GET 列表
  if (!id && method === 'GET') {
    return json(200, { version, [key]: items });
  }

  // POST 新增（单个对象或数组）
  if (!id && method === 'POST') {
    const body = await request.json().catch(() => null);
    const arr = Array.isArray(body) ? body : [body];
    if (!arr.length || arr.some((x) => !x || typeof x !== 'object')) {
      return json(400, { error: 'body 必须是对象或对象数组' });
    }
    const created = [];
    for (const raw of arr) {
      const item = NORMALIZERS[name](raw);
      item.source = 'local';
      item.localEdit = false;
      item.createdAt = new Date().toISOString().slice(0, 10);
      items.push(item);
      created.push(item);
    }
    await saveCollection(env, name, { ...data, version, [key]: items });
    return json(201, { created });
  }

  // PUT 更新（自采集；若原为爬取数据，则转为本地覆盖并保护）
  if (id && method === 'PUT') {
    const idx = items.findIndex((i) => String(i.id) === id);
    if (idx < 0) return json(404, { error: 'not found: ' + id });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return json(400, { error: 'body 必须是对象' });
    }
    const merged = { ...items[idx], ...body, id: items[idx].id };
    const item = NORMALIZERS[name](merged);
    item.source = 'local';
    item.localEdit = true;
    item.updatedAt = new Date().toISOString().slice(0, 10);
    items[idx] = item;
    await saveCollection(env, name, { ...data, version, [key]: items });
    return json(200, { updated: item });
  }

  // DELETE
  if (id && method === 'DELETE') {
    const idx = items.findIndex((i) => String(i.id) === id);
    if (idx < 0) return json(404, { error: 'not found: ' + id });
    const removed = items.splice(idx, 1)[0];
    await saveCollection(env, name, { ...data, version, [key]: items });
    return json(200, { deleted: removed.id });
  }

  return json(405, { error: 'method not allowed' });
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const seg = url.pathname.split('/').filter(Boolean);
    if (seg[0] === 'api') {
      const handled = await handleApi(request, env, url, seg);
      if (handled) return handled;
    }
    // 非 API 请求 → 静态资源（public/）
    return env.ASSETS.fetch(request);
  },

  // 定时采集（仅 freeegg 国外源）：每 6 小时
  async scheduled(event, env) {
    try {
      const result = await runFreeeggImport(env);
      console.log('⏰ 定时采集完成 @ ' + new Date().toISOString() + ' 新增 ' + result.summary.added + ' / 更新 ' + result.summary.updated);
    } catch (e) {
      console.error('⚠ 定时采集失败: ' + ((e && e.message) || e));
    }
  },
};
