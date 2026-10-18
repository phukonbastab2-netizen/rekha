# Private OpenWA dashboard deployment

The production WhatsApp browser now runs in the video project's gateway, [rmyndharis/OpenWA](https://github.com/rmyndharis/OpenWA), pinned to **v0.23.6**, commit `31f75dd98a6492f2b73c6835be5d2317d4410cd5`. The original Rekha funnel remains a separate durable consumer and sender. It does not create a second WhatsApp browser in REST mode.

`openwa-v0.23.6.patch` contains the reviewed local changes to this upstream version. Apply it to a clean checkout of the pinned commit with `git apply`. Install the locked backend and dashboard dependencies and run both builds. Do not apply this patch blindly to a different upstream release. Upstream is MIT licensed; its copyright and license remain in the checkout.

## Connections

- Oracle OpenWA service: `rekha-video-openwa.service`, loopback port **2785**.
- Original funnel service: `rekha-whatsapp.service`, loopback port **4341**.
- Owner SSH tunnel: local **4341 → server 2785**, local **4342 → server 4341**.
- New private dashboard: `http://127.0.0.1:4341/chats` on the owner PC while the tunnel is running.
- Original funnel and capacity controls: `http://127.0.0.1:4342/`.

Both server services are enabled at boot. The PC tunnel is only for private dashboard access; closing the PC does not stop the server or funnel. Never expose either loopback service directly to the internet.

## Private configuration

Set `BIND_HOST=127.0.0.1`, `AUTO_START_SESSIONS=true`, `ALLOW_AUTH_RESET=false`, and `MAX_CONCURRENT_SESSIONS=1` in the gateway's private environment. The Chromium executable is `/snap/bin/chromium` on this host. Its persistent session directory is beneath `/home/ubuntu/snap/chromium/common/rekha-openwa-video/sessions`, outside release/build directories. Keep the configured Linux user, auth path, API key pepper and session ID stable across releases. A readiness timeout must not erase the login profile.

The funnel environment selects `WHATSAPP_PROVIDER=openwa-gateway` and defines `OPENWA_API_URL`, `OPENWA_API_KEY`, `OPENWA_SESSION_ID`, `OPENWA_WEBHOOK_SECRET` and `OPENWA_ACTIVE_SINCE`. Set `MOBILE_ADMIN_ENABLED=false` when using only OpenWA's Chats screen; this disables the separate mobile admin command bridge without deleting saved history or disabling backups. Keys are server-only, never browser source or Git. The signed webhook targets **server** `http://127.0.0.1:4341/api/provider/openwa`; the owner tunnel's local port does not change that destination.

Subscribe to received, sent, ack, failed, edited and revoked message events. Permit only loopback for this webhook's private-network exception. The operator API key is limited to the intended session and loopback address. Keep dashboard master credentials private.

## History and recovery

The adapter combines signed events, repeated head reads, a durable paginated database sweep, and a bounded native-chat history sweep. It mirrors phone-originated outgoing messages as well as incoming messages. It uses WhatsApp's opaque message identity, never the gateway database UUID, for duplicate receipts. Exact `@lid` identities are preserved; numbers are not guessed or merged by display name.

The saved activation boundary prevents old imported history from becoming arbitrary new leads. Do not move that boundary just to force a replay. Authorized missed-lead recovery is separately bounded to the original recovery-to-cutover interval and guarded by existing contact/first-stage markers. Existing receipts and jobs are never cleared to resend messages.

The chat list includes native WhatsApp conversations plus eligible stored-only conversations. Stored-only rows are explicitly marked **Saved history** and do not invent a current unread count. A combined chat count is not proof of complete phone history. Native history is limited to what WhatsApp makes available to this linked device.

Payment messages and attachments remain **pending**, not proof of settlement. Original wording, five-second spacing and one-hour follow-up delay are unchanged. Uncertain sends pause that contact instead of blindly retrying and duplicating messages.

## Safe deployment and verification

