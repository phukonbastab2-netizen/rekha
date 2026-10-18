# Separate WhatsApp Cloud API funnel

This service has its own Worker, callback, credentials and Durable Object storage. It does not import OpenWA contacts, replay old queues, change the customer app, or change the existing Workers.

## Current state

Sending and read receipts are disabled. No Meta access token, app secret or phone-number ID is configured. The existing `rekha` WhatsApp Business account was shown as **Banned** in Meta on 18 October 2026. A working endpoint does not restore that account or prove message delivery.

The original owner-supplied ₹29 funnel text, media and five-second spacing are kept as a disabled draft. An image or explicit payment report after enrollment schedules the original one-hour followup once; this records **pending review**, never verified payment. Validate the business identity, testimonial claims, offers and chart descriptions before activation. No personalized chart calculation is implemented here.

## Setup

1. Resolve the existing restriction through WhatsApp/Meta's available review process. Do not create replacement accounts to evade it.
2. Connect an eligible, authorized Meta app/WABA/phone number. Use that app's actual Graph API version and phone-number ID.
3. Store `META_ACCESS_TOKEN`, `META_APP_SECRET`, `META_VERIFY_TOKEN` and `ADMIN_TOKEN` as Worker secrets. Never commit them or send them in chat.
4. Set the Meta webhook callback to `https://rekha-whatsapp-cloud-api.phukonbastab2.workers.dev/webhook`, verify it with the private verification token, and subscribe the app to the WABA's `messages` events. Do not replace another integration's callback without reviewing its impact.
5. Keep `SEND_ENABLED=false` while checking the authenticated `/admin/preflight` endpoint and signed incoming events.
6. Before each approved activation, rotate `SEND_EPOCH` to a fresh value and then set `SEND_ENABLED=true`. A fresh customer message is required to release held work. Old queues never release just because configuration changes. Persisted conversation state is bound to its original sender ID.
7. Test one owner-controlled conversation end to end: incoming webhook, exact funnel, accepted message IDs, and actual signed sent/delivered/read or failed receipts. Check real device delivery before expanding traffic.

`POST /admin/pause` with `Authorization: Bearer <ADMIN_TOKEN>` durably pauses the account. `/admin/status` and `/admin/preflight` require the same token. There is deliberately no public send or resume route. A provider restriction also pauses all contacts. A restriction pause requires a reviewed maintenance change after Meta restores eligibility; changing the enable flag cannot bypass it.

## Delivery behavior and limits

- Incoming message IDs and per-step send journals are durable. Webhook redelivery does not create duplicate steps.
- A timeout, network failure, 5xx, malformed success, or interrupted send is uncertain and stops that contact. It is not automatically retried. If no message ID was returned, delivery cannot yet be reconciled automatically; an operator must review the actual chat before any manual retry. Exactly-once delivery across a provider boundary cannot be guaranteed.
- Only definite typed throttling rejections retry, with bounded attempts. Acceptance is recorded as `accepted`, not `sent`; webhook receipts determine delivery.
- STOP and common Hindi/Hinglish opt-outs cancel pending replies. Automated free-form sends stop outside the customer's 24-hour service window. There are no unsolicited template campaigns or limit-raising bots.
- Storage and Workers capacity do not increase Meta messaging limits. No 10,000-leads/day capacity or account eligibility has been demonstrated. Business verification, quality and Meta-approved limits remain separate requirements.
- Public health checks disclose no credentials or customer records. Signed incoming events are stored privately; there is no public inbox. There is no OpenAI dependency or AI usage charge in this service.

## Local checks and deployment

Run `node build.mjs`, then `node --test transport.test.mjs worker.test.mjs funnel.test.mjs`. `wrangler.jsonc` defaults to disabled sends and a blank phone ID. It creates separate SQLite Durable Object classes `FunnelConversation` and `CloudApiControl`.

The QR asset is a byte-for-byte copy of the owner-supplied image, served by this Worker. Other media URLs reference the existing public R2 files; they do not share message state or credentials.
