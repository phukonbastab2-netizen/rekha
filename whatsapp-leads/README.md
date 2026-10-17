# Rekha WhatsApp app-download flow

The separate `rekha-whatsapp-leads` Worker serves Meta app `3058202874566006`, WABA `1630536172004218` and registered number `+15812636719` (phone ID `1368894806304328`). Existing customer app, legacy `whatsapp` Worker and its schedules remain unchanged.

## Current behavior

- One native video message per new lead: the edited 120-second Android download guide, with the owner’s exact short caption “इस video को देखिए और app में मुझसे  बात कीजिए free” and https://rekhaastrology.in on the next line. No separate greeting, text message or follow-up. Existing once-only markers from the former link flow remain respected; this update does not replay a campaign to previous leads.
- The message asks the lead to talk in the app rather than WhatsApp. No AI-generated greetings, ongoing replies or separate follow-ups. OpenAI is not called; its existing secret remains unused.
- The website handles APK downloading. The attachment is an H.264/AAC MP4, served from the existing app's R2 bucket at https://astrorani.rekhaastrology.in/intro/download-guide.mp4. Meta fetches that public URL for the video message; there is no expiring uploaded media ID to maintain. This URL must remain reachable with GET/HEAD and the video/mp4 content type. No customer media is published.
- Meta's documented document formats exclude APK. Never disguise executable content as a supported document or claim an APK download link is an APK attachment.
- Every new eligible inbound message, including audio/images, queues a genuine Meta read request. Read marking never overwrites outgoing delivery/read statuses. Failed read marking retries at most three times on later authenticated traffic. Interrupted read attempts can recover because this operation is idempotent. Blue ticks depend on WhatsApp/client read-receipt settings; outgoing blue ticks cannot be forced.
- Each lead is reserved atomically in `lead_downloads`. Later incoming messages receive read requests without another app invitation. This minimal delivery marker persists after message-history retention to prevent repeated sends.
- STOP/unsubscribe and human requests still pause sends; START only resumes if newer. These control messages can receive read receipts. The owner inbox permits personal replies; human requests pause only automation.
- Requests require Meta's raw-body HMAC and the configured WABA/phone. Only fresh inbound messages within the 24-hour service window may trigger a send. No bulk campaign or retroactive replay was enabled.
- No application daily lead limit. The former `DAILY_SEND_LIMIT` variable and budget gate have been removed. Meta throughput, service-window rules and the existing Cloudflare plan quotas still apply; this does not create unlimited infrastructure capacity or enable bulk outreach.
- Meta acceptance, delivered, read and failure statuses remain distinct. Ambiguous sends are recorded as unknown and never automatically repeated. Confirmed failures require owner review.
- Automation jobs and per-message read work older than seven days are pruned on subsequent authenticated traffic. The separate owner inbox retains message history for 90 days. Opt-outs and minimal once-per-lead delivery markers persist. No customer content goes to OpenAI.

## Deployment

Callback: https://rekha-whatsapp-leads.phukonbastab2.workers.dev/webhook

Readiness: https://rekha-whatsapp-leads.phukonbastab2.workers.dev/health (`app_download_video` mode, `aiReplies=false`).

Secrets: `VERIFY_TOKEN`, `META_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_ADMIN_TOKEN`. Never print credentials or put them in Git/client code. The unused OpenAI secret is not required for this mode. Verification token setup copy remains outside Git.

Apply `schema.sql` additively for the private inbox, then run `inbox-backfill.sql` before and immediately after switching the lead Worker. The backfill imports only available legacy history; missing media metadata and deleted or truncated old text cannot be recovered. Preserve secrets and the existing D1 binding. Keep `wrangler.jsonc` synchronized with live variables. Pause with `SEND_ENABLED=false`. Publish and verify the guide MP4 before enabling its message payload.

The free account has no spare cron slots. Work runs from authenticated inbound messages and delivery callbacks; existing schedules were left unchanged. One app job and up to ten read requests are processed per webhook. Jobs blocked by concurrency and failed read retries wait for later webhook traffic; no scheduled recovery guarantee. An optional cron handler remains available if a slot is freed later.

On 17 October 2026 the new flow recorded one app invitation with a genuine WhatsApp `read` callback and one accepted inbound read-marking request. The owner also confirmed receiving the link. This verifies that test message, not every future delivery or every client's blue-tick display.

A separate owner-requested compatibility test uploaded the actual 373,383-byte APK with its correct MIME type. Meta returned HTTP 400, code 100, rejecting `application/vnd.android.package-archive`. No customer message was sent by this probe, and its short-lived authenticated route was removed afterward. Do not claim direct APK attachments work on this Cloud API account.

## Checks

Run `node --test worker.test.mjs inbox.test.mjs`. Tests use real SQLite and fake providers, without API credit or customer traffic. Coverage includes signature boundaries, the native video payload and exact owner caption, more than 100 distinct leads without the old daily gate, persistent once-per-phone deduplication after history cleanup and Worker restarts, media read receipts without downloads, bounded read retries, STOP/human handoff, disabled sending, ambiguous sends and truthful outgoing receipts.

Official references: [Meta document formats](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/messages/document/) and [Meta read status object](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/types/StatusObject/). These SDK pages are archived; recheck current Cloud API documentation before changing supported media types.

## Private owner inbox

Open https://astrorani.rekhaastrology.in/admin and choose **WhatsApp inbox**. This is separate from app conversations. New incoming messages store their full text, profile name, type, raw message details, attachment references, timestamps and actual provider statuses in `wa_messages`; `wa_inbox_contacts` provides indexed name/phone-prefix search, unread counts and seek pagination. The owner can read chat history, view media, export a per-chat CSV, delete history and send arbitrary personal text replies of up to 4096 characters. CSV exports neutralize spreadsheet formula injection. No training dataset or OpenAI request is created.

Manual sends require an active owner session, same-origin write and a customer message within the preceding 24 hours. STOP blocks sending until a newer START. Human requests pause automation but allow a personal reply. Each deliberate Send uses a durable UUID reservation. Network retries reuse that identifier; unknown or failed sends are never automatically repeated. Multiple deliberate replies do not require an intervening customer message while the service window remains open. API acceptance is distinct from delivery/read confirmation. No manual production test message was sent during implementation.

The app Worker calls `/owner/...` through its `WHATSAPP_LEADS` service binding. Both Workers hold the same server-only `WHATSAPP_ADMIN_TOKEN` secret. The browser never receives this token or Meta credentials. Direct owner endpoints reject unauthenticated access. Preserve all existing bindings and schedules when publishing. Run `node package.mjs` to build `worker-bundle.mjs` for single-module API deployment; Wrangler can bundle `worker.mjs` imports directly.

`WA_MEDIA` binds the existing private `astrorani-media` R2 bucket. Each authenticated webhook attempts one queued incoming attachment archive under `whatsapp-private/`, with at most three attempts on later traffic and a 100 MB limit. No cron capacity or paid plan was added. Pending/unavailable attachments can be fetched from Meta through the authenticated owner proxy while Meta retains them. File preservation is best effort, not guaranteed, and attachment URLs are not made public. Owner history deletion and 90-day activity-driven retention enqueue archived object cleanup, without resetting once-per-phone protection or opt-out records.

The website privacy policy describes this separate business-WhatsApp processing and retention. App chat retention remains separately configurable.
