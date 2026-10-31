# MedVault UI layout fix files

This is a small source overlay for the existing GitHub repository. It is **not** a replacement for the entire repository.

## Apply these changes

1. Extract this ZIP into the root of your existing `Code-Glitch8/Medical-Card` checkout.
2. Replace these two files when asked:
   - `native/android.css`
   - `native/theme.css`
3. Open `android/app/src/main/kotlin/com/medicalcard/app/MainActivity.kt` and make the one-line inset change shown in `MainActivity_Inset_Fix.txt`.
4. Commit and push to GitHub.
5. Run **Actions → Build Android APK and Windows installer**.

Alternatively, apply `MedVault_UI_Layout_Fixes.patch` from the repository root with `git apply MedVault_UI_Layout_Fixes.patch`. Review the changes before committing.

The build workflow regenerates `android/app/src/main/assets/` and `windows/app-web/` using `tools/build-web.mjs`. Do not manually replace those generated files.

## Changes

- Adds more top and bottom breathing room on Android screens.
- Accounts for Android display cutouts/notches in addition to system bars and the keyboard.
- Allows long hospital names to wrap instead of being clipped in the top bar.
- Removes sticky Android form buttons that could overlap the final contact telephone field or the note beneath Login ID / official email.
- Adds min-width and wrapping rules to form fields, labels, notices, headings and buttons to reduce overlap and horizontal overflow elsewhere.
- Keeps horizontal scrolling within table wrappers.

No Supabase database/schema/RPC/RLS/Edge Function logic, RFID code, Bluetooth logic, or Content Security Policy was changed. `unsafe-eval` was not added.

## Checks performed

- Android and Windows web bundles were generated successfully with `tools/build-web.mjs`.
- The no-secrets scan reported `problems: 0`.
- JavaScript syntax checks passed for the native shims and tests.
- A full Android Gradle build and real-device visual test were not run here because the Android SDK is not installed in this environment. Verify the APK and EXE through GitHub Actions, then check the UI on the target phone.
