// AGP 9 compiles Kotlin itself (built-in Kotlin), so no Kotlin plugin is applied.
// The app has no library dependencies: Android's own HTTP, JSON, audio and WebView APIs are enough.
plugins {
    id("com.android.application")
}

android {
    namespace = "app.chumi.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.chumi.android"
        // Android 11+: window insets by type and the microphone foreground-service type need API 30.
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
