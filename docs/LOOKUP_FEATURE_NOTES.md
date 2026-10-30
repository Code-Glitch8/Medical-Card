# Public medical-card lookup — install, tests, and report

## What was (and was not) inspected
* **Inspected:** your live `index.html` (identical to the copy in the GitHub repo `Code-Glitch8/Medical-Card`, `main`): login view, `RPC`/`call()` wrappers, `patientFromRow`, the dashboard renderers (to learn the JSON shapes).
* **NOT inspected: your deployed Supabase database.** The repo contains no `schema.sql`, and I have no access to your project. I built the SQL from the schema you described and checked it on a scratch PostgreSQL 16 with a stand-in `patients` table. Run `verify_anon_privileges.sql` (below) so the deployed state is checked on your side.
* The migration has a pre-flight that **aborts before changing anything** if `public.patients` lacks any column it reads.

## Files
| File | Purpose |
|---|---|
| `index.html` | Your site with the feature added (replace the existing file) |
| `public_lookup_migration.sql` | Additive, re-runnable migration (function, private rate-limit tables, grants, rollback block) |
| `verify_anon_privileges.sql` | Read-only audit of what the not-logged-in `anon` role can reach |

No Edge Function is needed: the rate limiter lives in the database (see "Rate limiting" for why, and its limits).

## Install
1. **Back up** `index.html` (copy it to `index.backup.html`, or rely on git history).
2. **Supabase → SQL Editor → New query:** paste `verify_anon_privileges.sql`, run it, and read the notes in the file (especially check 1: any write RPC `anon` can execute is a pre-existing exposure).
3. In a new query paste `public_lookup_migration.sql`, **Run**. It is safe to run twice. Expect "Success. No rows returned".
4. Replace `index.html` in the repo with the new one; `git add index.html && git commit -m "Add public read-only card lookup" && git push`.
5. GitHub Pages republishes from the branch automatically (Repo → Settings → Pages shows the build); allow ~1 minute, hard-refresh.
6. Dashboard settings: **none need to change.** The Supabase URL/anon key in `index.html` are unchanged; no service-role key is used anywhere. Do not add `emr_internal` to "Exposed schemas".

## What the public viewer receives (and what is withheld)
Returned: name, preferred name, DOB, sex, blood group/status/date/source, emergency contact name+phone, important notes, allergy status, allergies, conditions, medications, medical records, vaccinations, additional contacts, and `updated_at` (shown as "last updated").
**Withheld on purpose:** `id`, `code16` (the caller already has it), `version`, `created_by_hospital_id/name`, `created_at`, `last_modified_hospital_id/name/at`, `last_access`, `prev_access`, `card_programmed_at/by` (internal/audit metadata), and **`timeline`** (the existing app never displays it and its contents are undefined; if you confirm it holds nothing internal, add it to the `jsonb_build_object` in the function and to `renderPublicProfile`).
Note: medical-record entries contain whatever hospitals typed (doctor name, registration number, clinic). They are shown because you asked for the complete profile; remove those lines in `renderPublicProfile` if you prefer.

## Security design
* **Read-only is enforced by the database.** `anon` gets EXECUTE on exactly one new function. It takes only a 10-digit code (no UUID parameter), returns one whitelisted row, and writes only to `emr_internal.lookup_attempts`. It never touches `patients`, `patient_access_grants`, audit logs, `last_access`, versions or card data; `open_patient_by_card` is untouched, so no 24-hour grant is created.
* `SECURITY DEFINER` is needed (no RLS policy lets `anon` read `patients`, and none was added). `search_path` is empty; all objects are schema-qualified.
* Supabase grants EXECUTE on new functions to `anon/authenticated/service_role` by default, so the migration revokes from `PUBLIC, anon, authenticated` and then grants back only `anon, authenticated` (`authenticated` so a hospital user whose browser still holds a session can use the form).
* Failures are returned as `{"status": ...}` rather than raised, because a raised error rolls back the transaction and would erase the attempt the limiter must remember.
* Response header `Cache-Control: no-store` is set from inside the function.
* The frontend renders everything with `createElement`/`textContent` (never `innerHTML`), keeps the code out of URL/history/storage, clears the field on success and on leaving, and hides the record after 5 minutes without activity. Error messages are generic (no SQL or stack details).

