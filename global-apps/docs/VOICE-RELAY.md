# Private voice relay

Release 1.3.2 includes an authenticated voice-only WebSocket relay in each country app. It lets voice calls use the existing HTTPS service without requiring a direct peer connection or a TURN key. Video calls continue to use WebRTC and may still require TURN. Ordinary telephone-number dialing and background ringing are not included.

The customer and owner must start and accept the same voice call and grant microphone permission. The browser sends mono 16 kHz, 16-bit PCM audio in 40 ms batches over same-origin WSS. A per-call Durable Object forwards each batch only to the other authenticated role. There is one customer connection and one owner connection per call. The owner effects process the microphone before forwarding.

Audio is transmitted over encrypted connections to the app server. The server can read forwarded audio; this path is not end-to-end encrypted. The implementation does not record audio or write audio frames to D1, R2, logs or Durable Object storage. The relay stores only minimal call lifecycle metadata, checks call authorization against D1 at least every five seconds while forwarding, and closes on revocation, expiry or authenticated hang-up.

Each country Worker has its own SQLite Durable Object namespace, bound as `CALL_AUDIO_RELAY` with class `CallAudioRelay`. Generated configs include migration `voice-relay-v1`. The connected deployment wraps the object's database access in the same fixed app namespace as the HTTP routes. Keep those bindings, migrations and namespace ordering when rebuilding; preserve existing database/storage bindings and owner secrets.

The relay bounds frame sizes, frame rates and playback buffering. Audio startup has a timeout; interrupted processing provides explicit recovery controls. Raw microphone audio is used only for Natural voice or after the owner explicitly chooses Use Natural. An altered voice never silently falls back to a natural voice.

SQLite Durable Objects are available on Workers Free. Usage limits and any existing account billing remain shared across applications. See [Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and [WebSocket guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/). This release does not upgrade a plan. TCP retransmission, Wi-Fi quality, mobile data, microphone privacy settings, speaker volume and foreground restrictions can still affect calls.

Local tests and generated-audio relay checks are separate from physical-device proof. Follow [the two-phone test](PHONE-CALL-TEST.md) and confirm spoken audio in both directions; Connected alone is insufficient. See [verification](VERIFICATION.md) for the checks actually completed.
