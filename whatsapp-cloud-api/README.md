# Separate WhatsApp Cloud API funnel

This service has its own Worker, callback, credentials and Durable Object storage. It does not import OpenWA contacts, replay old queues, change the customer app, or change the existing Workers.

## Current state

The separate connection was configured on 18 October 2026 under the **rekha** portfolio, using its existing **rekha astrology** app and the approved WABA `1618188039845611`. A dedicated Employee system user has access to only that app and WABA. Its non-expiring system-user token has WhatsApp messaging and management scopes. Credentials remain private Worker secrets.

Sending and read-receipt flags are configured, but the account is now **paused for display-name approval**. The live screenshot test arrived at **10:31:20 pm IST on 18 October 2026** and scheduled the reminder and four final messages. Meta rejected the reminder with HTTP 400/code **131037**; the phone's name remains `PENDING_REVIEW`, and WhatsApp Manager disables editing while it is in review. The rejected reminder and remaining media are preserved as held work. A reviewed maintenance change after Meta approval is required before resuming; approval does not automatically replay a backlog.

The verification challenge and signature checks pass. Both the selected WABA and its phone have explicit webhook overrides pointing to this service; the app-wide callback is unchanged. The first live inbound test was stored on **18 October 2026 at 9:58:36 pm IST**. The completed outgoing test received at **10:10:37 pm IST** produced all five original messages, with signed Meta receipts confirming each as delivered or read. Previous held work was not automatically released: a fresh customer message authorized the tested sequence.

The Cloudflare runtime rejected `redirect: 'error'` before any provider request. The transport now uses `redirect: 'manual'`, never follows redirects and treats unexpected responses as uncertain. The single locally rejected test attempt was reconciled only after runtime proof of the pre-network error and owner confirmation of non-receipt. Its one-time repair binding has been removed. Ordinary uncertain sends remain blocked and are never automatically retried. The transport and durable workflow have **54 passing checks**, including the complete first/reminder/media sequence, concurrent webhook duplicates, restarts and approval holds. These local checks do not establish real-device delivery of the reminder or delayed media.

The latest Meta health check reports the portfolio and app as available, the display name as pending review, and a separate payment-method error blocking business-initiated conversations. The actual 131037 rejection establishes the current send blocker; incoming messages still reach the service. Do not interpret `readyForConnection` as permission or readiness to send; it checks local configuration only.

The live service uses the original owner-supplied ₹29 funnel text, media and five-second spacing. The committed deployment defaults remain disabled to prevent accidental activation elsewhere. The first greeting retains its original eight paragraphs and actual line breaks; copy and captions are checked against the recovered original. No personalized chart calculation is implemented here.

## Original customer sequence

1. The first customer message starts five replies once: greeting, instruction video, reviews video, current ₹29 QR and the three-details request. Media-only first messages also enroll the customer. Reactions and system notices do not enroll leads.
2. After those five are accepted, the next customer reply schedules one reminder after one minute. Any ordinary reply qualifies, including a name, date of birth or “Namaste”; it does not need to contain a question. The reminder is never sent automatically without that later reply.
3. The first image or explicit payment report independently schedules the four final messages one hour later: kundli image, solution image, puja-materials image and original audio. This also works when the very first message is an image or payment report. Additional images, repeated reports and duplicate webhooks do not restart that delay or create extra messages. A report records **pending review**, never verified payment.

First replies finish before a reminder or final media begins. A queued one-hour followup cannot block a later one-minute reminder. Each stage keeps stable step IDs and at least five seconds between accepted sends. STOP, restrictions, delivery failures and expired service windows still stop or hold pending work. A late signed `delivered` or `read` receipt can resolve a previous delivery failure and allow the remaining steps to continue; the already accepted message is never replayed.

## Setup

