# WebView bridge methods are called by name from JavaScript. Keep these methods
# if minification is enabled in a future release.
-keepclassmembers class com.codeglitch.medicalcard.MedicalCardAndroidBridge {
    @android.webkit.JavascriptInterface <methods>;
}
