import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Versão: o workflow passa -PversionName=1.0.1; sem isso vale a do gradle.properties.
// versionCode = maior × 10000 + menor × 100 + correção (1.0.0 → 10000, 1.0.1 → 10001).
val appVersionName = (findProperty("versionName") as String?)?.trim()?.takeIf { it.isNotEmpty() }
    ?: (property("VERSION_NAME") as String)
val appVersionCode = appVersionName.split(".").let { parts ->
    require(parts.size == 3 && parts.all { it.toIntOrNull() != null }) { "Versão inválida: $appVersionName (use o formato 1.0.0)" }
    parts[0].toInt() * 10000 + parts[1].toInt() * 100 + parts[2].toInt()
}

// Avisos no celular (Firebase): dados do google-services.json, passados pelo workflow
// (ORG_GRADLE_PROJECT_fcmAppId etc., a partir do secret FIREBASE_GOOGLE_SERVICES_JSON). Vazios = o app
// funciona igual, só sem aviso no celular (o sino do sistema continua).
fun firebaseValue(name: String): String = ((findProperty(name) as String?) ?: "").trim().replace("\"", "")

// Chave de assinatura: só no build de release, vinda dos secrets do GitHub (nunca do repositório).
val keystorePath: String? = System.getenv("ANDROID_KEYSTORE_PATH")?.takeIf { it.isNotBlank() }

android {
    namespace = "br.com.jcsistema.campo"
    compileSdk = 36

    defaultConfig {
        applicationId = "br.com.jcsistema.campo"
        minSdk = 24
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersionName
        buildConfigField("String", "SITE_URL", "\"https://www.jcsistema.online/\"")
        buildConfigField("String", "UPDATE_URL", "\"https://www.jcsistema.online/app/versao.json\"")
        buildConfigField("String", "FCM_APP_ID", "\"${firebaseValue("fcmAppId")}\"")
        buildConfigField("String", "FCM_API_KEY", "\"${firebaseValue("fcmApiKey")}\"")
        buildConfigField("String", "FCM_PROJECT_ID", "\"${firebaseValue("fcmProjectId")}\"")
        buildConfigField("String", "FCM_SENDER_ID", "\"${firebaseValue("fcmSenderId")}\"")
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
        debug {
            // APK de teste: instala ao lado do oficial e não oferece atualização.
            // (nome "JC Sistema (teste)" em src/debug/res/values/strings.xml)
            applicationIdSuffix = ".teste"
            versionNameSuffix = "-teste"
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = false
        disable += setOf("GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion", "OldTargetApi")
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("androidx.core:core-splashscreen:1.0.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // Avisos do sistema no celular (sem o plugin google-services: ligado em PushMessaging.init).
    implementation("com.google.firebase:firebase-messaging:24.1.0")

    testImplementation("junit:junit:4.13.2")
    // org.json de verdade nos testes (no Android ele vem do sistema).
    testImplementation("org.json:json:20240303")
}
