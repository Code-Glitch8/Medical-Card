# Supabase notes (no changes are made by the apps)
1. **Is the public lookup deployed?** In the SQL editor run:
   `select to_regprocedure('public.public_lookup_patient_by_code(text)');` — NULL means not deployed; then the apps'
   "public lookup" will show the site's generic error.
2. **Audit first:** run `verify_anon_privileges.sql` (read-only). Any write RPC listed for `anon` is a pre-existing exposure.
3. **Deploy:** run `public_lookup_migration.sql` once (additive, re-runnable, has a pre-flight and a rollback block).
4. **Edge Functions** `register-hospital`, `login-with-id`, `request-password-reset`: confirm in the dashboard that their
   CORS headers do not whitelist only `https://code-glitch8.github.io`. Native origins are
   `https://appassets.androidplatform.net` (Android) and `app://local` (Windows). Prefer fixing CORS to allow these two
   specific origins rather than `*`.
5. No service-role key is needed by, or must ever be given to, either app.
