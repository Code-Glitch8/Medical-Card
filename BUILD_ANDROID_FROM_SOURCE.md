# Build the Android app from source (no Android Studio needed)
1. Create a private GitHub repository and upload the contents of MedVault_Android_Source.zip (keep the .github folder).
2. Repository > Actions > "Build Android APK and Windows installer" > Run workflow.
3. When it finishes, download the artifact `MedVault-Secure-Medical-Records-android-debug` (a working, installable APK built from this hardened source; package com.medicalcard.app.debug, signed with the standard Android debug key).
4. For a production release add repository secrets ANDROID_KEYSTORE_B64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD (your original keystore) and re-run; artifact `MedVault-Secure-Medical-Records-release` has id com.medicalcard.app.
5. Uninstall any older MedVault/Medical Card APK first if install is refused (different signing key).
If the app still cannot start, it now shows an on-screen error message (exception type) instead of closing; send me that text.
