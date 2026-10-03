# Collection and release 1.3.3 — 3 October 2026

- [Open all 12 live app links, offline demos and customer APK downloads](https://rekhaastrology.in/global-apps/preview/)
- [Choose an owner inbox](https://rekhaastrology.in/global-apps/preview/control.html)
- [Download Rekha Global Admin for Android](https://rekhaastrology.in/global-apps/preview/apks/rekha-global-admin.apk)
- [Manage the source on GitHub](https://github.com/phukonbastab2-netizen/rekha/tree/main/global-apps)

The collection hub is online under the existing Rekha website and links to 12 connected customer services and private owner inboxes. It also retains separate offline sample-chat demos. Release 1.3.3 includes 12 connected customer APKs and one admin APK, versionCode 7, signed with the existing key. All 158 local tests passed. Recorded live checks and their scope are in [VERIFICATION.md](VERIFICATION.md).

The admin app opens `control.html`. Choose **Owner inbox** for a country, then sign in using that app's existing private owner password. Its **Apps** button returns to the 12-app list. Owner credentials remain outside GitHub and APKs.

Release 1.3.3 adds bounded automatic voice reconnection, receive-volume control, connected-call duration, microphone interruption guidance and Android Speaker/Phone audio choices. The call panel scrolls on small screens. Voice can pass through the app server without TURN or a direct connection between phones. The server can read relayed audio and does not record it. Video retains WebRTC with no active TURN provider. Both apps must stay open during a call. Actual phone microphone/speaker/headset audio and calls between different phone networks remain unverified. Voice effects are not voice cloning. Uploaded files are deliberately selected and scoped to their submitting app/conversation.

For historical reference, the initial offline release's 12 app pages, country configurations and public APK downloads were fetched successfully, and APK checksums matched their signed local builds. Its initial 217 GitHub file blobs matched the prepared local files. Those checks describe that release rather than proving a later download unchanged.

Initial source/APK commit: `71c7d0e4d3618f22a804c88b849a38b95d936dea`. The new `global-apps` folder was added on top of the newer Rekha customer/owner-app commit; existing repository files were preserved.

The US and UK are included, making **12 customer apps**, with 10 customer-language dictionaries across the collection. Each customer APK and the admin APK have distinct package IDs, so they can coexist on one Android device. Android 8+ is required.

The local download bundle **Android-Apps-and-Admin-v1.3.3.zip** contains all 13 signed release 1.3.3 APKs, their SHA-256 checksums and installation/call instructions. Customer APKs can update the existing installations with the same signing key; Rekha Global Admin installs as a separate app. Earlier bundles are preserved.

The 12 connected owner services are deployed. Live AI, actual payments, chart calculation, voice cloning and app-store publishing are not enabled.

Machine-readable public checks are in [PUBLIC-VERIFICATION.json](PUBLIC-VERIFICATION.json); read their recorded version and timestamp. Build and test details, including outstanding checks, are in [VERIFICATION.md](VERIFICATION.md). Changes are listed in [release notes](RELEASE-NOTES-1.3.3.md), with [two-phone test instructions](PHONE-CALL-TEST.md).
