/**
 * 通过已登录的 Edge 触发 GitHub Actions workflow_dispatch。
 * 用法：node gh-run.cjs ai-news-collect.yml
 */
const PW = 'C:/Users/11600493/.workbuddy/binaries/node/workspace/node_modules/playwright';
const { chromium } = require(PW);

const PROFILE = 'C:/Users/11600493/.workbuddy/pw-profile';
const OWNER = 'lxq1314666888';
const REPO = 'i_want_to_improve';
const WORKFLOW = process.argv[2] || 'ai-news-collect.yml';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'msedge',
    headless: true,
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--no-sandbox', '--enable-automation'],
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  try {
    const page = await ctx.newPage();
    const url = `https://github.com/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}`;
    let loaded = false;
    for (let i = 1; i <= 3 && !loaded; i++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        loaded = true;
      } catch (error) {
        console.log(`nav 第 ${i} 次失败：${error.message.split('\n')[0]}`);
        await sleep(3000);
      }
    }
    if (!loaded) { console.log('RESULT=NAV_FAILED'); return; }

    console.log('页面：' + await page.title());

    // 诊断：列出所有可点元素，确认 Run workflow 的真实标签
    await sleep(3000);
    const dom = await page.evaluate(() => {
      const els = [...document.querySelectorAll('button, summary, a[role="button"], [data-testid]')];
      const texts = els.map(el => (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40)).filter(Boolean);
      return { total: els.length, texts: [...new Set(texts)].slice(0, 45) };
    });
    console.log(`可点元素 ${dom.total} 个：` + JSON.stringify(dom.texts));

    // GitHub 用 <details><summary role="button">Run workflow</summary> 实现下拉。
    // 折叠时内部真正的提交按钮不可见，所以必须先点 summary，且只用 summary 定位展开器。
    const opener = page.locator('summary:has-text("Run workflow")').first();
    try {
      await opener.waitFor({ state: 'visible', timeout: 20000 });
    } catch {
      console.log('RESULT=NO_RUN_BUTTON');
      const txt = await page.evaluate(() => document.body.innerText.slice(0, 500).replace(/\n+/g, ' | '));
      console.log('页面文本：' + txt);
      return;
    }
    await opener.click();
    await sleep(2500);

    // 展开后的可见提交按钮
    const confirm = page.locator('button:has-text("Run workflow"):visible').first();
    try {
      await confirm.waitFor({ state: 'visible', timeout: 15000 });
    } catch {
      console.log('RESULT=PANEL_NOT_OPEN');
      return;
    }
    await confirm.click();
    await sleep(6000);

    console.log('触发后 URL：' + page.url());
    const body = await page.evaluate(() => document.body.innerText.replace(/\n+/g, ' | ').slice(0, 600));
    console.log('页面反馈：' + body);
    console.log('RESULT=TRIGGERED');
  } finally {
    await ctx.close();
  }
})().catch(error => { console.error('ERR ' + error.message); process.exit(1); });
