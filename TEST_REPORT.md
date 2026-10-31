# TEST_REPORT.md

## Executed here (headless Chromium + Node, **simulated** native bridges, **mocked** Supabase)
| Test | Result |
|---|---|
| `native/test/shim-android.test.cjs` (fake `McNative`): serial present, no CSP/page errors, picker, 115200 rejected, streams only after native "opened", bytes intact across chunks, exact bytes written, link loss → NetworkError, failed open never "connected", cancelled picker | **11/11 pass** |
| `native/test/app.test.cjs` Android bundle 390×800: splash shows once and is removed; wrong Login-ID password → clear error; Login ID call goes over native bridge, **not** the browser; correct password → session + app opens; session stored persistently; bottom nav fixed with icons; no horizontal overflow; Back behaviour; **restart restores session**; >8 h idle session dropped; network failure → readable error; no page errors/CSP violations | **19/19 pass** |
| Same file, Windows bundle at 1280 / 820 / 420 px: Login ID via main-process bridge, title bar, sidebar / icon rail / bottom bar layouts, no overflow, Ctrl+N navigation, dark theme screenshot | **16/16 pass** |
| Reduced-motion: splash shortened, no animation | **pass** |
| `check-no-secrets.mjs` (anon-only JWTs) | 0 problems |
| `node --check` on all JS | pass |

## NOT executed (be aware)
* **Kotlin compile, Gradle build, APK, Electron launch, NSIS installer: not done.** This sandbox cannot reach Maven/Google/npm (proxy 403 / DNS). The Kotlin (`MainActivity.kt`, `BtSerial.kt`) and Electron (`main.cjs`, `preload.cjs`) changes are **uncompiled**; expect to fix small compile errors on the first CI run. No new APK/EXE was produced.
* **Real login against Supabase / real Edge Functions** — requires a real account (and the function's CORS/Origin behaviour). Needed to confirm bug #1's root cause.
* **Physical hardware:** HC-05 pairing/connect, permission-granted/denied/permanently-denied dialogs, Bluetooth off, reader unplugged mid-session, reconnect, Arduino restart, RFID read/write/finalize, USB serial at 115200 on Windows. Only simulated at the JS-bridge level.
* Android 8/11/12/15 device matrix; Windows install/uninstall/SmartScreen; Android splash visuals on a device (screenshots only of the in-app splash).
* Hospital registration and password reset end-to-end (same bridge, not exercised with a backend).

## How to finish
Run Actions → "Build Android APK and Windows installer" (now also runs the tests above), then TEST_PLAN.md sections A–C on real devices.
