# Delivery status — 3 October 2026

- [Open all 12 web apps and APK downloads](https://rekhaastrology.in/global-apps/preview/)
- [Open owner source/control links](https://rekhaastrology.in/global-apps/preview/control.html)
- [Manage the source on GitHub](https://github.com/phukonbastab2-netizen/rekha/tree/main/global-apps)

The collection is online under the existing Rekha website. It contains **offline/sample-chat previews**, not a deployed private-inbox service. All 12 public app pages, country configuration files and APK downloads were fetched successfully. Every public APK checksum matched the signed local build. The initial 217 GitHub file blobs matched the prepared local files exactly.

Initial source/APK commit: `71c7d0e4d3618f22a804c88b849a38b95d936dea`. The new `global-apps` folder was added on top of the newer Rekha customer/owner-app commit; existing repository files were preserved.

The US and UK are included, making **12 apps**, with 10 customer-language dictionaries across the collection. Each APK has a distinct package ID, so the country previews can coexist on one Android device. Android 8+ is required.

The connected owner services have been tested locally and must still be deployed separately. Live AI, actual payments, chart calculation and app-store publishing are not enabled. These boundaries are displayed in the preview itself.

Machine-readable public checks are in [PUBLIC-VERIFICATION.json](PUBLIC-VERIFICATION.json). Build and test details are in [VERIFICATION.md](VERIFICATION.md).
