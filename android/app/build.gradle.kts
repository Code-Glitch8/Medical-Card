import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Optional release signing. NOTHING secret is stored in the repo: create android/keystore.properties locally
// (or write the same file from CI secrets) with storeFile, storePassword, keyAlias, keyPassword.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.medicalcard.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.medicalcard.app"
        minSdk = 26          // Android 8.0: adaptive icons, simpler Bluetooth-permission handling
        targetSdk = 35       // Android 15
        versionCode = 2
        versionName = "1.1.0"
    }

    signingConfigs {
        if (keystoreProps.containsKey("storeFile")) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfigs.findByName("release")?.let { signingConfig = it }   // stays unsigned if no keystore supplied
        }
        debug { applicationIdSuffix = ".debug"; versionNameSuffix = "-debug" }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
}

// Fail early with a clear message instead of shipping an app with an empty UI.
tasks.register("verifyWebAssets") {
    doLast {
        if (!file("src/main/assets/index.html").exists())
            throw GradleException("Web bundle missing. From the repo root run: cd tools && npm install && node build-web.mjs android")
    }
}
tasks.matching { it.name == "preBuild" }.configureEach { dependsOn("verifyWebAssets") }