1. Build and test before touching a running service. Keep a versioned rollback source and private database backup.
2. Stop the funnel only when no send is in flight. Stop the gateway gracefully before backing up its SQLite data and Chromium auth profile. Keep these backups private and out of Git.
3. Start the gateway and verify that the same session returns to ready without a QR. Then start the funnel and check readiness, webhook receipt and backup status.
4. Compare known contacts through verified WhatsApp contact mappings; literal phone-number IDs may differ from the actual `@lid` IDs.
5. Verify recent incoming, phone outgoing and provider delivery acknowledgements. An HTTP success or a running process alone does not establish recipient delivery.

Backend and dashboard databases, auth profiles, API keys, private media and customer history must never be included in this deployment directory or repository. The Oracle sender operates independently of Cloudflare backup availability. Cloudflare backup capacity depends on the account's Workers/D1 plan; paying for R2 alone does not change D1 limits.

## 10,000 daily leads: measured preparation, not a delivery promise

The checked-in [Oracle benchmark report](capacity-10k-20261018.json) is synthetic and contains no customer data. In a disposable database on the existing two-CPU Oracle host, it stored 10,000 leads and 50,000 initial jobs in 63.25 seconds, suppressed all 1,000 duplicate probes, and exercised 18,594 simulated send completions before a deliberate four-minute safety limit. It did **not** drain all 50,000 jobs or test WhatsApp delivery. Inbound storage p95 was 12.38 ms; reserve/finish p95 was 17.06 ms. Reproduce with `node daily-capacity-benchmark.mjs 10000 <new-report-path>`.

The initial five-step funnel requires 50,000 messages/day (34.72/minute continuously). With one reminder and all four follow-ups, the requirement is 100,000/day (69.44/minute). Completion-triggered refill removes an avoidable one-second idle interval while retaining two simultaneous sends and the original per-customer gap. Real media upload speed, WhatsApp readiness/account restrictions, peak traffic, storage growth and cloud-backup throughput still need operational measurements before that daily volume is verified.

The private controls' Backend section and `/api/sender-capacity` show bounded recent operation latency, accepted/deferred/blocked/uncertain counts and oldest ready-job delay. These measurements describe API operations, not delivered/read messages. The sample window resets after a process restart.

Only typed `ENGINE_NOT_READY` and `SEND_PACING_LIMITED` refusals established **before sending** defer the same job automatically. Backoff starts at five seconds, grows to a five-minute exponential cap, and respects an explicit longer Retry-After. Twelve refusals block the job for review. Generic failures, timeouts or unknown results retain the no-blind-retry rule. A graceful shutdown lets an active send finish and retain its provider ID before closing the adapter.

Production opts into `MEDIA_SEND_CACHE_URLS` using only the seven exact public URLs from the checked-in original funnel. This cache is limited to 64 MiB and ten minutes, coalesces simultaneous downloads, skips configured proxies and does not cache failed downloads. Misses still use the original SSRF-safe download path. Each send receives a separate media object. The dashboard build uses `VITE_REKHA_FUNNEL_URL=http://127.0.0.1:4342/` for the private controls link.

The host and shared Cloudflare database remain finite. A 90-day flow at 10,000 leads/day is 900,000 customer records plus several million messages and media. Disk/backup warnings and actual growth must guide retention and any later storage changes; the synthetic database report cannot establish an unlimited or zero-failure service.

Duplicate delivery acknowledgements do not rewrite messages or enqueue new backup revisions. A typed D1 write-quota response pauses cloud requests until the advertised reset, preserves unacknowledged local changes, and survives a process restart. An authenticated owner can request an early recheck after changing the plan; only an exact server acknowledgement advances the backup cursor. This pause never stops the local WhatsApp sender.

Retention scans at most 200 records with a cooperative 75 ms budget per pass, yields for one second while work remains, and checks idle queues once a minute. A durable indexed cursor prevents old held jobs from stranding later expired content. Queued, sending, uncertain and blocked jobs keep their outgoing review evidence. Attachment deletion is bounded and driven by expired-message records, rather than an unbounded filesystem walk. Once-only receipts and consent/contact markers remain intact.
