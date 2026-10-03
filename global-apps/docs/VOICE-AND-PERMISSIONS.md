# Voice and optional device features — 1.3.2-connected

The connected owner panel offers Natural, Warm, Bright, Radio and Robot microphone effects, before or during a voice/video call. The effects alter the outgoing audio track locally; no voice identity model is trained or recorded. Both call panels disclose that admin voices may be altered. This is not voice cloning.

Voice calls can use a private same-origin WebSocket relay; video retains WebRTC and may need TURN. The TURN management credential still returns HTTP 403. Both apps must remain open. Relay audio is readable by the app server and is not recorded or end-to-end encrypted. Physical phone audio remains unverified. See [relay details](VOICE-RELAY.md). Separate offline web demos offer a local microphone/camera/file setup test.

Android requests microphone or camera permission when the corresponding feature is tapped. Customer builds permit their own live HTTPS service; the admin build permits the collection and its 12 service hosts, with the requesting origin required to match the current page. Unknown WebView resources are denied. Android file selection uses the system document picker; no broad storage, SMS, contact or gallery-reading permission is requested. Admin access covers conversations and files deliberately submitted to the connected app, not the contents of a customer's phone.

If Android permanently denies a permission, enable it in Android Settings → Apps → the app → Permissions, then retry. Android does not offer one consent that grants unrestricted phone access. A voice clone would require the speaker's explicit consent, a suitable model/service and clear disclosure; it is not enabled by this release.

Incoming calls are checked while the customer chat stays open. Call cleanup keeps the listener active, cancellation rejects late permission results, and an established call that remains disconnected ends after a 15-second recovery deadline. Hidden pages pause call polling and resume when visible. A missing participant also expires the server's active call after two minutes. If remote playback is blocked, tap Play call audio to retry. Android 1.3.1 includes MODIFY_AUDIO_SETTINGS for communication routing; it adds no runtime approval dialog. These changes do not add background ringing or guarantee network connectivity. See [real-phone testing](PHONE-CALL-TEST.md).

Chat polling prevents overlapping refreshes and sends read receipts only when a newer message arrives. No measured speed claim is made.
