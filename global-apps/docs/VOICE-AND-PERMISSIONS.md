# Voice and optional device features — 1.1.0

The connected owner panel offers Natural, Warm, Bright, Radio and Robot microphone effects, before or during a WebRTC call. The effects alter the outgoing audio track locally; no voice identity model is trained or recorded. Both call panels disclose that admin voices may be altered. This is not voice cloning.

Real calls require deployment of the connected backend and two reachable clients. A TURN relay may be required on restrictive networks. The public previews remain offline sample chats, with a local microphone/camera/file setup test. Tests and builds do not establish device permission behavior or a successful two-device call.

Android requests microphone or camera permission when the corresponding feature is tapped. Only the bundled secure origin can request these resources. Unknown WebView resources are denied. Android file selection uses the system document picker; no broad storage, SMS, contact or gallery-reading permission is requested. Admin access covers conversations and files deliberately submitted to the connected app, not the contents of a customer's phone.

If Android permanently denies a permission, enable it in Android Settings → Apps → the app → Permissions, then retry. Android does not offer one consent that grants unrestricted phone access. A voice clone would require the speaker's explicit consent, a suitable model/service and clear disclosure; it is not enabled by this release.

Polling now prevents overlapping chat refreshes and sends read receipts only when a newer message arrives. No measured speed claim is made.
