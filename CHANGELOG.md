# Changelog

## 1.1.0 (Android versionCode 2 / Windows 1.1.0)
Package IDs unchanged (`com.medicalcard.app`, `com.medicalcard.desktop`). Backend untouched.

### Fixed
* Login ID + password now works in both apps (native HTTPS bridge for the three Edge Functions).
* Session persists across app restarts (8 h idle limit); Sign out clears it.
* Android Bluetooth: single-connection state machine, 15 s timeout, SPP secure→insecure retry, ACL/adapter-off detection, permission-denied and permanent-denied flows with *Open app settings*, "turn on Bluetooth" prompt, progress + cancel dialog, HC-05 highlighted, bounded buffers, clean shutdown.
* Serial line buffer capped (site bundle patch at build time; `web/index.html` unchanged).
* Android Back button is page-aware.

### Added
* Dark-navy/blue design language; Android bottom navigation, sticky action bars, keyboard-aware layout, card-style tables; Windows sidebar (icon rail when narrow, bottom bar when very narrow), custom title bar, keyboard shortcuts (Ctrl+1…9 sections, Ctrl+K first field, Ctrl+L sign out, Ctrl+Shift+R reader, Esc back, Ctrl+0/+/- zoom), dark/light parity.
* Startup animation (≈2 s, once per launch, reduced-motion aware): native splash (Android 12+ system splash / earlier window background) → in-app logo pulse, "MEDICAL CARD / EMERGENCY MEDICAL RECORDS", loader → login. Windows opens on navy (no white window).
* New logo/icons; CI now also runs the browser tests; `tools/vendor/supabase.js` offline fallback (pinned 2.45.4).
