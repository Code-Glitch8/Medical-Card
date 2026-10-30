// Usage: node build-web.mjs <android|windows> [--stub-vendor]
//
// Produces the web bundle that is embedded in a native app:
//   * reads ../web/index.html (the authoritative site; NEVER modified)
//   * replaces the runtime CDN import of supabase-js with a locally bundled copy
//     (same pinned version the site uses: 2.45.4) so the app has no CDN dependency
//   * injects a Content-Security-Policy and the platform shim (native/shim-<target>.js)
// Output: android -> ../android/app/src/main/assets/   windows -> ../windows/app-web/
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
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

const shim = readFileSync(join(root, `native/shim-${target}.js`), 'utf8');
if (/<\/script/i.test(shim)) throw new Error('shim must not contain </script');
html = replaceOnce(html, '<meta charset="utf-8">',
  `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n<script>\n${shim}\n</script>`);

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
