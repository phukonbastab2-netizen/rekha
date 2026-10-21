# Separate Oracle inbox for manual replies

The original ₹29 funnel remains on Cloudflare. Its words, timing, accepted
message IDs, pending follow-ups and sending gates do not move or restart.
Oracle does not run an automatic funnel, linked browser or OpenAI model.

`inbox-entry.mjs` adds two private **read-only** endpoints to the existing
Worker: `/admin/inbox-index` and `/admin/inbox-sync`. They use the existing owner
bearer token, read existing Durable Object records directly, and never call
`put`, `load`, `schedule` or the send transport. All original public requests
continue through `entry.mjs`. The original Worker classes remain authoritative.

`oracle/rich-server.mjs` binds to loopback on port 4342. An owner password is required for both the SSH view and optional public access. Configure a salted scrypt OWNER_PASSWORD_HASH, a random OWNER_SESSION_KEY, PUBLIC_ORIGIN and PUBLIC_BASE_PATH. Passwords and Meta tokens are never embedded in the Android APK. Sessions are signed, expire after 30 days, and use HttpOnly SameSite=Strict cookies (Secure on HTTPS). Login has per-client and global rate limits. Every mutation checks the exact origin. Public routing must terminate through the managed Oracle tunnel and preserve the main website host. The separate proxy handles only /manual-inbox/.

The inbox polls the bounded discovery index every three seconds while the owner
is viewing it and every thirty seconds when idle, with backoff on failures. A
revision in the existing account receipt commit selects only changed contacts;
unchanged contacts are not repeatedly fetched. It caches customer messages and
original funnel messages on Oracle SQLite, and sends a manual message only after
the owner presses Send. Manual replies and their
idempotency journal stay on Oracle. Repeated clicks use the same request ID;
an interrupted or ambiguous send is held for review rather than auto-retried.
The original first five replies must finish first. The number's account hold,
opt-outs, test-contact gate and 24-hour customer reply window still apply.

## Composer and payment review

The familiar chat layout has JPG/PNG images, MP4 video, supported audio,
documents, drag/drop, clipboard image paste, caption previews, multi-file
sending, local drafts, emoji, recorded voice converted to mono OGG/Opus, and
playback speed controls. Quoted replies and reactions target only provider IDs
already saved in the selected conversation. Local pin/archive/unread/star
controls do not pretend to change the customer's WhatsApp application.

The ₹29 payment drawer reuses the exact existing QR and caption. A customer
image is pending review. A "Verified by me" action requires the owner to confirm
they checked their payment application, and appends a local audit entry. No
bank account, card number or CVV is collected, and screenshots do not establish
actual settlement. There is no native WhatsApp Pay transfer implementation.

Uploads go directly from Oracle to the official Meta media API, not to a new
Cloudflare bucket. Voice conversion uses a bounded, format-checked local decoder
and deletes its temporary input/output. Meta media URLs stay server-side behind
the private session; user-provided URLs cannot receive the API token.

Incoming media metadata and owner-message receipts piggyback on the existing
Cloudflare state commits, without adding a second source write per event. Signed
receipts determine delivery/read ticks. Oracle also saves receipts that arrive
before the manual send's API response, avoiding the early-receipt race.

## Efficiency and capacity evidence

Chat and message history use indexed cursor pages with timestamp/ID tie breaks;
the browser keeps at most 200 chat rows and 320 message rows in its active view.
Customer-number prefix and last-four searches have indexes. Status counters are
maintained on writes instead of running full-table counts every refresh. Shared
funnel text/media metadata is stored once in a template table; contact records
store compact summaries rather than complete duplicated job arrays. Existing
audio/video nodes survive receipt-only UI updates.

`capacity-results.json` records an isolated Oracle test with 10,000 synthetic
customers and 100,000 messages: the two-page-chat-plus-message query took about
1.23 ms at p50 and 3.21 ms at p95. The database occupied about 91 MB. Extrapolating
that particular ten-messages-per-customer fixture to ten million customers gives
about 85 GiB before adequate backups and headroom. This is a projection, not a
ten-million-customer test. The inspected server has roughly 37 GiB free, so it
cannot honestly be certified to retain that workload on its current disk.

No plan upgrade or paid container was created. A public tunnel is an optional owner-approved deployment step. At least a larger
history-storage allocation, durable event discovery and independent recovery
must be reviewed before promising the full target. The capacity drawer reports
actual free disk and explicitly leaves the ten-million target unverified.

## Scope and limits

- This is an additional manual inbox, not a migration or replacement of the
  working Cloudflare funnel. That funnel retains its existing database writes;
  Oracle's history and manual outbox require no extra Cloudflare database.
- Replies begin at **accepted by WhatsApp** and advance to delivered/read only
  from genuine signed provider receipts. Existing old receipts cannot be
  reconstructed if the former Worker did not retain them.
- The source discovery index contains the most recent 100 conversations. Once
  imported, conversations remain on Oracle. A burst that replaces the entire
  source index between polls can miss discovery; this is not a guaranteed
  complete phone-history mirror or a verified 10,000-lead/day inbox.
- Historical inbound media without a saved media ID cannot be reconstructed.
  New incoming media keeps its private Meta ID; previews/downloads require the
  owner session and remain subject to Meta retention/expiry. Funnel media keeps
  the existing public links.
- WhatsApp messages sent directly from the phone are not exposed by this Cloud
  API history. Replies sent in this separate inbox are saved locally.
- The Oracle service runs without the PC. Public phone access requires the tunnel and separate page route to be verified live; an APK build alone does not prove phone permissions or device behavior. There is no high-availability claim.

This is a WhatsApp-style operator interface on the official API, not a complete
implementation of phone-app features such as native payments, groups, video
calls, account settings or delete-for-everyone. Those are not represented as
working controls.

Run the original test suite plus `inbox-entry.test.mjs`,
`oracle/inbox.test.mjs` and `oracle/rich-inbox.test.mjs`. Keep `.env`, SQLite files, SSH keys and API tokens
outside Git. `backup.mjs` creates a consistent Oracle-local SQLite backup;
such a backup alone does not protect against losing the VM's disk.

## Android inbox

The separate `in.rekhaastrology.oracleinbox` Android app opens only the secure /manual-inbox/ page. It has INTERNET, RECORD_AUDIO and MODIFY_AUDIO_SETTINGS permissions. Microphone approval is requested after a visible recording action; photos/documents use the Android system picker, and the camera uses a temporary, narrowly granted private provider URI. API credentials and the owner password are not packaged. Keep release signing files outside the repository. Public APK downloads use /manual-inbox/downloads/RekhaInbox.apk.

## Published phone access (2026-10-21)

Owner-approved URL: https://rekhaastrology.in/manual-inbox/
Android download: https://rekhaastrology.in/manual-inbox/downloads/RekhaInbox.apk
The dedicated rekha-manual-inbox Worker matches only rekhaastrology.in/manual-inbox*. A healthy managed cloudflared connector on Oracle routes through inbox-origin.rekhaastrology.in to loopback port 4342, overriding the origin Host to rekhaastrology.in. The existing website route and original automatic funnel were not changed. The tunnel token, password hash and session key stay in the private Oracle directory; neither the APK nor repository contains them. Both inbox and connector services are enabled at boot. Live HTTPS checks verified the password sign-in, 401 before sign-in, cross-origin rejection, real chat data and the exact signed APK hash. Installation, recording and file picking still require real Android-device verification.
