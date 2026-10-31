# MediVault GitHub build overlay

This package changes the existing GitHub Actions workflow so one manual run produces:

- an Android debug APK (and a signed release APK if the repository signing secrets are configured);
- a Windows Setup EXE that installs the exact Windows application supplied in `MedVault Secure Medical Records.zip`.

## Important: upload the Windows app ZIP as a GitHub Release asset first

The supplied ZIP is about 136 MB. Do not commit it into the normal Git repository: GitHub blocks regular Git files over 100 MiB. GitHub Releases support individual assets smaller than 2 GiB.

1. Open the `Code-Glitch8/Medical-Card` repository.
2. Open **Releases** and choose **Draft a new release**.
3. Create the tag `windows-bundle-v1`.
4. Set the title to `MediVault Windows Base App Bundle`.
5. Mark it as a **pre-release** so it is kept separate from the public app release.
6. Attach the original file without renaming it: `MedVault Secure Medical Records.zip`.
7. Publish the release.

The workflow expects that exact tag and asset filename by default. If you use another tag or filename, change the inputs when you run the workflow.

## Add the files in this ZIP to the repository

Extract this ZIP into the root of the existing `Code-Glitch8/Medical-Card` repository and merge/replace files while preserving folders.

Files included:
- `.github/workflows/build-apps.yml`
- `installer/windows/MedVault.iss`

Commit and push the changes to the repository's default branch.

## Run the build

1. Open the repository's **Actions** tab.
2. Select **Build Android APK and Windows installer**.
3. Click **Run workflow**.
4. Leave the default Windows bundle inputs unless you used a different release tag or asset filename.
5. Start the workflow.

When complete, download these artifacts from the run:
- `MedVault-Secure-Medical-Records-android-debug`
- `MedVault-Secure-Medical-Records-android-release` (only when signing secrets are configured)
- `MedVault-Secure-Medical-Records-windows-installer`

The Windows artifact contains `MedVault-Secure-Medical-Records-Setup.exe` and `Windows-Bundle-Source.txt`. The text file records the SHA-256 hash of the exact original executable that was packaged.

## What this does and does not do

- The Windows installer copies the complete supplied Windows app folder, including the original `MedVault Secure Medical Records.exe`, `resources/app.asar`, DLLs and locales. It does not rebuild or modify the Windows EXE.
- The Android APK is built separately from the Android/Kotlin project and the shared web app source in the repository. A Windows `.exe` cannot be converted into an Android APK.
- The workflow does not change Supabase data, credentials, RFID behavior or Bluetooth behavior.
- A production-signed APK requires the repository secrets documented in `BUILD_ANDROID_FROM_SOURCE.md`. Without those secrets the debug APK is still generated.
