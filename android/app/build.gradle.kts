plugins {
    id("com.android.application")
}

val startUrl = providers.gradleProperty("JARVIS_START_URL")
    .orElse("https://vamshi-vfx.github.io/jarvis-mobile-edition/frontend/")
val backendUrl = providers.gradleProperty("JARVIS_BACKEND_URL")
    .orElse("https://ev-pa-backend.onrender.com")

android {
    namespace = "com.growthos.jarvis"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.growthos.jarvis"
        minSdk = 26
        targetSdk = 35
        versionCode = 5
        versionName = "0.5.0"
        buildConfigField("String", "JARVIS_START_URL", "\"${startUrl.get().replace("\\", "\\\\").replace("\"", "\\\"")}\"")
        buildConfigField("String", "JARVIS_BACKEND_URL", "\"${backendUrl.get().replace("\\", "\\\\").replace("\"", "\\\"")}\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
