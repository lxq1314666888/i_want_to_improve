/**
 * tools/refine.js —— 取数加工层（零依赖，Node 内置模块）
 *
 * 输入：云端 D1 拉取的集合 JSON（支持两种形态，自动探测）：
 *   1. Cloudflare D1 API 包装：{ result: [{ results: [{ value: "<集合JSON文本>" }] }] }
 *   2. 裸集合 JSON：{ version, eggs: [...] } 或 { version, vendors: [...] } / { version, models: [...] }
 *
 * 输出：data/refined.md —— 按"公众号副业选题"视角加工后的中文清单：
 *   - 过滤掉已过期条目（expired=true 或 expiryDate < now）
 *   - 按评分 score 降序，同分按发布时间新者优先
 *   - 分组统计（类别 / 时效 / 国内外）
 *   - 每条约 1 行：标题 | 厂商 | 类别 | 评分 | 时效 | 截止 | 摘要 | 链接
 *
 * 用法：
 *   node tools/refine.js                    # 读 data/eggs.cloud.json（默认）并输出 refined.md
 *   node tools/refine.js --file data/eggs.json
 *   node tools/refine.js --file data/eggs.cloud.json --out data/refined.md
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_IN = path.join(ROOT, 'data', 'eggs.cloud.json');
const DEFAULT_OUT = path.join(ROOT, 'data', 'refined.md');

// ---------------------------------------------------------------------------
// 解析：自动探测输入形态
// ---------------------------------------------------------------------------
function readCollection(file) {
  let raw = fs.readFileSync(file, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let parsed = JSON.parse(raw);

  // 形态 1：Cloudflare D1 API 包装
  if (parsed && Array.isArray(parsed.result)) {
    const first = parsed.result[0];
    if (first && Array.isArray(first.results) && first.results[0] && typeof first.results[0].value === 'string') {
      parsed = JSON.parse(first.results[0].value);
    }
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('无法识别集合结构: ' + file);

  // 找出条目数组：eggs / vendors / models
  const key = ['eggs', 'vendors', 'models'].find((k) => Array.isArray(parsed[k]));
  if (!key) throw new Error('未找到条目数组 (eggs/vendors/models): ' + file);
  return { key, version: parsed.version || '', items: parsed[key].filter(Boolean) };
}

// ---------------------------------------------------------------------------
// 时效计算
// ---------------------------------------------------------------------------
function isExpired(egg, now) {
  if (egg.expired === true) return true;
  if (egg.expiryDate) {
    const d = new Date(egg.expiryDate);
    if (!isNaN(d) && d.getTime() < now.getTime()) return true;
  }
  return false;
}

function daysLeft(egg, now) {
  if (!egg.expiryDate) return null;
  const d = new Date(egg.expiryDate);
  if (isNaN(d)) return null;
  const diff = Math.ceil((d.getTime() - now.getTime()) / 86400000);
  return diff < 0 ? 0 : diff;
}

function fmtDate(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : String(s).slice(0, 10);
}

// ---------------------------------------------------------------------------
// 类别中文名与副业视角说明
// ---------------------------------------------------------------------------
const CAT = {
  token: 'Token 额度',
  credits: '积分/点数',
  'api-quota': 'API 免费档',
  other: '其他',
};

const CAT_ANGLE = {
  token: '直接顶钱用：做内容/开发工具的算力成本归零',
  credits: '每天签到攒积分 ≈ 每天白得几十块额度，适合"羊毛日报"选题',
  'api-quota': '注册即得 Key：适合接 API、做小工具、聚合网关类副业',
  other: '待人工判断',
};

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { file: DEFAULT_IN, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file' || a === '-f') out.file = argv[++i] || out.file;
    else if (a.startsWith('--file=')) out.file = a.slice(7);
    else if (a === '--out' || a === '-o') out.out = argv[++i] || out.out;
    else if (a.startsWith('--out=')) out.out = a.slice(6);
  }
  return out;
}

function main() {
  const { file, out } = parseArgs(process.argv.slice(2));
  const now = new Date();

  const { key, version, items } = readCollection(file);
  const active = items.filter((e) => !isExpired(e, now));
  const expired = items.filter((e) => isExpired(e, now));

  // 排序：评分降序 → 发布时间新者优先
  const byScore = [...active].sort((a, b) => {
    const sa = Number(a.score) || 0;
    const sb = Number(b.score) || 0;
    if (sb !== sa) return sb - sa;
    return String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''));
  });

  const lines = [];
  lines.push('# 赛博鸡蛋 · 云端采集加工清单');
  lines.push('');
  lines.push(`- 数据源：freeegg.top（${version || '未知版本'}），云端 Worker 定时采集`);
  lines.push(`- 生成时间：${now.toISOString()}`);
  lines.push(`- 集合：${key} · 共 ${items.length} 条 · 未过期 ${active.length} 条 · 已过期 ${expired.length} 条`);
  lines.push('');

  // 分组统计
  const catStat = {};
  const regionStat = {};
  for (const e of active) {
    const c = CAT[e.category] || '其他';
    catStat[c] = (catStat[c] || 0) + 1;
    const r = e.tags && e.tags.region === 'global' ? '国外' : '国内';
    regionStat[r] = (regionStat[r] || 0) + 1;
  }
  lines.push('## 一、概览');
  lines.push('');
  lines.push('| 类别 | 条数 | 副业视角 |');
  lines.push('| --- | --- | --- |');
  for (const c of Object.keys(CAT)) {
    const n = catStat[CAT[c]] || 0;
    if (n > 0) lines.push(`| ${CAT[c]} | ${n} | ${CAT_ANGLE[c]} |`);
  }
  lines.push('');
  lines.push(`- 地域分布：${Object.entries(regionStat).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
  lines.push('');

  // 未过期清单
  lines.push('## 二、可薅清单（按评分排序）');
  lines.push('');
  lines.push('| # | 标题 | 厂商 | 类别 | 评分 | 时效 | 剩余天数 | 摘要 | 链接 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  byScore.slice(0, 40).forEach((e, i) => {
    const dl = daysLeft(e, now);
    const dur = e.tags && e.tags.duration === 'longterm' ? '长期' : '限时';
    lines.push(
      `| ${i + 1} | ${e.title || ''} | ${e.vendor || ''} | ${CAT[e.category] || '其他'} | ${e.score ?? 0} | ${dur} | ${dl === null ? '-' : dl + ' 天'} | ${(e.summary || '').slice(0, 60)} | ${e.link || ''} |`
    );
  });
  lines.push('');

  // 已过期（只列标题，供追溯）
  lines.push('## 三、已过期（供选题复盘参考）');
  lines.push('');
  lines.push(`共 ${expired.length} 条：` + expired.map((e) => e.title || e.id).join('、'));
  lines.push('');

  fs.writeFileSync(out, lines.join('\n'), 'utf8');
  console.log('已生成：' + out);
  console.log(`共 ${items.length} 条，未过期 ${active.length}，已过期 ${expired.length}`);
}

main();
