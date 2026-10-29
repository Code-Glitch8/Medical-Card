# Medical Card Android project

This is a Kotlin Android WebView shell for the supplied Medical Card UI. The web UI is bundled under `app/src/main/assets/www/`; it still uses the existing Supabase project and public lookup RPC. The `MedicalCardAndroid` bridge provides a restricted Bluetooth Classic SPP serial interface for already-paired HC-05 devices.

## Build a debug APK

Requirements: Android Studio with Android SDK Platform 36 and Build Tools installed, JDK 17+, and an internet connection for Gradle dependencies.

1. Open this `android` folder in Android Studio.
2. Wait for Gradle Sync; accept the SDK installation prompt for API 36 if shown.
3. Select **Build → Build Bundle(s) / APK(s) → Build APK(s)** for a debug build.
4. The debug APK is normally produced at `app/build/outputs/apk/debug/app-debug.apk`.
5. For a release artifact, select **Build → Generate Signed Bundle / APK → APK** and create/use your own private signing key. After Android Studio generates the signed release APK, rename that generated file to `MedicalCard.apk`. Never commit the signing key.

Command line (after SDK is installed and configured):

```bat
gradlew.bat assembleDebug
```

The included `gradlew.bat` bootstrap script downloads the pinned Gradle 8.13 distribution from the official Gradle distribution site if it is not already cached, then runs the build. The first run requires internet access.

Release builds can be created with `gradlew.bat assembleRelease`, but release signing must be configured locally in a private Gradle properties file or Android Studio; do not put passwords or keystore files in this repository.

## Bluetooth / HC-05

1. Pair the HC-05 from Android Settings before opening the app.
2. Grant Nearby devices/Bluetooth permission when requested.
3. In the app, choose **Connect reader**, set the baud-rate dropdown to **9600 baud** for the HC-05 workflow, then select the paired module.
4. Close other apps that might be connected to the same HC-05.
5. Use a test card and test profile first. Real hardware has not been tested in this build environment.

The Bluetooth serial bridge uses the Serial Port Profile UUID and carries the same newline-delimited protocol as the supplied Arduino sketch. The baud-rate choice controls the expected UI mode; Bluetooth Classic SPP itself does not configure the Arduino's SoftwareSerial UART baud.

## App behavior and limitations

- Supabase operations need internet connectivity.
- Public lookup uses `public_lookup_patient_by_code`; it does not query `public.patients` directly.
- The native bridge lists paired devices only; pairing/discovery is done in Android Settings.
- Build/test status is documented in the root README. An APK has not been generated in this environment because the Android SDK is not installed here.
