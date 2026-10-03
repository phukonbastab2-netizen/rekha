# Owner guide

Open `/admin` on the app host or open Rekha Admin on your phone. Sign in with the owner password you set privately. Customers cannot open the inbox with their chat session.

## Handle a customer conversation

Select a customer in the inbox. You can send multiple text or media messages in succession without waiting for their reply. The composer supports files, voice notes, replies to earlier messages, reactions, stars, search and shared media. Message checks show actual read state rather than a simulated online status.

Choose the private reply mode for each chat:

- **Automatic:** the configured guided sequence can advance. Unguided preview chats can receive sample automatic replies.
- **Draft assistance:** review a suggested reply before sending it.
- **Personal replies:** send your own messages. Automatic guided delivery is held.

The customer still sees the single configured astrologer identity. Pin or archive chats to organise the inbox; labels and private notes stay on the owner side. Blocking a conversation prevents customer sends and pauses automated delivery while preserving the history.

## Change the customer app

Open **Edit app**. Change the name, astrologer identity, tagline, logo, colours, introduction order, language wording, message features, free-reply allowance, preview unlock price and retention period.

Save a draft, review the phone preview, then publish it. Draft changes do not appear to customers. Discard restores the published version. If another owner screen changes the same draft, refresh and review the conflict before publishing.

Published settings update an open customer chat periodically, while its unfinished text and attachments stay in place. Feature switches hide unavailable attachment/voice/call controls. Pausing customer messaging leaves their existing history readable. The payment-preview disclosure and privacy controls remain present.

Changing a published logo makes that image public. Customer attachments and other library images remain protected by their own access rules. Choose a logo you have permission to publish.

## Set automatic replies and videos

Open **Replies & video flow**. Upload and select the six required items in the private media library: instruction video, testimonials video, example kundli image, guidance image, puja information image and follow-up audio. Review the wording in Hindi, English and Hinglish and set the delivery delays before enabling the flow.

New customers are enrolled when the flow is enabled. Their first inbound message starts the greeting, instruction video, testimonials and final information in order. A customer attachment can schedule the image/audio follow-up campaign. Videos wait for a tap to play. Guided conversations do not use the old free-reply counter or ads.

Existing customers require an explicit **Start**. Each chat also has **Pause**, **Resume** and **Restart** controls. Global disabling holds queued deliveries. Changes apply to future flows or an explicitly restarted chat; an existing flow keeps its saved wording and price. Switching to draft assistance or personal replies holds guided automatic delivery.

The preview payment QR remains inactive. Do not collect card details or try to reuse a customer's payment information. Configure a legitimate payment provider separately before accepting real payments.

## Voice and device setup

Use **Feature access** to enable microphone, camera and optional message alerts. Android prompts are separate; tapping a voice or camera feature also starts its permission request. If access was previously blocked, tap **Open app settings** and change that permission there. Customers share selected files through Attach; their SMS and full gallery are not accessible to the owner.

On an owner call, choose Natural, Lower pitch, Higher pitch, Warm or Robot under **Your voice**. You can change the effect during a call. These are local effects, not a cloned voice. Mute silences both the microphone and processed outgoing audio. Both apps must remain open for calls.

## Customer sending and connection status

Customers can keep composing while earlier messages are sending. A sending indicator means that the server has not confirmed receipt yet. Failed sends remain visible with a retry action; retrying uses the same send ID so an already saved message is not duplicated. A sent check confirms server receipt, while a read check means the owner has opened that message. Receiving an automatic or personal reply is a separate event.

Automatic workflow delivery runs after the message has been saved, with recovery from the saved trigger on later polls or scheduled processing. No message content is stored in the browser's local storage by the send queue.

## Protect customer information

Use the owner panel on a private device, sign out when finished, and keep the owner password and signing backups private. Ask only for details needed for the conversation. Never request passwords, OTPs, banking credentials or another person's private messages. Respect the configured retention period and customer deletion requests.
