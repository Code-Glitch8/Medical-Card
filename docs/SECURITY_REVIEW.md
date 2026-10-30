# Security review (design review of the code written here; not a penetration test)
**Controls implemented**
* No service-role key: none present; scanner fails the build on any non-`anon` JWT or `sb_secret_…`.
* Android WebView: HTTPS-only asset origin (`appassets.androidplatform.net`), file/content access off, mixed content
  blocked, no multi-window, navigation locked to the app origin (other https → system browser, everything else
  dropped), Safe Browsing on, no HTTP cache, `FLAG_SECURE`, backups off, cleartext off, minimal permissions.
* Bridge: `addWebMessageListener` restricted to the app origin and main frame (no `addJavascriptInterface`); the page
  can only ask to list/connect/write/close; the **native side re-validates that the address is a paired device** and caps
  write size. Payloads are never logged.
* Electron: context isolation, sandbox, no Node in renderer, `webviewTag` off, devtools off when packaged, custom
  `app://` scheme with path-traversal check, will-navigate/window-open locked, outbound requests limited to the one
  Supabase host, all permissions denied except Web Serial for the app origin, single instance, preload exposes one
  function (prompt) and dialogs render via `textContent`.
* CSP in both apps: scripts/styles from self + inline, connections only to the Supabase project, no frames/objects.

**Residual risks / findings in the existing system (not changed)**
1. CSP needs `'unsafe-inline'` because the site is a single inline script with inline handlers; it therefore adds less XSS
   protection than a strict CSP. Fixing it means refactoring the site. The site's existing escaping (`esc()`/`textContent`) is
   the main XSS defence.
2. `sessionStorage` session: a token is readable by page script for the session's life (same as website).
3. Public lookup = bearer 10-digit code returning the full profile (see `LOOKUP_FEATURE_NOTES.md` §Rate limiting #3).
   Smallest fix: require DOB or last-4 of emergency phone in the same RPC.
4. Edge Function CORS/redirects unknown (see README) — verify, don't assume.
5. Unsigned Windows installer and an unsigned/self-signed APK can't prove origin to users; sign releases.
6. Unverified in this sandbox: compile-ability and runtime behaviour of the Kotlin/Electron code.
