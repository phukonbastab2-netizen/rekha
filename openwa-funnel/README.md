# Standalone Rekha WhatsApp ₹29 funnel

Independent of the customer app and existing Meta API Workers. Uses `open-wa/wa-automate-nodejs` 5.6.6, an unofficial WhatsApp Web integration. It cannot reinstate a restricted account or guarantee throughput/account approval.

## Owner use

1. Start with `Start-Rekha-WhatsApp.cmd` on this Windows PC (or run `npm start`).
2. Open `http://127.0.0.1:4341/` **on this PC**.
3. Choose **Connect WhatsApp**. On your phone, use WhatsApp Business → Settings → Linked devices → Link a device to scan the private QR.
4. Choose **Enable funnel** when ready. Only new private incoming messages are eligible. Existing chat history, groups and status updates are not imported or messaged.
5. Select a customer to read and reply. Manual messages work while the automatic funnel is paused. Opening a customer chat requests a real WhatsApp read receipt; customer settings and provider support determine the visible ticks.

The PC must stay on and online. Cloudflare stores a private backup; it does not run the WhatsApp browser. There is no new AI/API credit usage. No bulk campaigns, contact imports or automatic retries of uncertain sends are provided.

## Sequence and verification

Original public assets and order were recovered from the owner's live legacy Cloudflare `whatsapp` Worker. Greeting, instruction video, reviews video, ₹29 QR and details request are separated by at least five seconds **after actual submission**. The first later reply after this sequence schedules one reminder after 60 seconds. The first customer attachment schedules the three reference images and recorded audio after one hour, with five-second gaps. Both sequences run once per sender ID.

The owner's original Cloudflare wording is preserved verbatim in funnel-copy.json, including captions and line breaks. The audio has no caption, matching the original Worker. Tests pin the canonical copy hash to prevent accidental edits.

Screenshots/attachments set payment status to **pending**, never paid. The owner must independently check the receiving account before choosing **Verify payment**. The QR is the original legacy QR: check its payee in a UPI app before enabling the funnel. No card credentials, OTPs or bank logins are requested. Recognizable incoming verification codes are omitted from stored content and do not trigger replies.

`STOP` opts the sender out and cancels queued steps. `START` removes opt-out; it does not replay cancelled steps. Customer IDs are the exact WhatsApp JIDs, including `@lid` when supplied. OpenWA identity changes cannot be reliably merged without a verified mapping.

Outgoing states: **queued → sending → accepted**, followed by actual provider **sent/delivered/read** ACKs. `accepted` is not proof of delivery. On timeout, failed/boolean submission or process interruption during sending, the outcome is **unknown** and that customer's automation pauses. Check the original WhatsApp chat, resolve the flagged send, then resume. Never assume failure means no message was sent.

## Private storage and backup

Local SQLite WAL in `.local/funnel.sqlite` is authoritative. Permanent inbound message IDs and contact/sequence markers prevent duplicate replay across normal restarts. Indexed queues and paginated lists bound the work per poll. It is a single gateway, not a verified high-volume or multi-node service.

Every changed contact, message, job and setting enters a durable local backup outbox. A separate authenticated Cloudflare Worker mirrors these changes into additive D1 `ow_backup` records and customer attachments into private R2 `openwa-private/<installation-id>/` keys. No existing Worker routes, queues, customer-app data or Meta credentials are modified. Failed backup requests stay queued locally. The UI shows whether backup is pending; it must not be mistaken for live delivery.

Local messages/completed job content and attachments expire after 90 days while the gateway is running; tombstones remove their Cloudflare attachment copies when synced. Small contact/duplicate markers remain to avoid replay. If the PC stays offline, cloud cleanup waits for the gateway to resume. Private backup restore is an operator recovery procedure: stop the old gateway, keep the installation ID, restore records and pause all automation, resolve any ambiguous sends before restarting. WhatsApp session/profile recovery is separate; a backup is not automatic failover.

The control page binds only to `127.0.0.1`, requires a private same-origin HttpOnly cookie, validates Host/Origin and rejects cross-site access. Do not expose this port via public tunnels. Cloudflare record/media routes require the server-only secret and expose no CORS access. QR pairing/session data stay on this PC and are never included in cloud backups.

## Installation on another machine

Requires Node ≥24.15, Chrome, `zstd` available on PATH (or `ZSTD_DIR`), and `npm ci`. An optional local `zstd.exe` in `.local/bin` is supported. Official Windows binary: <https://github.com/facebook/zstd/releases/tag/v1.5.7>. The current machine has that prerequisite installed locally. OpenWA's optional ffmpeg install script is not needed for sending the existing MP3 recording as an audio attachment.

