# Release 1.3.1-connected

This update addresses three obstacles to calls on phones:

- Android now declares MODIFY_AUDIO_SETTINGS, a communication-audio prerequisite checked by Chromium. Microphone and camera still require their normal runtime approval. No phone SMS, contacts or broad gallery access was added.
- If remote playback is blocked, the call shows Play call audio and explains the missing audio. A direct tap retries playback. Results from an old call cannot change a later call's controls.
- Private server heartbeats expire a call when either participant is absent for over two minutes. A remaining participant cannot keep an abandoned call active for an hour. Heartbeats stay off the signal stream and do not consume the normal signaling limit. No database schema change was needed.

Android versionCode 5 / 1.3.1-connected includes 12 customer APKs and the separate admin APK, preserving package IDs and the signing certificate. Existing installations can be updated with these signed APKs.

Physical-phone audio and calls across networks remain unverified. No phone or emulator is attached here. Cloudflare still rejects TURN management with the current credential, and its dashboard requires sign-in. No relay, new plan or paid provider was enabled. See [real-phone test steps](PHONE-CALL-TEST.md) and [relay setup](TURN-SETUP.md).

Validation results are recorded in [VERIFICATION.md](VERIFICATION.md). Existing browser audio measurements used generated tones over local WebRTC and do not prove real-phone calls.
