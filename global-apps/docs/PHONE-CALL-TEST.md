# Real-phone call check

These are in-app calls between a customer and the owner of the same country app. Release 1.3.3 includes the private voice relay, automatic reconnection and audio controls. Voice does not require TURN. Physical-phone audio is not yet verified; the completed checks are recorded in [verification](VERIFICATION.md).

1. Install the latest customer APK on one Android phone and Rekha Global Admin on another. Keep both apps open and the phones unlocked. Grant microphone access when starting or answering; video also requests camera access.
2. On the customer phone, open the chosen country app and start a conversation. On the owner phone, choose that country's Owner inbox and open the same conversation using its private owner password.
3. Start with both phones on the same Wi-Fi, with the owner voice effect set to Natural. Tap Voice call on one phone and Answer on the other. Tap Resume call audio or Resume microphone if it appears. For interrupted owner processing, Use Natural explicitly switches to the ordinary microphone.
4. Verify spoken sound in both directions. Connected alone is insufficient. Check Mute and Unmute, then end the call. Start a second call from the other phone and repeat.
5. Check the owner's other voice effects while the customer confirms audible sound. For video, confirm each phone receives the other camera image and speech.
6. Repeat the voice call with one phone on mobile data and the other on a separate network. The authenticated app relay should carry voice audio when configured; confirm spoken sound in both directions. Video remains WebRTC and may need [TURN setup](TURN-SETUP.md).
7. Move the receive-volume slider and confirm only your playback changes. Check connected time pauses during reconnection. Briefly interrupt the network and verify recovery preserves microphone mute and volume; do not assume every outage recovers.
8. In the latest Android APKs, try Phone audio and Speaker. Confirm the actual route and sound, then check audio settings restore after hang-up, switching away and returning. Test a connected headset separately; Phone audio releases the app's forced speaker route so the platform selects the output. If native audio is interrupted, tap the route control to resume. An existing phone call must keep its audio settings.

If a phone closes or loses connectivity without sending its hangup, the server ends the abandoned call after either participant has been absent for over two minutes, when the next call request is handled. Both apps must remain open during a call. Calls have a one-hour maximum. Background ringing and ordinary telephone-number dialing are not implemented.

Use the latest APKs to get the audio recovery changes and the Android communication-audio permission added in 1.3.1. If microphone access was previously declined, enable it in Android's app permission settings, then tap the call button again. Check Android's microphone privacy switch and speaker volume. SMS, contacts and full-gallery access are not requested for calls. Relay audio is readable by the app server and is not recorded; see [relay details](VOICE-RELAY.md).
