// Headless-Chromium tests of the BUILT bundles (android + windows) with FAKE native bridges and a MOCKED Supabase.
// Nothing here touches real Bluetooth, Electron, or a real Supabase account.
// Usage: node app.test.cjs <androidBundleUrl> <windowsBundleUrl> [screenshotDir]
const { chromium } = require('playwright');
const [androidUrl, windowsUrl, shotDir] = process.argv.slice(2);
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = () => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: 'u1', role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, email: 'a@b.co' })}.sig`;
const USER = { id: 'u1', aud: 'authenticated', role: 'authenticated', email: 'a@b.co', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };

async function mockSupabase(ctx, seen) {
  await ctx.route('https://pkzzktnxiboottirasvc.supabase.co/**', (route) => {
    const u = route.request().url(); seen.push(route.request().method() + ' ' + u.replace(/^https:\/\/[^/]+/, ''));
    const h = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: h });
    if (u.includes('/auth/v1/user')) return route.fulfill({ status: 200, headers: h, body: JSON.stringify(USER) });
    if (u.includes('/rest/v1/app_users')) return route.fulfill({ status: 200, headers: h, body: JSON.stringify({ role: 'admin', hospital_id: null }) });
    if (u.includes('/rest/v1/')) return route.fulfill({ status: 200, headers: h, body: '[]' });
    return route.fulfill({ status: 404, headers: h, body: '{}' });
  });
}

(async () => {
  const b = await chromium.launch();

  // ---------- Android bundle ----------
  {
    const ctx = await b.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    const seen = []; await mockSupabase(ctx, seen);
    await ctx.addInitScript(() => {
      window.__sent = []; window.__edgeReply = null;
      window.McNative = { onmessage: null, postMessage(s) {
        const m = JSON.parse(s); window.__sent.push(m);
        if (m.op === 'edge') setTimeout(() => window.McNative.onmessage({ data: JSON.stringify(window.__edgeReply(m)) }), 20);
      } };
    });
    const page = await ctx.newPage(); const errors = [], csp = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()); });
    const tokens = { access_token: jwt(), refresh_token: 'r-token-1' };
    await page.addInitScript((t) => { window.__edgeReply = (m) => m.fn === 'login-with-id' && JSON.parse(m.body).password === 'right'
      ? { ev: 'edge', id: m.id, status: 200, body: JSON.stringify(t) }
      : { ev: 'edge', id: m.id, status: 401, body: JSON.stringify({ error: { code: 'unauthenticated', message: 'Incorrect login ID or password.' } }) }; }, tokens);
    await page.goto(androidUrl);
    await page.waitForSelector('#loginForm');

    ok(await page.locator('#mcSplash').count() === 1, 'android: splash present at launch');
    if (shotDir) await page.screenshot({ path: shotDir + '/android-splash.png' });
    await page.waitForTimeout(2700);
    ok(await page.locator('#mcSplash').count() === 0, 'android: splash removed after ~2s, once');
    ok(await page.evaluate(() => document.documentElement.classList.contains('mc-android')), 'android: platform class applied');
    if (shotDir) await page.screenshot({ path: shotDir + '/android-login.png' });
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'android: login has no horizontal overflow');

    // wrong password: clear error, nothing leaves via browser fetch to /functions/v1
    await page.fill('#loginId', 'CITY-GEN-01'); await page.fill('#loginPass', 'wrong'); await page.click('#loginSubmit');
    await page.waitForFunction(() => !document.getElementById('loginError').classList.contains('hidden'));
    const err = await page.textContent('#loginError');
    ok(/incorrect|password/i.test(err), 'android: wrong Login ID password shows clear error: ' + err.trim());
    ok(!seen.some(s => s.includes('/functions/v1/')), 'android: Login ID call did NOT go through the browser (no CORS path)');
    ok(await page.evaluate(() => window.__sent.some(m => m.op === 'edge' && m.fn === 'login-with-id' && m.apikey.split('.').length === 3)), 'android: login-with-id sent over native bridge with public key');

    // correct password
    await page.fill('#loginPass', 'right'); await page.click('#loginSubmit');
    await page.waitForSelector('#appView:not(.hidden)', { timeout: 8000 });
    ok(true, 'android: Login ID + password establishes a session and opens the app');
    ok(await page.evaluate(() => Object.keys(localStorage).some(k => k.startsWith('mc_auth:sb-'))), 'android: session stored persistently (survives restart)');
    ok(!(await page.evaluate(() => Object.keys(sessionStorage).some(k => k.includes('auth-token')))), 'android: session no longer in sessionStorage');
    await page.waitForTimeout(400);
    const nav = await page.evaluate(() => { const n = document.getElementById('mainNav'); const r = n.getBoundingClientRect(); return { pos: getComputedStyle(n).position, bottom: Math.round(innerHeight - r.bottom), items: [...n.querySelectorAll('button')].filter(x => !x.hidden).length, icons: n.querySelectorAll('svg').length }; });
    ok(nav.pos === 'fixed' && nav.bottom <= 1 && nav.items >= 3 && nav.icons >= nav.items, `android: bottom navigation (fixed, ${nav.items} items with icons)`);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'android: app screen has no horizontal overflow');
    if (shotDir) await page.screenshot({ path: shotDir + '/android-app.png' });

    // Back handling: sub-page -> home, then page reports "not handled" so native shows exit dialog
    await page.evaluate(() => navigate('settings')); await page.waitForTimeout(200);
    ok(await page.evaluate(() => window.__mcHandleBack() === true), 'android: Back from a sub-screen returns to the home tab');
    ok(await page.evaluate(() => window.__mcHandleBack() === false), 'android: Back on home tab is not consumed (native exit prompt)');

    // Restart: new page in same context = same localStorage -> session restored without typing anything
    const p2 = await ctx.newPage(); await p2.goto(androidUrl);
    await p2.waitForSelector('#appView:not(.hidden)', { timeout: 8000 });
    ok(true, 'android: session restored after closing and reopening the app');
    // Stale session (> 8 h idle) is dropped on cold start
    await p2.evaluate(() => localStorage.setItem('mc_last_active', String(Date.now() - 9 * 3600e3)));
    const p3 = await ctx.newPage(); await p3.goto(androidUrl); await p3.waitForSelector('#loginForm:not(.hidden), #loginView:not(.hidden)');
    await p3.waitForTimeout(800);
    ok(await p3.evaluate(() => !Object.keys(localStorage).some(k => k.startsWith('mc_auth:sb-'))) && await p3.locator('#appView.hidden').count() === 1, 'android: session idle > 8 h is discarded on cold start');

    // Network failure never crashes: bridge reports network error
    const p4 = await ctx.newPage();
    await p4.addInitScript(() => { window.__edgeReply = (m) => ({ ev: 'edge', id: m.id, error: 'network' }); });
    await p4.goto(androidUrl); await p4.waitForSelector('#loginView:not(.hidden)');
    await p4.fill('#loginId', 'CITY-GEN-01'); await p4.fill('#loginPass', 'x'); await p4.click('#loginSubmit');
    await p4.waitForFunction(() => !document.getElementById('loginError').classList.contains('hidden'));
    ok(/temporarily unavailable|internet|reach/i.test(await p4.textContent('#loginError')), 'android: network failure -> readable error, no crash');
    ok(errors.length === 0, 'android: no uncaught page errors' + (errors[0] ? ': ' + errors[0] : ''));
    ok(csp.length === 0, 'android: no CSP violations' + (csp[0] ? ': ' + csp[0] : ''));
    await ctx.close();
  }

  // ---------- Windows bundle ----------
  for (const [w, h, tag] of [[1280, 800, 'desktop'], [820, 700, 'rail'], [420, 800, 'narrow']]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h } });
    const seen = []; await mockSupabase(ctx, seen);
    await ctx.addInitScript((t) => {
      window.__edgeCalls = [];
      window.__mcDesktop = { prompt: () => null, onWindowState: (cb) => cb({ maximized: false, fullscreen: false }),
        edge: (fn, body) => { window.__edgeCalls.push(fn); return Promise.resolve({ status: 200, text: JSON.stringify(t) }); } };
    }, { access_token: jwt(), refresh_token: 'r2' });
    const page = await ctx.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(windowsUrl); await page.waitForSelector('#loginForm');
    await page.waitForTimeout(2500);
    await page.fill('#loginId', 'CITY-GEN-01'); await page.fill('#loginPass', 'pw'); await page.click('#loginSubmit');
    await page.waitForSelector('#appView:not(.hidden)', { timeout: 8000 });
    await page.waitForTimeout(500);
    ok(await page.evaluate(() => window.__edgeCalls[0] === 'login-with-id'), `windows/${tag}: Login ID goes through main-process bridge`);
    const m = await page.evaluate(() => { const a = document.querySelector('.appbar').getBoundingClientRect(), mn = document.getElementById('main').getBoundingClientRect();
      return { barW: Math.round(a.width), barTop: Math.round(a.top), mainLeft: Math.round(mn.left), over: document.documentElement.scrollWidth > innerWidth, title: !!document.getElementById('mcTitlebar'), pos: getComputedStyle(document.getElementById('mainNav')).flexDirection }; });
    ok(!m.over, `windows/${tag}: no horizontal overflow`);
    ok(m.title, `windows/${tag}: custom title bar present`);
    if (tag === 'desktop') ok(m.barW === 248 && m.barTop === 36 && m.mainLeft >= 248 && m.pos === 'column', 'windows/desktop: sidebar layout (248px, below title bar, content offset)');
    if (tag === 'rail') ok(m.barW === 72 && m.mainLeft >= 72, 'windows/rail: collapses to icon rail');
    if (tag === 'narrow') ok(m.pos === 'row' && m.mainLeft === 0, 'windows/narrow: bottom navigation, full-width content');
    if (tag === 'desktop') {
      await page.keyboard.press('Control+3'); await page.waitForTimeout(400);
      ok(await page.evaluate(() => document.querySelector('#mainNav .mc-active') !== null), 'windows: Ctrl+number navigates / active item highlighted');
      await page.evaluate(() => document.documentElement.classList.add('dark-theme')); await page.waitForTimeout(150);
      if (shotDir) await page.screenshot({ path: shotDir + '/windows-dark.png' });
      await page.evaluate(() => document.documentElement.classList.remove('dark-theme'));
    }
    if (shotDir) await page.screenshot({ path: shotDir + `/windows-${tag}.png` });
    ok(errors.length === 0, `windows/${tag}: no uncaught page errors` + (errors[0] ? ': ' + errors[0] : ''));
    await ctx.close();
  }

  // ---------- reduced motion ----------
  {
    const ctx = await b.newContext({ viewport: { width: 390, height: 800 }, reducedMotion: 'reduce' });
    const page = await ctx.newPage(); await ctx.addInitScript(() => { window.McNative = { postMessage() {}, onmessage: null }; });
    await page.goto(androidUrl); await page.waitForSelector('#loginForm'); await page.waitForTimeout(1100);
    ok(await page.locator('#mcSplash').count() === 0, 'reduced-motion: splash shortened (<1.1 s) and without animation');
    await ctx.close();
  }
  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
