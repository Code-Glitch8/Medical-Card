// Usage: node build-web.mjs <android|windows> [--stub-vendor]
//
// Produces the web bundle that is embedded in a native app:
//   * reads ../web/index.html (the authoritative site; NEVER modified)
//   * replaces the runtime CDN import of supabase-js with a locally bundled copy
//     (same pinned version the site uses: 2.45.4) so the app has no CDN dependency
//   * injects a Content-Security-Policy and the platform shim (native/shim-<target>.js)
// Output: android -> ../android/app/src/main/assets/   windows -> ../windows/app-web/
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const target = process.argv[2];
const stub = process.argv.includes('--stub-vendor'); // test-only: no network needed, NOT for releases
if (!['android', 'windows'].includes(target)) {
  console.error('Usage: node build-web.mjs <android|windows> [--stub-vendor]');
  process.exit(2);
}
const outDir = target === 'android'
  ? join(root, 'android/app/src/main/assets')
  : join(root, 'windows/app-web');

let html = readFileSync(join(root, 'web/index.html'), 'utf8');

// The website carries its own startup splash (between <!--mc-web-splash-start/end--> markers). The native
// bundles inject the native splash below, so remove the website copy first to avoid a duplicate #mcSplash.
html = html.replace(/<!--mc-web-splash-start-->[\s\S]*?<!--mc-web-splash-end-->/g, '');
if (/id="mcSplash"/.test(html)) throw new Error('website splash was not fully stripped');

function replaceOnce(src, needle, replacement) {
  const first = src.indexOf(needle);
  if (first < 0 || src.indexOf(needle, first + 1) >= 0) {
    throw new Error('Patch anchor must occur exactly once: ' + needle.slice(0, 70));
  }
  return src.slice(0, first) + replacement + src.slice(first + needle.length);
}

// 1. local supabase-js instead of the jsDelivr CDN (version constant in the page stays 2.45.4)
html = replaceOnce(html,
  "import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@'+SUPABASE_JS+'/+esm')",
  "import('./vendor/supabase.js')");

// 2. CSP: only this app's own files + the one Supabase project. No frames, no plugins.
const SUPA = 'https://pkzzktnxiboottirasvc.supabase.co';
const csp = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",           // the site is one big inline script; see docs/SECURITY_REVIEW.md
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  `connect-src 'self' ${SUPA} wss://pkzzktnxiboottirasvc.supabase.co`,
  "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');

const read = (f) => readFileSync(join(root, f), 'utf8');
const scripts = ['native/common.js', `native/shim-${target}.js`, 'native/ui.js'].map(read);
for (const sc of scripts) if (/<\/script/i.test(sc)) throw new Error('native script must not contain </script');
html = replaceOnce(html, '<meta charset="utf-8">',
  `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n<script>\n${scripts.join('\n;\n')}\n</script>`);

// 2. Persistent auth storage (session survives restart; idle cut-off lives in native/common.js)
html = replaceOnce(html, 'storage:window.sessionStorage', 'storage:(window.__mcAuthStorage||window.sessionStorage)');

// 3. Edge Functions via the native HTTPS stack (falls back to supabase-js when no native bridge exists)
html = replaceOnce(html,
  'await SB.functions.invoke(EDGE[name],{body:data||{}});',
  'await (window.__mcEdgeNative?window.__mcEdgeInvoke(EDGE[name],data||{},SUPABASE_KEY):SB.functions.invoke(EDGE[name],{body:data||{}}));');

// 4. Bound the serial line buffer (a reader that never sends "\n" must not grow memory forever)
html = replaceOnce(html,
  'serialBuffer+=new TextDecoder().decode(value);',
  'serialBuffer+=new TextDecoder().decode(value);if(serialBuffer.length>2048)serialBuffer=serialBuffer.slice(-512);');

// 5. Native design language + startup splash (markup first in <body>, shown once per launch)
const css = ['native/theme.css', `native/${target}.css`].map(read).join('\n');
const logo = '<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="mcsg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b8cff"/><stop offset="1" stop-color="#1747b8"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#mcsg)"/><rect x="14" y="12" width="36" height="40" rx="6" fill="#fff" opacity=".96"/><path d="M29 19h6v7h7v6h-7v7h-6v-7h-7v-6h7z" fill="#1747b8"/><path d="M18 45h8l3-5 4 9 3-6 2 2h8" fill="none" stroke="#3b8cff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const splash = `<div id="mcSplash" role="status" aria-label="Loading MedVault Secure Medical Records"><div class="mc-mark"><span class="mc-ring"></span><span class="mc-ring r2"></span><span class="mc-scan"></span>${logo}</div><h1>MEDVAULT SECURE MEDICAL RECORDS</h1><p>SECURE MEDICAL RECORDS</p><div class="mc-bar"><i></i></div></div>`;
html = replaceOnce(html, '</head><body>', `<style id="mc-native">${css}</style></head><body>${splash}`);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'vendor'), { recursive: true });
writeFileSync(join(outDir, 'index.html'), html);

// 3. vendored supabase-js (ESM bundle exporting createClient)
const vendorOut = join(outDir, 'vendor/supabase.js');
if (stub) {
  writeFileSync(vendorOut, 'export const createClient=()=>{throw new Error("stub vendor: test build only")};\n');
  console.warn('WARNING: --stub-vendor used. This output is for tests only.');
} else {
  if (!existsSync(join(here, 'node_modules/@supabase/supabase-js'))) {
    // Offline fallback: the pinned supabase-js 2.45.4 ESM bundle that shipped in the previous APK.
    if (existsSync(join(here, 'vendor/supabase.js'))) {
      copyFileSync(join(here, 'vendor/supabase.js'), vendorOut);
      console.warn('NOTE: node_modules missing; used tools/vendor/supabase.js (pinned 2.45.4 bundle).');
      console.log(`Built ${target} web bundle -> ${outDir}`);
      process.exit(0);
    }
    console.error('Run "npm install" in tools/ first (needs the npm registry).');
    process.exit(1);
  }
  const esbuildPath = join(here, 'node_modules/esbuild/lib/main.js');
  const { build } = await import(pathToFileURL(esbuildPath).href);
  writeFileSync(join(here, '.entry.mjs'), "export { createClient } from '@supabase/supabase-js';\n");
  await build({
    entryPoints: [join(here, '.entry.mjs')], bundle: true, format: 'esm', platform: 'browser',
    target: 'es2020', minify: true, sourcemap: false, legalComments: 'none', outfile: vendorOut,
    absWorkingDir: here,
  });
  rmSync(join(here, '.entry.mjs'));
}
console.log(`Built ${target} web bundle -> ${outDir}`);