Copy `.env.example` to `.env`. Configure the private backup URL/token server-side, not in HTML. `.env`, `.local`, `.sessions`, WhatsApp profiles, databases, credentials, QR codes and dependency folders are ignored by Git. Deploy `cloud-worker.mjs` separately with D1 binding `DB`, private R2 binding `MEDIA` and secret `BRIDGE_TOKEN`; apply `schema.sql` additively. No cron or paid infrastructure is required for this setup.

Run `npm test` for duplicate/restart recovery, timing, opt-out, payment-pending, manual reply ordering, pagination, truthful ACK, retention, cloud monotonic updates, authentication and local HTTP protection tests. A successful test run or QR display does not prove WhatsApp linking or recipient delivery; validate with a consenting test sender after pairing.

## Standalone Android admin and backend controls

The Oracle gateway remains authoritative and private on loopback. The Android package `in.rekhaastrology.whatsappadmin` and browser `/admin` on the backup Worker use a separate authenticated relay. No WhatsApp credentials, SSH keys, backup token or default password are embedded in the APK. Sign in using **Admin app → Generate sign-in code** in the private owner panel. Codes are single use, expire in 10 minutes and are stored only as SHA-256 hashes. Sessions last 30 days, are HttpOnly/Secure and can all be revoked from the private panel. The APK needs only Internet access; attachments save through Android's file picker.

Owner commands expire after five minutes. The gateway polls every five seconds, records execution atomically with the idempotency key and queues manual sends through the existing engine. A command acknowledgement confirms execution/queuing, not recipient delivery. Cloud inbox data is a mirror and can lag while backup is retrying. Remote admin does not pair/relink the WhatsApp account or expose the private server port.

Backend monitoring shows server disk, memory, database allocation/reusable pages, attachment/profile file sizes, queue, uncertain sends, backup backlog and the D1 size reported by Cloudflare after a sync. File sizes refresh approximately once per minute; D1 size is measured after writes and covers the shared database. The provider dashboard remains the source for account-wide requests, R2 usage and charges; unavailable measurements are not displayed as zero. Delete controls require explicit confirmation, pause the contact, refuse active/uncertain sends, and remove content in bounded batches. Tombstones remove mirrored content/attachments after backup sync. Permanent receipt/contact markers prevent funnel replay; WhatsApp phone history is unaffected. SQLite reuses freed pages without an online blocking VACUUM.

## Capacity evidence and boundaries

An isolated development-PC benchmark used **1,000,000 synthetic customers + 1,000,000 history messages + 1,000,000 queued jobs**, with half the contacts paused. No real leads were contacted. After adding a peer-specific ready-job index, measured p95: latest 50 contacts **1.50 ms**, a deep 50-contact page **0.62 ms**, reserve/complete synthetic send **4.27 ms**, store new inbound message **2.82 ms**. Database allocation was **2.06 GB decimal** with about **55 MB** gateway RSS (browser excluded). These are local database measurements, not Oracle/WhatsApp/network/load guarantees. Reproduce with `node capacity-benchmark.mjs 1000000 <new-empty-output-folder>`; it refuses an existing DB unless a prior synthetic-only report is explicitly selected.

Cached counters avoid repeated history counts. Composite cursor indexes bound page queries. Per-customer dispatch heads exclude paused/blocked work so reservation needs at most two indexed head lookups. The backup outbox coalesces unsynced revisions by key and drains up to 20 batches of 50 per cycle. Attachment downloads are capped at two concurrently and 25 MB each, with a 2 GB disk reserve; text/message metadata still persists when media cannot be downloaded. Outgoing sends stop below 500 MB free disk.

**One million stored customers is not one million daily or concurrent WhatsApp customers.** This is still one linked WhatsApp Web browser with serial sends. WhatsApp restrictions, browser stability, provider limits and 24/7 host availability are outside these query benchmarks. The shared D1 database has a hard 10 GB maximum on Paid (Free is smaller); full histories/attachments and other applications can reach limits well before the contact count. Shard the backup by installation/customer, move cold history to R2 and capacity-test each shard before approaching that limit. No paid upgrade, new VM, extra WhatsApp account or automatic bulk campaign was enabled by this update.

The owner-approved payment QR was updated on 18 October 2026 to the Shahrukh shop image with UPI, Google Pay and PhonePe symbols. Its decoded payload matches the supplied QR exactly; it does not encode an amount. The original ₹29 caption is retained; the appended shop note was removed at the owner's request. The versioned QR URL avoids stale cached copies; already accepted/sent jobs are not replayed.
