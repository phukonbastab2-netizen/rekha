# Owner guide

Open `/admin` on the app host or open Rekha Admin on your phone. Sign in with the owner password you set privately. Customers cannot open the inbox with their chat session.

## Handle a customer conversation

Select a customer in the inbox. You can send multiple text or media messages in succession without waiting for their reply. The composer supports files, voice notes, replies to earlier messages, reactions, stars, search and shared media. Message checks show actual read state rather than a simulated online status.

Personal replies are active. Previous automatic replies, draft generation and scheduled sequences are stopped. Customers can keep sending without spending free-reply credits. You can reply or send media yourself at any time.

The customer still sees the single configured astrologer identity. Pin or archive chats to organise the inbox; labels and private notes stay on the owner side. Blocking a conversation prevents customer sends and pauses automated delivery while preserving the history.

## Change the customer app

Open **Edit app**. Change the name, astrologer identity, tagline, logo, colours, language wording, message features and retention period. Legacy introduction order and free-reply/offer settings do not control the current customer flow.

Save a draft, review the phone preview, then publish it. Draft changes do not appear to customers. Discard restores the published version. If another owner screen changes the same draft, refresh and review the conflict before publishing.

Published settings update an open customer chat periodically, while its unfinished text and attachments stay in place. Feature switches hide unavailable attachment/voice/call controls. Pausing customer messaging leaves their existing history readable. Privacy and deletion controls remain present.

Changing a published logo makes that image public. Customer attachments and other library images remain protected by their own access rules. Choose a logo you have permission to publish.

## Current customer startup

New customers watch the required signup video, enter their name and date of birth, then tap Send. A five-second preparation screen opens their private chat with only the configured shared kundli image and “Your kundli.” No greeting, video sequence, reminder or automatic follow-up is sent afterward. Existing chats resume directly.

The old three-video customer page and its chat navigation links are removed. Saved media and conversation history remain available in admin. **Replies & video flow** still lets you choose the kundli library image; the old Enable/Start/Resume/Restart controls remain unavailable while `CUSTOMER_AUTOMATION_ENABLED` is false. Previous queued jobs are cancelled in the rollout, so they cannot be resumed accidentally. Define and implement the next steps before enabling a new automation.

The preview payment QR remains inactive. Do not collect card details or try to reuse a customer's payment information. Configure a legitimate payment provider separately before accepting real payments.

## Voice and device setup

Use **Feature access** to enable microphone, camera and optional message alerts. Android prompts are separate; tapping a voice or camera feature also starts its permission request. If access was previously blocked, tap **Open app settings** and change that permission there. Customers share selected files through Attach; their SMS and full gallery are not accessible to the owner.

On an owner call, choose Natural, Lower pitch, Higher pitch, Warm or Robot under **Your voice**. You can change the effect during a call. These are local effects, not a cloned voice. Mute silences both the microphone and processed outgoing audio. Both apps must remain open for calls.

## Customer sending and connection status

Customers can keep composing while earlier messages are sending. A sending indicator means that the server has not confirmed receipt yet. Failed sends remain visible with a retry action; retrying uses the same send ID so an already saved message is not duplicated. A sent check confirms server receipt, while a read check means the owner has opened that message. Receiving an automatic or personal reply is a separate event.

Messages are saved for personal replies without triggering the previous workflow. No message content is stored in the browser's local storage by the send queue.

## Protect customer information

Use the owner panel on a private device, sign out when finished, and keep the owner password and signing backups private. Ask only for details needed for the conversation. Never request passwords, OTPs, banking credentials or another person's private messages. Respect the configured retention period and customer deletion requests.
