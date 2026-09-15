/**
 * 删除仓库里的文件。破坏性操作，流程刻意做成可追溯：
 *   1. 先匿名回读文件内容并归档到 backup/（本地留副本，便于随时恢复）
 *   2. 通过已登录的 Edge 打开 GitHub 的 /delete/ 页面提交删除
 *   3. 匿名回读确认返回 404 —— 这是唯一可信的成功判据
 *
 * 用法：node ops/gh-delete.cjs <仓库相对路径>
 */
const PW = 'C:/Users/11600493/.workbuddy/binaries/node/workspace/node_modules/playwright';
const { chromium } = require(PW);
const fs = require('node:fs');
const path = require('node:path');

const PROFILE = 'C:/Users/11600493/.workbuddy/pw-profile';
const OWNER = 'lxq1314666888';
const REPO = 'i_want_to_improve';
const BRANCH = 'main';
const TARGET = process.argv[2];
const BACKUP_DIR = path.join(__dirname, '..', 'backup');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function apiGet(p) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(`https://api.github.com/repos/${OWNER}/${REPO}${p}`,
                         { headers: { 'User-Agent': 'delete-verify/1.0' } });
    } catch {
      await sleep(3000);
    }
  }
  return null;
}

(async () => {
  if (!TARGET) {
    console.error('用法：node ops/gh-delete.cjs <仓库相对路径>');
    process.exitCode = 1;
    return;
  }

  // ---- 1. 归档 ----
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const read = await apiGet(`/contents/${TARGET}?ref=${BRANCH}`);
  if (!read || !read.ok) {
    console.error(`归档失败：回读 HTTP ${read ? read.status : '网络错误'}。中止，不做删除。`);
    process.exitCode = 1;
    return;
  }
  const meta = await read.json();
  const archive = path.join(BACKUP_DIR,
    `${path.basename(TARGET)}.removed-${new Date().toISOString().slice(0, 10)}`);
  fs.writeFileSync(archive, Buffer.from(meta.content, 'base64'));
  console.log(`已归档 → ${archive}（${meta.size}B, sha ${meta.sha.slice(0, 8)}）`);

  // ---- 2. 浏览器删除 ----
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'msedge',
    headless: true,
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--no-sandbox', '--enable-automation'],
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  let deleted = false;
  try {
    const cookies = await ctx.cookies('https://github.com');
    if (!cookies.some(c => c.name === 'user_session')) {
      console.error('未检测到 GitHub 登录态，中止');
      process.exitCode = 1;
      return;
    }

    const page = await ctx.newPage();
    const url = `https://github.com/${OWNER}/${REPO}/delete/${BRANCH}/${TARGET}`;
    let opened = false;
    for (let i = 1; i <= 3 && !opened; i++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        opened = true;
      } catch (error) {
        console.log(`  导航第 ${i} 次失败：${error.message.split('\n')[0]}`);
        await sleep(3000);
      }
    }
    if (!opened) {
      console.error('删除页打不开');
      process.exitCode = 1;
      return;
    }
    console.log(`  删除页：${await page.title()}`);

    // 删除页的按钮位置随 GitHub 版本变动，先滚到底再枚举候选
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2000);
    const labels = await page.locator('button').allTextContents();
    console.log('  页面按钮：' + labels.filter(Boolean).map(t => t.trim().slice(0, 20)).join(' | '));

    // GitHub 删除页是两步：先点 "Commit changes..."（带省略号）展开提交面板，
    // 再在展开的面板里点精确文本 "Commit changes" 才算提交。一次性选择器会匹配到不可见元素。
    const opener = page.locator('button').filter({ hasText: /Commit changes\s*(\.{3}|…)/ }).first();
    if (await opener.count()) {
      await opener.click();
      await sleep(2500);
      console.log('  已展开提交面板');
    }
    const confirm = page.locator('button').filter({ hasText: /^Commit changes$/ }).last();
    try {
      await confirm.waitFor({ state: 'visible', timeout: 20000 });
    } catch {
      const txt = await page.evaluate(() => document.body.innerText.slice(-500).replace(/\n+/g, ' | '));
      console.error(`  找不到提交按钮，页面尾部：${txt}`);
      process.exitCode = 1;
      return;
    }
    await confirm.click();
    await sleep(6000);

    // ---- 3. 回读确认 ----
    const after = await apiGet(`/contents/${TARGET}?ref=${BRANCH}&cb=${Date.now()}`);
    if (after && after.status === 404) {
      deleted = true;
      console.log('  ✓ 匿名回读返回 404，确认已删除');
    } else {
      console.error(`  ✗ 回读仍是 HTTP ${after ? after.status : '网络错误'}，删除未生效`);
    }
  } finally {
    await ctx.close();
  }
  if (!deleted) process.exitCode = 1;
})().catch(error => { console.error('ERR ' + error.message); process.exit(1); });
