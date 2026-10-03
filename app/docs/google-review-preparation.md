# Google Play and AdMob preparation

Website pages describe the current preview. They do not certify legal compliance or guarantee Google approval.

## Public listing links

- Developer website: https://rekhaastrology.in/
- Privacy policy: https://rekhaastrology.in/astrorani/privacy-policy.html
- Outside-app data deletion: https://rekhaastrology.in/astrorani/data-deletion.html
- Support: https://rekhaastrology.in/astrorani/support.html
- Planned email contact: chat@rekhaastrology.in. DNS checks on 3 October 2026 found no MX records; incoming delivery needs setup and verification before using this address as a working store support contact. Public pages direct current requests to the official WhatsApp link.
- Operator name supplied and confirmed by the owner: Rekha Astrology Pvt Ltd.
- No business address has been supplied. Use the actual registered/contact address wherever Google asks for one; do not invent one.

## Current implementation to reconcile with Data safety

The app stores names, dates of birth, selected language, preferences and chat messages. Optional features can store approximate location, selected media/files, voice notes, message metadata and call signaling. The owner can read conversations and attachments. Cloudflare D1 and R2 provide storage; HTTPS protects transport, but chats are not end-to-end encrypted. Review all SDKs and the exact store artifact before submitting the Data safety form.

Camera/microphone permissions are requested for chosen features. Selected files use the system picker. Location and reply notifications are optional. The app does not request SMS, contacts, unrelated gallery access or other apps' messages.

Inactive chats are scheduled for cleanup after the published retention period (normally 30 days, configurable 7–90). Cleanup is batched. Whole-conversation deletion removes active chat/profile/attachment records; exports and hosting backups are separate. A public page provides email and WhatsApp deletion requests without requiring reinstall or login.

The preview currently uses sample/prepared automatic replies and owner replies. No external AI reply provider processes chats. The ₹49 payment is a no-charge demonstration. Ads are disabled and the current native app has no advertising SDK. Do not declare live payments or live AdMob processing for this artifact. Update the privacy policy, disclosures, consent and Data safety information before enabling either.

## Remaining store/account work

Complete developer registration and identity/business verification, supply real business details, prepare and validate the signed store release, fill the store listing and app access instructions, complete the content rating and Data safety forms, and satisfy any testing/review requirements shown in this developer account. Verify the support mailbox can receive requests. None of these account or mailbox states is established by adding website pages.

For AdMob, link the supported store listing and developer website. The root app-ads.txt uses the publisher ID supplied in the owner's AdMob screenshots. Its HTTP availability does not establish AdMob crawl verification or app readiness approval. Advertising remains disabled until separately enabled with suitable disclosures and an updated release.

## Primary guidance

- https://support.google.com/googleplay/android-developer/answer/10144311
- https://support.google.com/googleplay/android-developer/answer/13327111
- https://support.google.com/admob/answer/9363762
- https://support.google.com/admob/answer/10564477
