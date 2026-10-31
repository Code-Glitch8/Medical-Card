# Emergency Medical Records — Medical Card: Android + Windows apps

Source for an Android app (APK) and a Windows desktop app (EXE installer) that wrap the **existing** website and
talk to the **same** Supabase project. No backend, schema, RPC, RLS or Edge Function was changed.

> **v1.1.0 status:** see CHANGELOG.md, BUG_REPORT.md, TEST_REPORT.md. The v1.1.0 Kotlin/Electron changes are uncompiled; build via the GitHub Actions workflow.
>
> **Build status (original note).** The sandbox this was written in has no access to the Android SDK, Maven, npm or
> Electron downloads, so **no APK and no EXE have been built yet**. Everything needed to build them is here, plus a
> GitHub Actions workflow that produces both. See "Build" below. The Kotlin/Electron code has **not been compiled or run**.

## Architecture (and trade-offs)
```
web/index.html  (original site, unchanged, still deployable to GitHub Pages)
      │  tools/build-web.mjs  = copy + 3 patches (local supabase-js, CSP, platform shim)
      ├── android/  Kotlin WebView app ── native Bluetooth Classic (SPP) bridge for the HC-05
      └── windows/  Electron app        ── Chromium's built-in Web Serial + COM-port chooser
                         both ──► Supabase Auth + Edge Functions + RPCs + RLS (pkzzktnxiboottirasvc.supabase.co)
```
* **Shared frontend, not a rewrite.** All business logic (RPC wrappers, validation, version-conflict handling, audit
  calls, admin screens, public lookup) is the existing code. Re-implementing ~160 KB of working medical UI natively
  would add risk with no benefit. Trade-off: the UI is web-rendered; updates to the site require rebuilding the apps.
