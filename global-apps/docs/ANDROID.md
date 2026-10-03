# Build the 12 Android previews

The source has 12 product flavours and distinct package IDs. Release APKs require your persistent signing key. Use JDK 17, Android SDK platform 36 / build-tools 35.0.0, and Gradle 8.11.1. These versions were used for the initial verified builds. No external Android libraries are required.

Set environment variables:

```text
JAVA_HOME=<JDK 17 directory>
ANDROID_HOME=<Android SDK directory>
GRADLE_BIN=<Gradle executable>
SIGNING_DIR=<private signing directory outside this repository>
```

The signing directory must contain `global-preview.jks` (alias `global-preview`) and `keystore-password.txt`. Keep both private. The build script deliberately refuses to generate a replacement key, because changing it breaks installed-app updates.

```sh
node scripts/build.mjs
node scripts/android.mjs
```

The outputs are `dist/apks/<app-id>.apk`. The script checks APK v2/v3 signatures. The generated apps use only the INTERNET permission; camera, contacts, location, SMS and microphone access are not requested in these offline builds.

The initial private signing key is stored in the creating workspace's `work/android-signing/` folder, outside the deliverables and GitHub. Back it up securely before moving to another machine. A plain copied APK is not a backup of the signing key.

Runtime device validation remains outstanding. Desktop-browser tests do not prove Android WebView rendering, font coverage, accessibility, install behaviour or device-specific compatibility.
