# Required GitHub Release setup for the supplied Windows app ZIP

The Windows packaging job downloads the original complete application ZIP from a **published GitHub Release**. A normal repository file, a Git tag by itself, or an unpublished draft release is not sufficient.

## Create the required release

1. Open `https://github.com/Code-Glitch8/Medical-Card/releases/new` while signed in.
2. In **Choose a tag**, enter exactly `windows-bundle-v1` and create the new tag on the repository's `main` branch.
3. Set the release title to `MediVault Windows Base App Bundle`.
4. Upload the original file named exactly `MedVault.Secure.Medical.Records.zip`.
5. Publish the release. Do not leave it as a draft.
6. Open `https://github.com/Code-Glitch8/Medical-Card/releases/tag/windows-bundle-v1` and verify that the ZIP appears under **Assets**.

If you used a different tag or GitHub shows a different asset filename, enter those exact values in the workflow's `windows_bundle_tag` and `windows_bundle_asset` inputs when running the workflow.

## What the updated workflow checks

- Whether a published release exists for the supplied tag.
- Whether the exact asset filename exists in that release.
- Which release tags or asset filenames are visible if something is missing.
- Whether the downloaded file is a valid ZIP before extraction.

After a successful download, the workflow verifies that the complete Electron application folder contains the original EXE, `resources/app.asar`, Chromium resources, and locales before building the installer.
