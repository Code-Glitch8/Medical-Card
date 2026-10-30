// Usage: node check-no-secrets.mjs <dir> [<dir>...]
// Fails if any text file under the directories contains a Supabase key that is not the public anon key
// (any JWT whose "role" claim is not "anon", or a "sb_secret_" key), or the literal service-role key marker in code.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const jwt = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
let bad = 0, scanned = 0, anon = 0;
function walk(d) {
  for (const n of readdirSync(d)) {
    if (n === 'node_modules' || n === '.git') continue;
    const p = join(d, n), s = statSync(p);
    if (s.isDirectory()) { walk(p); continue; }
    if (s.size > 8_000_000) continue;
    let t; try { t = readFileSync(p, 'utf8'); } catch { continue; }
    scanned++;
    for (const m of t.matchAll(jwt)) {
      try {
        const role = JSON.parse(Buffer.from(m[0].split('.')[1], 'base64url').toString()).role;
        if (role === 'anon') anon++; else { console.error(`FAIL ${p}: JWT with role "${role}"`); bad++; }
      } catch { /* not a decodable JWT */ }
    }
    if (/sb_secret_[A-Za-z0-9_-]{10,}/.test(t)) { console.error(`FAIL ${p}: sb_secret_ key`); bad++; }
    if (/SUPABASE_SERVICE_ROLE_KEY\s*[=:]\s*['"]?[A-Za-z0-9._-]{20,}/i.test(t)) { console.error(`FAIL ${p}: service-role assignment`); bad++; }
  }
}
for (const d of process.argv.slice(2)) walk(d);
console.log(`scanned ${scanned} files; anon-role JWTs found: ${anon}; problems: ${bad}`);
process.exit(bad ? 1 : 0);
