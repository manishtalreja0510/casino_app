plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.casinoapp.casino_app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.casinoapp.casino_app"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // Three flavors matching the backend environments (ADR-012). The applicationId suffix
    // lets dev, staging and prod install side by side on one device, so a tester can never
    // confuse which build — and therefore which backend — they are looking at.
    flavorDimensions += "environment"

    productFlavors {
        create("dev") {
            dimension = "environment"
            applicationIdSuffix = ".dev"
            resValue("string", "app_name", "casino_app dev")
        }
        create("staging") {
            dimension = "environment"
            applicationIdSuffix = ".stg"
            resValue("string", "app_name", "casino_app staging")
        }
        create("prod") {
            dimension = "environment"
            resValue("string", "app_name", "casino_app")
        }
    }

    buildTypes {
        release {
            // Release signing keys are NEVER in the repository (rule 14). CI/the release
            // pipeline supplies them; the prod key is offline/HSM-held critical infrastructure
            // (docs/07-operations/runbooks.md §d). Falling back to the debug key here keeps
            // `flutter run --release` working locally while guaranteeing an unsigned-by-debug
            // artifact can never be mistaken for a distributable build.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
