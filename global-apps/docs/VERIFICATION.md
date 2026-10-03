# Verification — 3 October 2026

## Update 1.1.0

- The original 15 checks passed after the permission and call changes; an additional audio-routing/preset/cleanup test passed. Final generated JavaScript syntax checks passed for 91 distinct files.
- Browser checks confirmed the new feature dialog and selectable admin effect presets, with no browser console errors. Microphone capture and live two-device calls were not exercised.
- All 12 APKs rebuilt and passed v2/v3 signature, package, version, allowed-permission and expanded bundled-asset checks. Public downloads matched the rebuilt SHA-256 hashes.
- Reduced overlapping polling and repeated read receipts; no measured latency benchmark was run.

## Initial baseline checks

- Final test run: **15 tests passed, 0 failed**. Covers all 12 country bundles, supported locale validation and translated welcome messages, adult/consent checks, origin rejection, owner authentication, cross-customer isolation, duplicate-message handling, manual replies, localized sample replies, private notes and conversation deletion.
- **89 distinct generated JavaScript files** passed syntax validation, including customer screens, owner screens and server bundles.
- All **12 default-language browser journeys** passed: landing → name/DOB/consent → chat → sample reply → delete → cleared landing. An HTML/script string in a customer message rendered as text.
- The locally running connected Luna Harbor service was verified in two browser tabs: customer signup/message → authenticated owner inbox → owner reply → customer receives reply after reload.
- Thai, Sinhala and Japanese layouts were visually inspected inside 390-pixel-wide browser frames. These rendered legibly without visible horizontal overflow in the inspected landing views.
- All **12 Android APKs** built successfully, have distinct package IDs, and passed **v2/v3 signature verification**. Each APK's core embedded web files exactly matched its final country web build. Checksums and package metadata are in `preview/APK-VERIFICATION.json` and `preview/SHA256SUMS.txt`.
- No customer records, original testimonials, existing production bindings, credentials, owner passwords or signing keys were copied into the upload set.

A first backend run encountered one transient local connection reset for Sri Lanka. Its targeted rerun passed; the final full 15-test run also passed. Browser testing caught an unsafe branding substitution in a native-bridge identifier on the owner page; it was corrected and all generated JavaScript was then checked.

## Not verified or not enabled

- New production hosting, domain routing, live AI/provider replies, real payments and app-store publication.
- Physical Android or emulator runtime behaviour. No Android device was connected during this build.
- Native-speaker approval, trademark clearance or practitioner qualifications.
- Astronomical chart calculation, saju/BaZi calculations, lunar-calendar conversion or auspicious-time calculation; none are implemented.
- Real cross-network audio/video calls, TURN traversal, instant push or background ringing.

The APKs and static web collection are **offline previews**. The separately generated backend and private owner panel were tested locally; their source presence in GitHub does not establish a deployed customer service.
