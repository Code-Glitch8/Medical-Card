// Headless-Chromium test of native/shim-android.js against a FAKE McNative bridge (no real Bluetooth involved).
// Usage: node shim-android.test.cjs http://127.0.0.1:8765/index.html
const { chromium } = require('playwright');
const url = process.argv[2];
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n); };

(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext(); const page = await ctx.newPage();
  const errors = [], cspViol = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/Content Security Policy/i.test(m.text())) cspViol.push(m.text()); });
  await ctx.addInitScript(() => {
    // Fake of what Android's addWebMessageListener provides. Scripted behaviour is steered via window.__fake.
    window.__sent = []; window.__fake = { openOk: true, pickAddr: 'AA:BB:CC:DD:EE:FF' };
    window.McNative = {
      onmessage: null,
      postMessage(s) {
        const m = JSON.parse(s); window.__sent.push(m);
        const reply = o => setTimeout(() => window.McNative.onmessage({ data: JSON.stringify(o) }), 5);
        if (m.op === 'pick') reply(window.__fake.pickAddr ? { ev: 'picked', address: window.__fake.pickAddr, name: 'HC-05' } : { ev: 'pick_cancelled' });
        if (m.op === 'open') reply(window.__fake.openOk ? { ev: 'opened' } : { ev: 'open_failed', error: 'Connection refused' });
      }
    };
  });
  await page.goto(url);
  await page.waitForSelector('#loginForm', { timeout: 10000 });

  ok(await page.evaluate(() => 'serial' in navigator), "navigator.serial exists ('Manual code entry' fallback not forced)");
  ok(cspViol.length === 0, 'no CSP violations while loading the page' + (cspViol.length ? ': ' + cspViol[0] : ''));
  ok(errors.length === 0, 'no uncaught page errors' + (errors.length ? ': ' + errors[0] : ''));

  const r = await page.evaluate(async () => {
    const out = {};
    const port = await navigator.serial.requestPort();
    out.picked = port && typeof port.open === 'function';
    // 1) USB baud rejected, and NOT reported as connected
    try { await port.open({ baudRate: 115200 }); out.usbRejected = false; } catch (e) { out.usbRejected = e.name === 'NotSupportedError'; }
    // 2) Bluetooth connect + split-line reads like the site's readSerialLoop
    await port.open({ baudRate: 9600 });
    out.opened = port.readable !== null && port.writable !== null;
    const reader = port.readable.getReader();
    const push = s => window.McNative.onmessage({ data: JSON.stringify({ ev: 'data', b64: btoa(s) }) });
    push('CODE:01234'); push('56789\r\nUID:04A1B2\n');
    let buf = '', dec = new TextDecoder();
    for (let i = 0; i < 2; i++) { const { value } = await reader.read(); buf += dec.decode(value); }
    out.read = buf;
    // 3) write goes out as base64 of the exact bytes the site sends
    const w = port.writable.getWriter(); await w.write(new TextEncoder().encode('CHECK\n')); w.releaseLock();
    out.written = atob(window.__sent.filter(m => m.op === 'write').pop().b64);
    // 4) device lost -> pending read rejects with NetworkError, port is cleared
    const pend = reader.read().then(() => 'resolved', e => e.name);
    window.McNative.onmessage({ data: JSON.stringify({ ev: 'closed', error: 'link lost' }) });
    out.lost = await pend; out.afterLost = port.readable === null;
    // 5) failed open surfaces an error
    window.__fake.openOk = false;
    const p2 = await navigator.serial.requestPort();
    try { await p2.open({ baudRate: 9600 }); out.failedOpen = 'no-error'; } catch (e) { out.failedOpen = e.name + ':' + e.message; }
    // 6) user cancels the picker
    window.__fake.pickAddr = null;
    try { await navigator.serial.requestPort(); out.cancel = 'no-error'; } catch (e) { out.cancel = e.name; }
    return out;
  });
  ok(r.picked, 'requestPort returns a port after native pick');
  ok(r.usbRejected, '115200 (USB) is rejected with NotSupportedError');
  ok(r.opened, 'open(9600) yields readable+writable only after native "opened"');
  ok(r.read === 'CODE:0123456789\r\nUID:04A1B2\n', 'bytes arrive intact across chunks: ' + JSON.stringify(r.read));
  ok(r.written === 'CHECK\n', 'write delivers exact bytes: ' + JSON.stringify(r.written));
  ok(r.lost === 'NetworkError' && r.afterLost, 'link loss -> read rejects NetworkError, port cleared');
  ok(/^NetworkError:Connection refused/.test(r.failedOpen), 'failed native open -> NetworkError (never "connected"): ' + r.failedOpen);
  ok(r.cancel === 'NotFoundError', 'cancelled picker -> NotFoundError');

  await b.close();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
