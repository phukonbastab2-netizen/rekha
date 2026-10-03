# Release 1.3.0-connected

Android versionCode 4. Includes 12 customer APKs and one new **Rekha Global Admin** APK. Existing customer package IDs and the persistent signing certificate are preserved.

## Owner app

[Install the admin APK](https://rekhaastrology.in/global-apps/preview/apks/rekha-global-admin.apk) or [open the control centre](https://rekhaastrology.in/global-apps/preview/control.html). The admin app starts at `control.html`, showing the 12 country apps. Choose a country's **Owner inbox**, then enter that app's existing private owner password. Tap the native **Apps** button to choose another inbox. Each service authenticates its own session; the APK contains no owner credentials.

The owner can reply to conversations and view files customers deliberately submit to that app. Customer SMS, contacts and the rest of their gallery remain outside the app's access. File picking and uploaded-object access remain scoped to the requesting page and submitting conversation.

## Calls and voice effects

- The customer checks for incoming calls while the chat stays open, approximately every five seconds when idle. An active call polls approximately every 1.5 seconds. Hidden pages pause polling and resume when visible.
- Declining, ending or cleaning up a call keeps the incoming listener available for the next call.
- Late microphone permission results after cancellation do not create or accept a call, and their captured tracks are stopped. A call creation response arriving after cancellation is ended on the server.
- An established call that disconnects gets up to 15 seconds to recover. Recovery cancels the deadline; otherwise the call ends and releases its media resources.
- Each call fetches fresh connection settings using its own call ID. Optional Cloudflare TURN source support issues short-lived credentials only for authenticated participants in a current call.
- Natural, Warm, Bright, Radio and Robot effects process the owner's outgoing microphone audio locally. Both call panels disclose altered voices. These effects do not clone a person's voice.

No TURN relay was activated: the available Cloudflare credential received HTTP 403 from TURN management. The default remains STUN-only. Both app pages must stay open, and restrictive networks may prevent a call from connecting. Background ringing and push notifications are not implemented. These improvements do not guarantee calls on every network.

## Validation and remaining checks

All 37 local tests passed and all 13 APKs built. Seven call-client lifecycle tests exercise incoming discovery, answer signaling, remote end, visibility, cancellation races, disconnection recovery and fresh relay configuration with the selected processed audio track. The existing voice-effects routing/preset/cleanup test also passes.

The silent synthetic browser test passed all 20 checks: local WebRTC audio delivery for all five presets, frequency/level differences, mute/unmute and cleanup. It used generated tones without microphone capture. All 13 public APK downloads match the signed builds, and all 12 live services report the new version and serve the current call client. Physical phone permissions, Android runtime behavior, audible two-device calls and cross-network connectivity remain unverified. See [VERIFICATION.md](VERIFICATION.md) for the recorded checks and their limits.

All 12 updated services also passed live signup, authenticated owner replies, private media isolation and call signaling checks. Customer replies remain manual. Live AI, actual payments, voice cloning and astronomical chart calculations are not enabled.
