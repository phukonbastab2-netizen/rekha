# Real-phone call check

These are in-app calls between a customer and the owner of the same country app. Physical-phone calling is not yet verified. The relay is still inactive because the available Cloudflare credential cannot manage TURN and the dashboard requires sign-in.

1. Install the latest customer APK on one Android phone and Rekha Global Admin on another. Keep both apps open and the phones unlocked. Grant microphone access when starting or answering; video also requests camera access.
2. On the customer phone, open the chosen country app and start a conversation. On the owner phone, choose that country's Owner inbox and open the same conversation using its private owner password.
3. Start with both phones on the same Wi-Fi, with the owner voice effect set to Natural. Tap Voice call on one phone and Answer on the other. If Play call audio appears, tap it.
4. Verify spoken sound in both directions. Connected alone is insufficient. Check Mute and Unmute, then end the call. Start a second call from the other phone and repeat.
5. Check the owner's other voice effects while the customer confirms audible sound. For video, confirm each phone receives the other camera image and speech.
6. Repeat with one phone on mobile data and the other on a separate network after the private call relay is configured. See [TURN setup](TURN-SETUP.md). Until then some network combinations may fail.

If a phone closes or loses connectivity without sending its hangup, the server ends the abandoned call after either participant has been absent for over two minutes, when the next call request is handled. Both apps must remain open during a call. Calls have a one-hour maximum. Background ringing and ordinary telephone-number dialing are not implemented.

Use the latest APKs to get the Android communication-audio permission added in 1.3.1. If microphone access was previously declined, enable it in Android's app permission settings, then tap the call button again. Do not grant phone SMS, contacts or full-gallery access; those are not needed or requested for calls.
