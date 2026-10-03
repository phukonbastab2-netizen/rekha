# Release 1.3.2-connected

- Adds a private, same-origin WebSocket voice relay through each app's existing backend, so voice calls do not need TURN or a direct peer connection. Video retains WebRTC.
- Bounds voice processor startup and releases resources on failure. Natural voice can use the ordinary microphone; altered presets require explicit recovery or the owner's choice to use Natural.
- Adds recovery controls when the voice processor or relay audio context is suspended or interrupted. Recovery retains mute state and ignores results from ended calls.
- Keeps call authorization, conversation isolation, per-participant leases and a one-hour maximum. The server forwards voice only between the authenticated customer and owner, without recording audio.
- Updates all 12 customer APKs and the separate admin APK to versionCode 6 / 1.3.2-connected with the existing signing key and four existing permissions.

Relay audio uses encrypted connections to the app server and is readable by that server; it is not end-to-end encrypted. Both apps must remain open. No ordinary phone-number dialing, background ringing, voice cloning or broad phone-data access is added.

See [relay details](VOICE-RELAY.md), [phone test steps](PHONE-CALL-TEST.md) and [completed verification](VERIFICATION.md). No physical Android phone is attached to this build environment, so actual two-phone speech must still be checked on devices.
