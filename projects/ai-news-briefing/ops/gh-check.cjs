/**
 * 只读检查：pw-profile 里的 GitHub 登录态是否仍有效。
 * 不写任何文件、不提交任何变更。
 */
const PW = 'C:/Users/11600493/.workbuddy/binaries/node/workspace/node_modules/playwright';
const { chromium } = require(PW);

const PROFILE = 'C:/Users/11600493/.workbuddy/pw-profile';
const REPO = 'https://github.com/lxq1314666888/i_want_to_improve';

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
    const names = cookies.map(c => c.name);
    const session = cookies.find(c => c.name === 'user_session' || c.name === '__Host-user_session_same_site');
    console.log('LOGIN_DETECTED=' + Boolean(session));
    console.log('cookie_count=' + cookies.length);
    console.log('cookie_names=' + names.join(','));
    if (session) {
      console.log('session_expires=' + new Date(session.expires * 1000).toISOString());
    }

    // 导航到仓库页确认身份与权限（会重试，大陆访问 github.com 偶发超时）
    const page = await ctx.newPage();
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        await page.goto(REPO, { waitUntil: 'domcontentloaded', timeout: 45000 });
        ok = true;
      } catch (error) {
        console.log(`nav_attempt_${attempt}=failed (${error.message.split('\n')[0]})`);
      }
    }
    if (ok) {
      console.log('title=' + await page.title());
      console.log('url=' + page.url());
      const body = await page.evaluate(() => document.body.innerText.slice(0, 400).replace(/\n+/g, ' | '));
      console.log('body_head=' + body);
      const canUpload = await page.evaluate(() =>
        Boolean(document.querySelector('a[href*="/upload/"]')) ||
        document.body.innerText.includes('Add file'));
      console.log('HAS_ADD_FILE=' + canUpload);
    }
  } finally {
    await ctx.close();
  }
})().catch(error => { console.error('ERR ' + error.message); process.exit(1); });
