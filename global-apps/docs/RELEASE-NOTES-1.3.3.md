# Release 1.3.3-connected

- Recovers brief private voice-socket interruptions within a bounded retry window, preserving mute and audio settings. Ended or rejected calls stay ended; old audio is discarded.
- Adds connected-call duration and a receive-only volume control. Muting your microphone does not change the other person's volume.
- Makes microphone interruption visible and ends a call clearly when its microphone track stops.
- Adds Android speaker/phone-audio controls through an origin-checked, call-scoped native command. Calls restore the prior audio settings on end or navigation.
- Improves the mobile call panel with scrolling, safe-area spacing and accessible control labels.
- Updates the 12 customer APKs and separate owner APK to versionCode 7 / 1.3.3-connected, using the existing signing certificate and four existing permissions.

Calls remain foreground-only. Voice audio is relayed over encrypted connections through the app server and is not recorded or end-to-end encrypted. Voice effects do not clone a voice. Physical Android microphone, speaker, headset and cross-network behavior require device verification.

See [verification](VERIFICATION.md) and [two-phone test steps](PHONE-CALL-TEST.md).
