# Release 1.3.2-connected — 3 October 2026

- All **117 local tests passed, 0 failed** in the final release run. Coverage includes country branding, bounded voice-effect startup and resume, relay framing/resampling and buffer limits, microphone mute and stream ownership, peer loss, call lifecycle cleanup and existing authentication/isolation checks. The generated JavaScript syntax check also passed. This is local implementation evidence, not phone-media verification.
- A browser decoded generated audio in **both directions through the real Luna Harbor Cloudflare WebSocket voice relay**. Both decoded RMS readings exceeded 0.17; all five effects, mute/unmute, AudioContext pause/resume, server hang-up and input-resource cleanup passed, with no relay errors. The two production sockets carried nonzero PCM frame counts in both directions. A private localhost bridge kept production session cookies inside its server process. The fixture used generated tones, no microphone capture and no physical speaker output. Evidence: `preview/BROWSER-VOICE-RELAY-VERIFICATION.json`.
- All **13 signed APKs** passed package, version, compiled-URL, permission, asset and signature verification. They use Android versionCode **6 / 1.3.2-connected**, Android 8 or later, and the existing signing certificate. Customer embedded assets match their current generated files. The separate `in.rekha.global.owner` APK's v2/v3 signer matches the customer signer; its exact hub/12-service origin allowlist and native Apps action passed inspection. Evidence: `preview/APK-VERIFICATION.json`, `preview/ADMIN-APK-VERIFICATION.json` and `preview/SHA256SUMS.txt`.
- APK permissions remain exactly **INTERNET, MODIFY_AUDIO_SETTINGS, RECORD_AUDIO and CAMERA**. The audio-routing permission is a normal manifest permission; microphone and camera still use their platform permission prompts. No SMS, contact or broad gallery permission is included.
- No physical Android device is attached and no emulator is configured. **Actual phone microphone/speaker audio, cross-network phone calls, device permission behavior, background ringing and video connectivity remain unverified.** The browser fixture proves decoded generated audio over the deployed private voice relay, while physical-device checks remain outstanding. TURN remains unconfigured; this voice transport uses the app's private WebSocket relay.
- All **12 live services** passed authenticated HTTPS setup, same-origin WSS admission, generated PCM delivery in both directions, no self-echo, hang-up and ended-call reconnect denial. Unauthenticated, foreign-origin and unrelated-customer connections were rejected. All disposable chats and owner sessions were cleaned up. Three initial cold-connection timeouts passed a targeted rerun with a longer bounded verification timeout. Evidence: `preview/LIVE-VOICE-RELAY-VERIFICATION.json`. This verifies generated audio frames over the production backend, not phone microphones or speakers.
- All **13 public APK downloads** matched the signed 1.3.2 builds by SHA-256 and byte count. All **12 live services** report `global-1.3.2-connected` and serve call, relay, worklet and voice-effect assets identical to the prepared source. The control centre links to every owner inbox and the admin APK. Evidence: `preview/PUBLIC-VERIFICATION.json` and `preview/PUBLIC-SERVICES-VERIFICATION.json`.

## Historical release 1.3.1 verification

- All **49 local tests passed**, including blocked playback recovery and stale asynchronous results, private two-party call leases, tenant isolation and the existing messaging/relay checks.
- All **13 signed APKs** passed independent package, version, compiled-URL, allowed-permission and signing checks. Customer embedded assets match the new generated files. Android versionCode 5 / 1.3.1-connected uses the original signing certificate.
- APK permissions are exactly INTERNET, MODIFY_AUDIO_SETTINGS, RECORD_AUDIO and CAMERA. The added permission supports communication-audio routing; no new runtime consent dialog or broad phone-data permission was added.
- All **13 public APK downloads** matched the signed builds by SHA-256 and byte count. All **12 live services** report `global-1.3.1-connected`, serve the prepared call-client code and have their owner links in the control centre. Evidence: `preview/PUBLIC-VERIFICATION.json` and `preview/PUBLIC-SERVICES-VERIFICATION.json`.
- All **12 live call flows** passed owner authentication, incoming-call discovery, accept, signal delivery, private heartbeat filtering, hang-up and a second call initiated from the other side. Disposable conversations were deleted. These HTTPS signaling checks do not test microphone media or audible phone calls. Evidence: `preview/LIVE-CALL-VERIFICATION.json`.
- No physical Android device is attached and no emulator is configured. Real-phone audio, cross-network media, TURN traversal and background ringing are not verified. The current Cloudflare credential still rejects TURN management, and the dashboard requires sign-in. No relay was activated.

