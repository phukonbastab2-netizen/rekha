# Voice and optional device features — 1.3.0-connected

The connected owner panel offers Natural, Warm, Bright, Radio and Robot microphone effects, before or during a WebRTC call. The effects alter the outgoing audio track locally; no voice identity model is trained or recorded. Both call panels disclose that admin voices may be altered. This is not voice cloning.

The connected services are deployed, and real calls require two reachable clients with both app pages open. A TURN relay may be required on restrictive networks. No relay has been activated: the current credential received HTTP 403 from Cloudflare TURN management. Optional short-lived TURN support is present in source, but signaling checks, local tests and builds do not establish a successful two-device call. Separate offline web demos offer a local microphone/camera/file setup test.

Android requests microphone or camera permission when the corresponding feature is tapped. Customer builds permit their own live HTTPS service; the admin build permits the collection and its 12 service hosts, with the requesting origin required to match the current page. Unknown WebView resources are denied. Android file selection uses the system document picker; no broad storage, SMS, contact or gallery-reading permission is requested. Admin access covers conversations and files deliberately submitted to the connected app, not the contents of a customer's phone.

If Android permanently denies a permission, enable it in Android Settings → Apps → the app → Permissions, then retry. Android does not offer one consent that grants unrestricted phone access. A voice clone would require the speaker's explicit consent, a suitable model/service and clear disclosure; it is not enabled by this release.

Incoming calls are checked while the customer chat stays open. Call cleanup keeps the listener active, cancellation rejects late permission results, and an established call that remains disconnected ends after a 15-second recovery deadline. Hidden pages pause call polling and resume when visible. These changes do not add background ringing or guarantee network connectivity.

Chat polling prevents overlapping refreshes and sends read receipts only when a newer message arrives. No measured speed claim is made.
