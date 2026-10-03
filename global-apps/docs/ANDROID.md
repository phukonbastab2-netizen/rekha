# Android 1.3.0-connected

Version 1.3.0-connected (versionCode 4) includes 12 customer APKs and one **Rekha Global Admin** APK. Customer apps load their own live HTTPS services and preserve existing package IDs and the signing key. The new admin package is `in.rekha.global.owner`; it opens [the owner control centre](https://rekhaastrology.in/global-apps/preview/control.html), where the owner chooses one of 12 inboxes and signs in with that app's existing private password. Its **Apps** button returns to the collection list. No password is bundled in an APK.

All 13 APKs were built locally. Runtime device validation remains outstanding; builds and signature checks do not establish phone permission behavior or a successful call. See [release notes](RELEASE-NOTES-1.3.md) and [verification](VERIFICATION.md).

## Build customer and admin APKs

The source has 12 customer product flavours and one owner flavour with distinct package IDs. Release APKs require your persistent signing key. Use JDK 17, Android SDK platform 36 / build-tools 35.0.0, and Gradle 8.11.1. No external Android libraries are required.

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

The outputs are `dist/apks/<app-id>.apk` plus `dist/apks/rekha-global-admin.apk`. The script checks APK v2/v3 signatures. APK permissions are INTERNET, RECORD_AUDIO and CAMERA. Microphone and camera requests begin after a feature tap, and grants are restricted to the current permitted HTTPS origin. File selection uses the system picker and returns only the selected file to its requesting page; no SMS, contacts, location or broad gallery permission is requested. See [voice and permission details](VOICE-AND-PERMISSIONS.md).

The initial private signing key is stored in the creating workspace's `work/android-signing/` folder, outside the deliverables and GitHub. Back it up securely before moving to another machine. A plain copied APK is not a backup of the signing key.

Runtime device validation remains outstanding. Desktop-browser tests do not prove Android WebView rendering, font coverage, accessibility, install behaviour or device-specific compatibility.