* **Windows = Electron, not Tauri.** The site's RFID code uses Web Serial. Electron's Chromium implements it, so the
  serial code runs *unchanged* (Tauri's WebView2 does not, to my knowledge, expose Web Serial to embedding apps, so it would need a custom serial layer). Trade-off: larger installer (~80 MB).
* **Android = native WebView + native Bluetooth.** Android WebView has no Web Serial/Bluetooth. A small shim
  (`native/shim-android.js`) provides a Web-Serial-compatible `navigator.serial` backed by a Classic-Bluetooth SPP link
  (`BtSerial.kt`). The HC-05 is a Classic module (not BLE), so SPP UUID `00001101-…` is used. The Arduino line protocol
  (`UID:` / `CARD:` / `CODE:` / `INFO:` / `ERR:`, `\n`-terminated) is untouched, so **no firmware change**.
* **What the site uses today for hardware:** Web Serial only (`navigator.serial.requestPort/open/readable/writable`),
  baud selector 9600 (HC-05 Bluetooth) / 115200 (direct USB) / 38400 / 57600.

## Build
Prereqs: Node 22, JDK 17 + Android SDK (Android), Windows 10/11 (Windows). Needs internet (npm, Maven).

**Easiest: GitHub Actions.** Push this folder as a repo, run *Actions → "Build Android APK and Windows installer"*.
Artifacts: `MedicalCard-debug.apk` and `MedicalCardSetup.exe`.

**Locally**
```
cd tools && npm install                       # pins @supabase/supabase-js 2.45.4 (same as the site)
node build-web.mjs android                    # -> android/app/src/main/assets
cd ../android && ./gradlew assembleDebug      # -> app/build/outputs/apk/debug/app-debug.apk
cd ../tools && node build-web.mjs windows     # -> windows/app-web
cd ../windows && npm install && npx electron-builder --win nsis --x64   # -> dist/MedicalCardSetup.exe
node ../tools/check-no-secrets.mjs ../android/app/src ../windows/app-web   # must print "problems: 0"
```
Never use `--stub-vendor` for anything you ship: it is a test-only switch that disables Supabase.

**Android:** versionName 1.0.0, minSdk 26 (Android 8.0), targetSdk 35. Permissions: `INTERNET`, `BLUETOOTH_CONNECT`
(Android 12+, runtime), `BLUETOOTH` (≤ Android 11). No location, no scan, no storage. Debug builds install as
`com.medicalcard.app.debug`. **Release signing:** generate your own key (`keytool -genkeypair …`), put
`storeFile/storePassword/keyAlias/keyPassword` in `android/keystore.properties` (git-ignored) or CI secrets, then
`./gradlew assembleRelease`. Without a key the release APK is unsigned and will not install. Keep the key safe: you
cannot update an installed app without it.

**Windows:** installer is NSIS, per-user, creates Start Menu + Desktop shortcuts, removes app data on uninstall.
It is **unsigned** by default (SmartScreen will warn). To sign, supply an Authenticode certificate via the standard
electron-builder `CSC_LINK`/`CSC_KEY_PASSWORD` secrets. Electron version is pinned loosely (`^39`); bump to the current
supported release before shipping, since old Chromium versions get no security fixes.

## Supabase: same project, no changes
`SUPABASE_URL` and the public anon key are copied verbatim from `web/index.html` (the build only swaps the CDN import).
`check-no-secrets.mjs` decodes every JWT in the output and fails on any role other than `anon`. No service-role key
exists anywhere. **Database changes: none.** Whether `public_lookup_migration.sql` is deployed to your live project is
unknown to me — see `supabase/DEPLOYMENT_NOTES.md` for how to check and deploy it.

## ⚠ Must verify before relying on the apps: Edge Function origins
Hospital registration, login-by-ID and password-reset are **Edge Functions** (`register-hospital`, `login-with-id`,
`request-password-reset`), whose source was not supplied. If they restrict CORS to
`https://code-glitch8.github.io`, the apps (origins `https://appassets.androidplatform.net` and `app://local`) will fail
those three calls (email+password sign-in and everything after login uses Auth/RPC and is unaffected). Test them
first (TEST_PLAN §A). The password-reset *email link* is generated server-side and lands on the website; the user
finishes the reset there and then signs in in the app. No deep link was added because nothing in the supplied code
requests one; adding one would need a Supabase redirect-URL allow-list change.

## Behaviour notes / limitations
* **Session:** the site keeps the Supabase session in `sessionStorage`, so (as on the website) closing the app signs
  out. "Session restoration" = survives rotation/backgrounding, not a cold restart. Changing this means editing site
  code; left as is on purpose (privacy).
* **Android:** USB-serial reader (115200) is **not supported**; use the HC-05 Bluetooth reader. Baud selection is
  ignored for Bluetooth (set on the module). The HC-05 must be paired in Android settings first (no scanning is done).
  Without a reader, manual 10-digit code entry works. Screenshots are blocked (`FLAG_SECURE`). Back button: goes back,
  else asks before exiting.
* **Windows:** serial works for both USB (115200) and HC-05 (its Bluetooth COM port, 9600). One window only, so only
  one component owns the COM port. Menu bar auto-hides (Alt).
* **Public lookup** remains 10-digit only (legacy 16-digit codes are not supported there — existing behaviour).
* No offline mode; network loss shows the site's normal errors. No patient data is stored by either app.
* **Not tested on hardware:** Arduino, MFRC522, HC-05, real Android devices, real Windows install.

## Files
Added: `android/**`, `windows/**`, `native/**`, `tools/**`, `supabase/DEPLOYMENT_NOTES.md`, `docs/**`,
`.github/workflows/build-apps.yml`. Copied unchanged: `web/index.html` (sha256 `e2213a14…1bd8`),
`supabase/public_lookup_migration.sql`, `supabase/verify_anon_privileges.sql`, `docs/LOOKUP_FEATURE_NOTES.md`.
Modified: none. Generated at build time (git-ignored): `android/app/src/main/assets/`, `windows/app-web/`.

## Updating later
Edit `web/index.html` (deploy to Pages as before), bump `versionCode/versionName` (android/app/build.gradle.kts) and
`version` (windows/package.json), re-run the workflow. If the site's inline-script patch anchors change,
`build-web.mjs` fails loudly instead of building a wrong app.
