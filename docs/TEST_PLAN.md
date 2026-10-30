# Test plan and honest results
Legend: **RAN** = executed in the authoring sandbox · **TODO** = must be run by you · **HW** = needs physical hardware.

## Executed so far (sandbox, headless Chromium + Node)
| Test | Result |
|---|---|
| Android shim vs. fake native bridge (`native/test/shim-android.test.cjs`): `navigator.serial` present; page loads with no CSP violation / page error; picker → port; 115200 rejected; `open(9600)` gives streams only after native "opened"; bytes intact across chunk splits; exact bytes written; link loss → `NetworkError` and port cleared; failed open → error, never "connected"; cancelled picker → `NotFoundError` | **RAN – 11/11 pass** (simulated bridge; **not** real Bluetooth) |
| Windows `prompt()` shim returns typed value / `null` on cancel | **RAN – pass** (simulated, outside Electron) |
| `node --check` on all JS (shims, Electron main/preload/dialog) | **RAN – pass** |
| Secret scan (`check-no-secrets.mjs`) of sources and built bundles: only `anon`-role JWTs (the site's own key) | **RAN – 0 problems** |
| `web/index.html` byte-identical to the supplied file (sha256) | **RAN – identical** |
| Workflow YAML parses | **RAN** |

## NOT run (and why)
Kotlin compile, Gradle build, APK install, Electron launch, NSIS installer, supabase-js bundling: no SDK/registry access
in the sandbox. Treat the first CI run as the first compile; expect to fix small errors.

## A. Do these first (TODO)
1. **Edge Functions from native origins:** in each app try *Register hospital*, *Sign in with Login ID*, *Reset password*.
   Failure = CORS allow-list problem (see README).
2. Email + password sign-in; wrong password message; logout; pending/suspended hospital restrictions; admin screens
   hidden from hospital users.
3. Cross-platform: create profile on Windows → open on Android; edit on Android → version conflict message when stale
   edit on Windows; unauthorized edit fails.
4. Public lookup: valid / invalid / 9 / 11 digits / letters / unknown code / 9 wrong codes → "Too many attempts";
   read-only; no hospital metadata; data cleared on leaving; no 24-h grant created (check `patient_access_grants`).
5. Security: anonymous `curl` to write RPCs and `/rest/v1/patients` (commands in `docs/LOOKUP_FEATURE_NOTES.md`);
   XSS strings in medical fields render as text; `grep -ri service_role` on unzipped APK/asar returns nothing.
6. External links open in the system browser; no in-app navigation to other sites.

## B. Android (TODO; HW where noted)
Install APK; portrait/landscape (edits survive rotation); keyboard doesn't hide focused field; back button (history
→ exit prompt); delete-profile typed-name `prompt()` works; Bluetooth permission prompt (Android 12+) and denial path;
no paired device → helper dialog; **HW** pair HC-05, connect, tap card → `CODE:` lookup; switch off reader mid-session →
"Reader error"/disconnected (never stays "connected"); reconnect; assign-card write flow; test Android 8, 11, 12+, 15.

## C. Windows (TODO; HW where noted)
Install; Start Menu + Desktop shortcut; resize to small window; prompt dialog; unplug USB reader → error state;
**HW** USB reader at 115200 and HC-05 COM port at 9600; second launch focuses the existing window; uninstall removes app.

## D. Regression
Deploy nothing new to GitHub Pages — `web/index.html` is unchanged; spot-check the live site still signs in.