1. Check the selected business, app, WABA and phone's current Meta eligibility. Resolve restrictions through Meta's available review process; configuration cannot override enforcement.
2. Connect an eligible, authorized Meta app/WABA/phone number. Use that app's actual Graph API version and phone-number ID.
3. Store `META_ACCESS_TOKEN`, `META_APP_SECRET`, `META_VERIFY_TOKEN` and `ADMIN_TOKEN` as Worker secrets. Never commit them or send them in chat.
4. Use `https://rekha-whatsapp-cloud-api.phukonbastab2.workers.dev/webhook`, verify it with the private verification token, and subscribe the app to the WABA's `messages` events. This installation uses both WABA-specific and phone-specific overrides, preserving the app-wide callback and other accounts. Inspect any existing phone-level override before changing routing.
5. Keep `SEND_ENABLED=false` while checking the authenticated `/admin/preflight` endpoint and signed incoming events.
6. Before each approved activation, rotate `SEND_EPOCH` to a fresh value and then set `SEND_ENABLED=true`. A fresh customer message is required to release held work. Old queues never release just because configuration changes. Persisted conversation state is bound to its original sender ID.
7. Test one owner-controlled conversation end to end: incoming webhook, exact funnel, accepted message IDs, and actual signed sent/delivered/read or failed receipts. Check real device delivery before expanding traffic.

`POST /admin/pause` with `Authorization: Bearer <ADMIN_TOKEN>` durably pauses the account. `/admin/status` and `/admin/preflight` require the same token. There is deliberately no public send or resume route. A provider restriction also pauses all contacts. A restriction pause requires a reviewed maintenance change after Meta restores eligibility; changing the enable flag cannot bypass it.

Private status includes timestamps for successfully stored inbound/status webhooks. `/admin/conversation-status?id=<durable-object-id>` lets the owner verify stored receipt times, stage flags, stable step IDs, due/acceptance times and held job states without exposing customer text, phone numbers or provider message IDs. It is read-only, requires the same owner token and never releases queued messages.

Authenticated `POST /admin/read-latest` accepts an opaque conversation object ID to mark its most recent stored inbound as read. This covers a message received before read receipts were enabled, without sending a chat reply or replaying the funnel. It checks the service window, opt-out and global pause, and repeated marking of the same message is idempotent. A successful current-test acknowledgment was confirmed by Meta after activation.

`/admin/transport-check` performs only authenticated read-only Meta requests to check edge-to-Meta connectivity. It sends no WhatsApp message. The current system-user token was replaced with Meta's **Never** expiry option on 18 October 2026. Meta's debugger confirmed `expires_at: 0` and `data_access_expires_at: 0`, the same app-scoped principal and unchanged permissions. Cloudflare authenticated with the replacement after installation. No calendar renewal is scheduled; tokens can still be revoked or invalidated when account access changes. There is no automatic account recovery process.

Separate credentials and storage limit accidental cross-account changes. They cannot guarantee that a WhatsApp restriction will leave its Meta portfolio unaffected. Meta controls account and organization enforcement; there is no ban-proof portfolio setting. Respect opt-outs, service windows and approved limits, and retain a direct support route before activating automation.

## Delivery behavior and limits

- Incoming message IDs and per-step send journals are durable. Webhook redelivery does not create duplicate steps.
- A timeout, network failure, 5xx, malformed success, or interrupted send is uncertain and stops that contact. It is not automatically retried. If no message ID was returned, delivery cannot yet be reconciled automatically; an operator must review the actual chat before any manual retry. Exactly-once delivery across a provider boundary cannot be guaranteed.
- Only definite typed throttling rejections retry, with bounded attempts. Acceptance is recorded as `accepted`, not `sent`; webhook receipts determine delivery.
- A definite HTTP 400/code 131037 rejection holds that step and all remaining work, then durably pauses the account as `display_name_approval_required`. Older matching rejected jobs migrate to this hold without resending. Subsequent customers are stored but cannot trigger more provider attempts while paused. Genuine restrictions remain a separate pause reason; neither pause is bypassed by toggling the send flag.
- STOP and common Hindi/Hinglish opt-outs cancel pending replies. Automated free-form sends stop outside the customer's 24-hour service window. There are no unsolicited template campaigns or limit-raising bots.
- Storage and Workers capacity do not increase Meta messaging limits. No 10,000-leads/day capacity or account eligibility has been demonstrated. Business verification, quality and Meta-approved limits remain separate requirements.
- Public health checks disclose no credentials or customer records. Signed incoming events are stored privately; there is no public inbox. There is no OpenAI dependency or AI usage charge in this service.

## Local checks and deployment

Run `node build.mjs`, then `node --test transport.test.mjs worker.test.mjs funnel.test.mjs`. `wrangler.jsonc` defaults to disabled sends and a blank phone ID. It creates separate SQLite Durable Object classes `FunnelConversation` and `CloudApiControl`.

The QR asset is a byte-for-byte copy of the owner-supplied image, served by this Worker. Other media URLs reference the existing public R2 files; they do not share message state or credentials.