## Historical release 1.3.0 verification

- All **37 local tests passed**. Client lifecycle tests cover idle incoming-call discovery, answer signaling, visibility polling, continued listening after cleanup, delayed permission cancellation, late creation-response cleanup, bounded disconnection recovery and fresh per-call relay configuration with processed admin audio.
- **13 APKs were built**: 12 customer apps and one Rekha Global Admin app, using versionCode 4 / 1.3.0-connected. The build signs them with the persistent key and checks v2/v3 signatures.
- The admin APK package is `in.rekha.global.owner`. It starts at the collection's `control.html`; customer packages retain their own service URLs. The owner chooses a country's inbox and uses its existing private password.
- No relay was activated. Cloudflare TURN management returned HTTP 403 for the available credential. Source supports optional short-lived relay credentials for a current authenticated call; deployed fallback remains STUN-only.
- A silent browser test passed all 20 checks using generated tones, the real voice-effects module and two local WebRTC peers. It verified nonzero decoded audio for all five presets, filter/level differences, mute/unmute and complete cleanup without microphone capture. This does not establish device audio quality or cross-network calls. Evidence: `preview/BROWSER-AUDIO-VERIFICATION.json`.
- All customer APK packages, assets, URLs and allowed permissions passed independent inspection. The admin APK passed package, version, origin allowlist and permission inspection; its v2/v3 signatures match the customer signing certificate. Evidence: `preview/APK-VERIFICATION.json` and `preview/ADMIN-APK-VERIFICATION.json`.
- Public release 1.3 readback passed for all 13 APK downloads: each byte count and SHA-256 matches its signed build. All 12 live services report `global-1.3.0-connected`, and their served call-client code matches the prepared source. The control centre contains the admin download and all owner links. Evidence: `preview/PUBLIC-VERIFICATION.json` and `preview/PUBLIC-SERVICES-VERIFICATION.json`.
- All 12 updated services passed real HTTPS signup, owner authentication, customer message, owner reply and customer receipt, private file upload/download, denial to another customer, and call create/accept/signal/end checks. The test used disposable conversations. Evidence: `preview/LIVE-BACKEND-VERIFICATION.json`.
- Physical Android permission behavior, audible two-device calls and cross-network call connectivity remain unverified. Foreground polling does not provide background ringing or push notifications.
- Voice effects remain local microphone processing, not voice cloning. File uploads remain user-selected and scoped to their app/conversation; broad phone-data access is not implemented. AI and real payments remain disabled.

## Historical release 1.2 verification

- All 18 local tests passed, including fixed namespace isolation.
- All 12 deployed services passed real HTTPS customer signup, owner authentication, customer message → owner reply → customer receipt, private attachment upload/download and cross-customer denial, and call create/accept/signal/end checks. Disposable test conversations and uploads were removed.
- A deployed customer browser journey reached the connected conversation with Voice and Video controls; no console errors were reported.
- All 12 versionCode 3 / 1.2.0-connected APKs passed signature, package, compiled live URL, allowed-permission and embedded-asset checks. All public APK hashes matched.
- Physical phone permission behavior and two-device audio/video calls remain unverified. TURN is not configured. AI, real payments and voice cloning remain disabled.
- Source readback matched all 242 text files; existing repository files outside global-apps were preserved.

The older baseline records below describe the versions tested at the time; they do not establish release 1.3 public-download or device behavior.

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

- At the initial offline baseline: new production hosting and domain routing. The later connected services are recorded separately above. Live AI/provider replies, real payments and app-store publication remain disabled or outstanding.
- Physical Android or emulator runtime behaviour. No Android device was connected during this build.
- Native-speaker approval, trademark clearance or practitioner qualifications.
- Astronomical chart calculation, saju/BaZi calculations, lunar-calendar conversion or auspicious-time calculation; none are implemented.
- Real cross-network audio/video calls, TURN traversal, instant push or background ringing.

The initial APKs and static web collection were offline previews. Current customer APKs load the deployed connected services; separate offline web demos remain available. Source presence or a successful local test alone does not establish a public deployment or a successful device call.
