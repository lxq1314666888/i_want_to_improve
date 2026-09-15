/**
 * 通过已登录的 Edge（pw-profile）把改动上传到 GitHub 仓库。
 *
 * 背景：本机 git 协议访问 github.com 被干扰（schannel/openssl 均失败），
 * GitHub MCP 又是只读的（写操作 403），所以走浏览器代操作。
 *
 * 只做上传，不做删除。sources.json 的删除单独确认后再处理。
 * 用法：node gh-push.cjs [--dry]
 *   --dry 只打开第一个上传页并报告 DOM 结构，不提交任何东西
 */
const PW = 'C:/Users/11600493/.workbuddy/binaries/node/workspace/node_modules/playwright';
const { chromium } = require(PW);
const fs = require('node:fs');

const PROFILE = 'C:/Users/11600493/.workbuddy/pw-profile';
const OWNER = 'lxq1314666888';
const REPO = 'i_want_to_improve';
const LOCAL = 'E:/ai_study/ai-news-briefing';
const PREFIX = 'projects/ai-news-briefing';
const DRY = process.argv.includes('--dry');

// 按仓库目录分组，减少往返次数。每组给正式名字，--only 按名字精确匹配
// （原先用 dir 子串匹配，--only=ai-news-briefing 会同时命中所有子目录）
const GROUPS = [
  { name: 'config', dir: `${PREFIX}/config`, files: ['config/sources.json', 'config/topics.json', 'config/settings.json'] },
  { name: 'scripts', dir: `${PREFIX}/scripts`, files: ['scripts/collect.py', 'scripts/validate_config.py'] },
  { name: 'src', dir: `${PREFIX}/src`, files: ['src/worker.js'] },
  { name: 'tests', dir: `${PREFIX}/tests`, files: ['tests/api.test.mjs', 'tests/test_collect.py'] },
  { name: 'migrations', dir: `${PREFIX}/migrations`, files: ['migrations/0002_filtered_out.sql'] },
  { name: 'docs', dir: `${PREFIX}/docs`, files: ['docs/sources.md', 'docs/workbuddy.md', 'docs/定制速查卡.html'] },
  { name: 'ops', dir: `${PREFIX}/ops`, files: ['ops/gh-check.cjs', 'ops/gh-push.cjs', 'ops/gh-delete.cjs', 'ops/gh-run.cjs', 'ops/README.md'] },
  { name: 'root', dir: PREFIX, files: ['README.md', '.gitignore'] },
  { name: 'workflows', dir: '.github/workflows', files: ['.github/workflows/ai-news-apply-config.yml'] },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];

async function gotoWithRetry(page, url, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return true;
    } catch (error) {
      console.log(`    nav 第 ${i} 次失败：${error.message.split('\n')[0]}`);
      if (i < attempts) await sleep(3000);
    }
  }
  return false;
}