## Rate limiting — what it does and its limits
Per caller IP: 8 failed lookups **or** 40 lookups per 15 minutes. Whole service: 150 failed lookups per 10 minutes. Blocked calls get `rate_limited` before any patient data is read. Only a salted hash of the IP and the outcome are stored — never the code. Edit the `c_*` constants and re-run the file to tune.
Honest limits:
1. The caller IP comes from the `cf-connecting-ip` header (else the last `x-forwarded-for` entry). I could not verify which headers your Supabase project sends. If neither is present, everyone shares one "unknown" bucket (still safe, but one user's mistakes count against all). Check once: after a few failed lookups, run `select count(distinct ip_hash) from emr_internal.lookup_attempts;` from different networks — it should be more than 1.
2. An attacker with many IPs is held to the global cap (~21,600 guesses/day), versus 10^10 possible codes. The cost: an attacker can also trigger the global cap and block legitimate lookups for up to 10 minutes. That is a deliberate trade-off for a bearer-code system.
3. **A 10-digit code alone is weak authentication for a full medical history.** Anyone who sees a card or code can read everything shown. A stronger option, not implemented because you asked for code-only access: also require the date of birth (or last 4 digits of the emergency phone) in the same call and compare it in SQL; or show only emergency-critical fields publicly and gate the rest behind a second factor.
4. Legacy 16-digit codes still exist in the app (`codeValid` accepts them). This feature accepts **only 10 digits**, as specified, so a person with a legacy 16-digit code cannot use it.

## Small change to existing code (disclosed)
`ensureSB()` now clears its cached promise when the Supabase library fails to load (offline at first load), so the next click retries instead of failing until a page reload. Hospital login benefits equally; nothing else in existing flows changed. `showView` now also clears the public profile whenever any other view is shown.

## Testing checklist (✔ = I ran it; ☐ = you must run it)
**Run by me** — scratch PostgreSQL 16 with a stand-in schema + headless Chromium. The browser used a stand-in for the supabase-js CDN module (the sandbox cannot reach the CDN) that forwards the real RPC call to the real SQL function:
- ✔ Valid code (incl. leading zeros) → profile; ✔ nonexistent code → generic not-found; ✔ letters / 9 / 11 digits / empty / spaces / non-ASCII digits → rejected in the browser with **zero** requests sent; ✔ SQL-injection-style strings → `invalid`
- ✔ Migration runs twice cleanly; ✔ `anon` cannot read `patients` (0 rows under RLS), cannot read/insert `emr_internal.*`, cannot call a write RPC (permission denied)
- ✔ Rate limits: 8 failures then `rate_limited`; another IP unaffected; blocked IP blocked even with a valid code; 40-lookup cap; global cap
- ✔ UI: network failure → generic message, button re-enabled, retry succeeds; double-click/Enter sends one request; code field cleared; nothing stored in `localStorage`/`sessionStorage`; URL unchanged, no history entries; Back clears the profile and the code field
- ✔ XSS: `<img onerror>`, `<script>`, `<svg onload>`, `<b>` in name/allergies/conditions/notes/contacts render as plain text, no elements created, no script ran, no dialogs
- ✔ Withheld fields (hospital name, timeline) absent from the DOM
- ✔ Existing hospital sign-in still shows "Incorrect login ID/email or password" for bad credentials
- ✔ 375 px mobile (touch) light and dark: no horizontal overflow; ✔ 5-minute idle auto-hide
- ✔ Inline JS passes `node --check`

**Not run — needs your real project / hardware:**
- ☐ A real code from your database against the deployed function (confirm the fields display correctly with your real data, especially `contacts`)
- ☐ Run `verify_anon_privileges.sql` and confirm no write RPC is executable by `anon` (I cannot see your deployed grants)
- ☐ Authenticated hospital login with a real account; an authorized hospital editing and saving a profile
- ☐ Anonymous `curl` to a write RPC, e.g. `curl -s -X POST "$URL/rest/v1/rpc/save_patient" -H "apikey: $ANON" -H "Content-Type: application/json" -d '{}'` → expect 401/403/404, never success
- ☐ Anonymous `curl "$URL/rest/v1/patients?select=*" -H "apikey: $ANON"` → expect `[]` or an error
- ☐ Rate limit on the real deployment (9 wrong codes → "Too many attempts"); then check `select count(distinct ip_hash) …` as noted
- ☐ RFID read/write and the 24-hour cross-hospital grant: the migration does not touch those functions, but I have no hardware or hospital accounts here
- ☐ Screen-reader pass (labels, `role=alert`, focus moves to the heading on success and to the error on failure are implemented but only checked by DOM inspection)

## Rollback
Restore the backed-up `index.html`, then run the commented block at the bottom of `public_lookup_migration.sql` (drops the function, the two tables, the schema; no patient data is affected).
