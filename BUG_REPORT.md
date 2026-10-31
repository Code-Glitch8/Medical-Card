# BUG_REPORT.md — Medical Card audit (Android + Windows apps)

Scope: every file in the repo (`web/index.html`, `native/*`, `android/**`, `windows/**`, `tools/*`, `supabase/*`, `RFID_UNO.ino` reviewed for protocol only, not modified).
**Confirmed** = reproduced/proved by reading code or by an executed test. **Suspected** = needs the real backend/hardware to prove.

| # | Bug | Where | Sev | Status | Fix |
|---|-----|-------|-----|--------|-----|
| 1 | **Login ID + password fails in the installed apps.** The page calls the `login-with-id` Edge Function from a browser origin (`https://appassets.androidplatform.net`, `app://local`). Edge Functions send their own CORS headers; if they only allow the website origin (README already warned), the browser blocks the call. Email login uses Auth REST (open CORS) so it works. | `web/index.html` `call()` → `SB.functions.invoke` | High | **Suspected cause, confirmed symptom path** (function source not in repo) | Native HTTPS bridge: Android `HttpsURLConnection` (`MainActivity.handleEdge`), Windows main-process `net.fetch` (`main.cjs` `mc:edge`). No renderer Origin ⇒ no CORS. Same fix covers `register-hospital` and `request-password-reset`. Host and function names are hard-allow-listed; no service key; RLS untouched. |
| 2 | Session lost on every app restart (auth stored in `sessionStorage`). | `initSupabase` `storage:window.sessionStorage` | Med | Confirmed | `native/common.js` persistent storage (localStorage, prefixed), dropped after 8 h idle; cleared by Sign out. |
| 3 | Serial line buffer unbounded: a reader that never sends `\n` grows `serialBuffer` forever. | `readSerialLoop` | Med | Confirmed | Build patch caps at 2 KiB (keeps tail 512 B). Site file unchanged. |
| 4 | Android JS stream queue unbounded if the page stops reading. | `native/shim-android.js` | Low | Confirmed | 64 KiB cap → link closed + "Reader data overflow". |
| 5 | Bluetooth: second `open` while connecting started another thread/socket (race, two sockets). | `BtSerial.connect` | High | Confirmed | State machine + generation counter; second connect rejected while CONNECTING; reconnect closes old link first. |
| 6 | No connect timeout (`BluetoothSocket.connect()` can block ~minutes). | `BtSerial` | High | Confirmed | 15 s watchdog closes the socket; clear "timed out" message. |
| 7 | Permission denied twice ⇒ Android stops prompting; app showed a generic error with no way out. | `MainActivity` | High | Confirmed | Detects permanent denial → dialog with **Open app settings**; first denial → explanation + Try again. |
| 8 | Bluetooth switched off ⇒ generic "off or unavailable"; no way to turn on. | `showDevicePicker` | Med | Confirmed | `ACTION_REQUEST_ENABLE` prompt; adapter-off broadcast closes the link. |
| 9 | Unexpected disconnect only noticed on next read/write failure. | `BtSerial` | Med | Confirmed | `ACL_DISCONNECTED` / `STATE_CHANGED` receiver closes link immediately; page gets `NetworkError` ("Reader error"), never stays "connected". |
| 10 | A failed permission/enable step during `open` left the page waiting 20 s. | `shim-android.js` | Low | Confirmed | `open` also accepts `pick_failed`. |
| 11 | No progress/cancel while connecting; HC-05 not distinguished from other paired devices. | `MainActivity` | Low | Confirmed | Progress dialog with Cancel; ★ HC-05 devices sorted first; "Pair new device" shortcut. |
| 12 | Android Back never worked inside the app (single-page app ⇒ `canGoBack()` always false) → always showed "Exit?". | `MainActivity` back callback | Med | Confirmed | Page-aware back (`__mcHandleBack`): sub-screen → home, register/lookup/forgot → login; exit prompt only on home. |
| 13 | Windows: menu bar/default frame looked like a browser; min height 560. | `main.cjs` | Low | Confirmed | Custom title bar + native window controls overlay, navy background (no white flash), min 360×520. |
| 14 | Wide tables overflow on phones. | CSS | Med | Confirmed | Card-style rows under 700 px (`data-label`s), scroll containers elsewhere. |
| 15 | Site runs through `window.prompt` (removed in Electron) | already fixed in repo | – | Fixed earlier | unchanged |
| 16 | Reader status "Connect reader" button/baud selector on Android: baud ignored for Bluetooth, 115200 always fails. | UI | Low | Confirmed | Baud selector hidden on Android (9600 kept). |
| 17 | `readSerialLoop` `finally` swallows close errors silently. | site | Info | Suspected | left (benign). |

## Reviewed, no bug found / deliberately unchanged
* RFID workflow (UID/CARD/CODE/INFO/ERR protocol, write verification, duplicate/reassign checks, `finalize_card_assignment`): **protocol unchanged; firmware unchanged.** The site only reports success after `INFO:WRITE_OK` + matching code + `finalize_card_assignment`; not modified.
* Supabase: no schema, RLS, RPC, grant, 24-hour access, rate-limit change. No migration needed → **no SQL file added.** Only the public anon key exists in the apps (`check-no-secrets.mjs`: 0 problems).
* Auto-lock still signs the user out after the configured inactivity (2–15 min) while the app is running; the 8 h persistence only covers *closed/killed and reopened* apps.

## Residual risks (not fixable from code here)
* If `login-with-id` itself rejects requests lacking an `Origin` header or checks it server-side, bridge calls would still fail — check the function source/logs.
* Kotlin/Electron code has not been compiled here (see TEST_REPORT.md).