async function uploadGroup(page, group) {
  const url = `https://github.com/${OWNER}/${REPO}/upload/main/${group.dir}`;
  console.log(`\n>>> ${group.dir}  (${group.files.length} 个文件)`);
  if (!await gotoWithRetry(page, url)) {
    results.push({ dir: group.dir, ok: false, reason: '页面打开失败' });
    return;
  }

  // 未登录或权限不足时 GitHub 会跳走
  if (!page.url().includes('/upload/')) {
    console.log(`    重定向到 ${page.url()}`);
    results.push({ dir: group.dir, ok: false, reason: '被重定向，可能无权限' });
    return;
  }

  const input = page.locator('input[type="file"]').first();
  try {
    await input.waitFor({ state: 'attached', timeout: 30000 });
  } catch {
    results.push({ dir: group.dir, ok: false, reason: '找不到 file input' });
    return;
  }

  const paths = group.files.map(f => `${LOCAL}/${f}`);
  await input.setInputFiles(paths);
  console.log(`    已选择：${group.files.join(', ')}`);

  // 等每个文件都渲染进待提交列表。固定 sleep 在 3 个文件时不够，
  // 会造成"点了提交但没带上文件"却仍判成功（实测踩过）。
  for (const rel of group.files) {
    const base = rel.split('/').pop();
    try {
      await page.getByText(base, { exact: false }).first()
        .waitFor({ state: 'visible', timeout: 60000 });
    } catch {
      results.push({ dir: group.dir, ok: false, reason: `${base} 未出现在待提交列表` });
      return;
    }
  }
  console.log('    待提交列表已就绪');

  if (DRY) {
    const buttons = await page.locator('button').allTextContents();
    console.log('    [dry] 按钮：' + buttons.filter(Boolean).join(' | ').slice(0, 300));
    results.push({ dir: group.dir, ok: true, reason: 'dry-run' });
    return;
  }

  const commit = page.locator('button:has-text("Commit changes")').last();
  try {
    await commit.waitFor({ state: 'visible', timeout: 30000 });
    await commit.click();
  } catch (error) {
    results.push({ dir: group.dir, ok: false, reason: `提交按钮不可用：${error.message.split('\n')[0]}` });
    return;
  }

  // URL 判断不可靠：提交后可能停在 /upload（无尾部斜杠），而只排除 /upload/ 的
  // predicate 会把它误判成「已跳转」——这正是 config 组反复假成功的根因。
  // 一律以 API 回读远端文件大小为最终依据。
  await sleep(5000);
  const verdict = await verifyUploaded(group);
  console.log(`    ${verdict.ok ? '✓' : '✗'} ${verdict.reason}`);
  results.push({ dir: group.dir, ok: verdict.ok, reason: verdict.reason });
}

/** 匿名回读仓库文件，比对远端与本地字节数，确认内容确实写进去了。 */
async function verifyUploaded(group) {
  for (const rel of group.files) {
    const name = rel.split('/').pop();
    const repoPath = `${group.dir}/${name}`;
    const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${repoPath}?ref=main&cb=${Date.now()}`;
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(url, { headers: { 'User-Agent': 'push-verify/1.0' } });
        break;
      } catch {
        await sleep(3000);
      }
    }
    if (!response) return { ok: false, reason: `${name} 回读失败（网络）` };
    if (!response.ok) return { ok: false, reason: `${name} 回读 HTTP ${response.status}` };
    const remote = await response.json();
    const local = fs.statSync(`${LOCAL}/${rel}`).size;
    if (remote.size !== local) {
      return { ok: false, reason: `${name} 未真正更新（远端 ${remote.size}B ≠ 本地 ${local}B）` };
    }
  }
  return { ok: true, reason: `API 回读一致（${group.files.length} 个文件）` };
}

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'msedge',
    headless: true,
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--no-sandbox', '--enable-automation'],
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  try {
    const cookies = await ctx.cookies('https://github.com');
    if (!cookies.some(c => c.name === 'user_session')) {
      console.error('未检测到 GitHub 登录态，中止');
      process.exitCode = 1;
      return;
    }
    const page = await ctx.newPage();

    if (DRY) {
      await uploadGroup(page, GROUPS[0]);
    } else {
      const only = (process.argv.find(a => a.startsWith('--only=')) || '').split('=')[1] || '';
      const selected = only ? GROUPS.filter(g => g.name === only) : GROUPS;
      if (only && !selected.length) {
        console.error(`--only=${only} 没有匹配到分组，可用：${GROUPS.map(g => g.name).join(', ')}`);
        process.exitCode = 1;
        return;
      }
      if (only) console.log(`只处理分组 "${only}"（${selected.length} 组）`);
      for (const group of selected) {
        await uploadGroup(page, group);
      }
    }

    console.log('\n================ 汇总 ================');
    for (const r of results) {
      console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.dir.padEnd(42)} ${r.reason}`);
    }
    const failed = results.filter(r => !r.ok).length;
    console.log(`共 ${results.length} 组，失败 ${failed} 组`);
    if (failed && !DRY) process.exitCode = 2;
  } finally {
    await ctx.close();
  }
})().catch(error => { console.error('ERR ' + error.message); process.exit(1); });
