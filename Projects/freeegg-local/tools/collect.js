/**
 * tools/collect.js —— 多源数据采集器（零依赖，仅用 Node 内置模块）
 *
 * 源注册表：
 *   - freeegg   : 抓取 freeegg.top 的 eggs/plans/models 三个公开 JSON，按与
 *                 tools/import.js / server.js 完全一致的合并规则导入本地 data/*.json
 *                 （本地自采 source=local、手动编辑 localEdit=true 的条目不被覆盖）。
 *   - candidates: 读取本地候选目录 data/candidates/*.json（每个文件为 egg 对象数组），按 id 与
 *                 现有 eggs.json 比对去重，新条目设置 source='local'、localEdit=false 追加；
 *                 绝不覆盖/删除既有条目。只处理 eggs，不处理 plans/models。
 *                 导入成功的候选文件会移动到 data/candidates/imported/ 避免重复导入。
 *
 * 用法：
 *   node tools/collect.js              # 跑全部源
 *   node tools/collect.js --source freeegg
 *   node tools/collect.js --source candidates
 *
 * 输出与 tools/import.js 一致的合并报告；每次执行都会更新 data/meta.json 的
 * lastImport 与 history（保留最近 20 条），记录每个源的执行结果。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const META_FILE = path.join(DATA, 'meta.json');
const CANDIDATES_DIR = path.join(DATA, 'candidates');
const CANDIDATES_IMPORTED_DIR = path.join(CANDIDATES_DIR, 'imported');

const COLLECTIONS = {
  eggs: { file: 'eggs.json', key: 'eggs', remoteUrl: 'https://freeegg.top/data/eggs.json' },
  plans: { file: 'plans.json', key: 'vendors', remoteUrl: 'https://freeegg.top/data/plans.json' },
  models: { file: 'models.json', key: 'models', remoteUrl: 'https://freeegg.top/data/models.json' },
};

const FETCH_TIMEOUT = 30000;

// ---------------------------------------------------------------------------
// 通用读写（UTF-8，原子写入）
// ---------------------------------------------------------------------------
function readJson(file, fallback) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' ? obj : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(file + '.tmp', file);
}

function readCollection(name) {
  const def = COLLECTIONS[name];
  return readJson(path.join(DATA, def.file), { version: '', [def.key]: [] });
}

function saveCollection(name, data) {
  writeJsonAtomic(path.join(DATA, COLLECTIONS[name].file), data);
}

// ---------------------------------------------------------------------------
// 规范化（与 server.js 的 normalizeEgg 保持一致，保证 eggs.json 数据模型统一）
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
    id: str(raw.id, 'local-' + Date.now() + '-' + Math.floor(Math.random() * 1e4)),
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

// ---------------------------------------------------------------------------
// freeegg 源：抓取远程三集合并合并（规则与 server.js mergeRemote 完全一致）
// ---------------------------------------------------------------------------
async function fetchRemoteJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'freeegg-local/1.0 (+local personal mirror)' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function mergeRemote(collection, localData, remoteData) {
  const def = COLLECTIONS[collection];
  const remoteItems = Array.isArray(remoteData[def.key]) ? remoteData[def.key].filter(Boolean) : [];
  const localItems = Array.isArray(localData[def.key]) ? localData[def.key].filter(Boolean) : [];

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
    const normalized = Object.assign({}, r, { source: 'freeegg', localEdit: false });
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
    data: { version: String(remoteData.version || ''), [def.key]: out },
    report,
  };
}

/** 执行 freeegg 源，返回 { collections, summary }（结构与 tools/import.js 一致） */
async function runFreeegg() {
  const result = { collections: {}, summary: { added: 0, updated: 0 } };
  for (const [name, def] of Object.entries(COLLECTIONS)) {
    const localData = readCollection(name);
    console.log('  抓取 ' + def.remoteUrl + ' ...');
    const remote = await fetchRemoteJson(def.remoteUrl);
    const merged = mergeRemote(name, localData, remote);
    saveCollection(name, merged.data);
    result.collections[name] = {
      sourceUrl: def.remoteUrl,
      remoteVersion: String(remote.version || ''),
      added: merged.report.added,
      updated: merged.report.updated,
      keptEdited: merged.report.keptEdited,
      keptLocal: merged.report.keptLocal,
      total: merged.data[def.key].length,
    };
    result.summary.added += merged.report.added.length;
    result.summary.updated += merged.report.updated.length;
    console.log(
      '  ✓ ' + name + ': 新增 ' + merged.report.added.length +
        ' / 更新 ' + merged.report.updated.length +
        ' / 保留本地编辑 ' + merged.report.keptEdited.length +
        ' / 保留本地自采 ' + merged.report.keptLocal.length
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// candidates 源：读取 data/candidates/*.json，按 id 去重追加到 eggs.json
// ---------------------------------------------------------------------------
/** 执行 candidates 源，返回 { files, added, skippedExisting, eggsTotal, moved } */
function runCandidates() {
  const report = { files: [], added: [], skippedExisting: [], eggsTotal: 0, moved: [] };
  const processedFiles = new Set();

  if (!fs.existsSync(CANDIDATES_DIR)) {
    console.log('  • candidates 目录不存在，跳过：' + CANDIDATES_DIR);
    return report;
  }

  const files = fs
    .readdirSync(CANDIDATES_DIR)
    .filter((f) => f.toLowerCase().endsWith('.json') && fs.statSync(path.join(CANDIDATES_DIR, f)).isFile())
    .sort();

  if (files.length === 0) {
    console.log('  • candidates 目录下没有待导入的 .json 文件');
    return report;
  }

  const eggsData = readCollection('eggs');
  const key = COLLECTIONS.eggs.key;
  const eggs = Array.isArray(eggsData[key]) ? eggsData[key].filter(Boolean) : [];
  const existingIds = new Set(eggs.map((e) => String(e.id)));

  for (const file of files) {
    const filePath = path.join(CANDIDATES_DIR, file);
    let arr;
    try {
      let text = fs.readFileSync(filePath, 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      arr = JSON.parse(text);
    } catch (e) {
      console.log('  ✗ 跳过（JSON 解析失败）' + file + ': ' + e.message);
      report.files.push({ file, error: 'JSON 解析失败: ' + e.message });
      continue;
    }
    if (!Array.isArray(arr)) {
      console.log('  ✗ 跳过（顶层不是数组）' + file);
      report.files.push({ file, error: '顶层不是 egg 对象数组' });
      continue;
    }

    let fileAdded = 0;
    let fileSkipped = 0;
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object') continue;
      const item = normalizeEgg(raw);
      item.source = 'local';
      item.localEdit = false;
      if (existingIds.has(String(item.id))) {
        fileSkipped++;
        report.skippedExisting.push(String(item.id));
        continue;
      }
      existingIds.add(String(item.id));
      eggs.push(item);
      fileAdded++;
      report.added.push(String(item.id));
    }
    report.files.push({ file, items: arr.length, added: fileAdded, skippedExisting: fileSkipped });
    processedFiles.add(file);
    console.log('  ✓ ' + file + ': 新增 ' + fileAdded + ' / 已存在跳过 ' + fileSkipped);
  }

  eggsData[key] = eggs;
  saveCollection('eggs', eggsData);
  report.eggsTotal = eggs.length;
  console.log('  ✓ eggs.json 当前总数：' + eggs.length);

  fs.mkdirSync(CANDIDATES_IMPORTED_DIR, { recursive: true });
  for (const f of processedFiles) {
    const src = path.join(CANDIDATES_DIR, f);
    const dst = path.join(CANDIDATES_IMPORTED_DIR, f);
    try {
      fs.renameSync(src, dst);
      report.moved.push(f);
    } catch (e) {
      console.log('  ⚠ 移动 ' + f + ' 到 imported/ 失败：' + e.message);
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// 源注册表
// ---------------------------------------------------------------------------
const SOURCES = {
  freeegg: {
    desc: '抓取 freeegg.top 三个公开 JSON 并按合并规则导入',
    run: async () => ({ type: 'freeegg', detail: await runFreeegg() }),
  },
  candidates: {
    desc: '导入 data/candidates/*.json 本地候选蛋（仅 eggs，按 id 去重追加）',
    run: async () => ({ type: 'candidates', detail: runCandidates() }),
  },
};

// ---------------------------------------------------------------------------
// meta.json 记录
// ---------------------------------------------------------------------------
function recordRun(perSource) {
  const meta = readJson(META_FILE, { lastImport: null, history: [] });
  const result = {
    importedAt: new Date().toISOString(),
    sources: {},
  };
  let totalAdded = 0;
  let totalUpdated = 0;
  let collectionsMirror = null;

  for (const [name, out] of Object.entries(perSource)) {
    result.sources[name] = out.detail;
    if (name === 'freeegg') {
      totalAdded += out.detail.summary.added;
      totalUpdated += out.detail.summary.updated;
      collectionsMirror = out.detail.collections;
    } else if (name === 'candidates') {
      totalAdded += out.detail.added.length;
    }
  }

  result.summary = { added: totalAdded, updated: totalUpdated };
  if (collectionsMirror) result.collections = collectionsMirror;

  meta.lastImport = result;
  meta.history = (meta.history || []).concat(result).slice(-20);
  writeJsonAtomic(META_FILE, meta);
  return result;
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { source: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source' || a === '-s') {
      out.source = argv[++i] || null;
    } else if (a.startsWith('--source=')) {
      out.source = a.slice('--source='.length);
    }
  }
  return out;
}

async function main() {
  const { source } = parseArgs(process.argv.slice(2));

  let names;
  if (source) {
    if (!SOURCES[source]) {
      console.error('未知源：' + source);
      console.error('可用源：' + Object.keys(SOURCES).join(', '));
      process.exit(1);
    }
    names = [source];
  } else {
    names = Object.keys(SOURCES);
  }

  console.log('多源数据采集：赛博鸡蛋本地站');
  console.log('源列表：' + names.map((n) => n + '（' + SOURCES[n].desc + '）').join(' ; '));
  console.log('');

  const perSource = {};
  let failed = 0;
  for (const name of names) {
    console.log('── 源 [' + name + '] ──────────────────────────────');
    try {
      const out = await SOURCES[name].run();
      perSource[name] = out;
    } catch (e) {
      failed++;
      console.error('  ✗ 源 ' + name + ' 执行失败：' + e.message);
      perSource[name] = { type: name, detail: { error: String(e && e.message || e) } };
    }
    console.log('');
  }

  recordRun(perSource);

  console.log('──────────────────────────────────────────────');
  for (const [name, out] of Object.entries(perSource)) {
    if (out.type === 'freeegg' && !out.detail.error) {
      console.log('[' + name + '] 新增 ' + out.detail.summary.added + ' / 更新 ' + out.detail.summary.updated);
    } else if (out.type === 'candidates' && !out.detail.error) {
      console.log('[' + name + '] 新增 ' + out.detail.added.length + ' / 已存在跳过 ' + out.detail.skippedExisting.length + ' / eggs 总数 ' + out.detail.eggsTotal);
    } else {
      console.log('[' + name + '] 失败：' + (out.detail.error || '未知错误'));
    }
  }
  console.log('采集完成（' + new Date().toISOString() + '）。');
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('采集失败: ' + (e && e.message || e));
  process.exit(1);
});
