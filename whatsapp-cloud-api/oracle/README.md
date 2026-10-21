# Separate Oracle inbox for manual replies

The original ₹29 funnel remains on Cloudflare. Its words, timing, accepted
message IDs, pending follow-ups and sending gates do not move or restart.
Oracle does not run an automatic funnel, linked browser or OpenAI model.

`inbox-entry.mjs` adds two private **read-only** endpoints to the existing
Worker: `/admin/inbox-index` and `/admin/inbox-sync`. They use the existing owner
bearer token, read existing Durable Object records directly, and never call
`put`, `load`, `schedule` or the send transport. All original public requests
continue through `entry.mjs`. The original Worker classes remain authoritative.

`oracle/manual-server.mjs` binds to loopback and is available through the
owner's existing Oracle SSH access on port 4342. No public DNS, Cloudflare
Tunnel or public server port is required. Its private browser session uses an
HttpOnly SameSite cookie and same-origin JSON checks for sending.

The inbox polls recent Cloudflare conversations every ten seconds, caches
customer texts and original funnel messages on Oracle SQLite, and sends a
manual text only after the owner presses Send. Manual replies and their
idempotency journal stay on Oracle. Repeated clicks use the same request ID;
an interrupted or ambiguous send is held for review rather than auto-retried.
The original first five replies must finish first. The number's account hold,
opt-outs, test-contact gate and 24-hour customer reply window still apply.

## Scope and limits

- This is an additional manual inbox, not a migration or replacement of the
  working Cloudflare funnel. That funnel retains its existing database writes;
  Oracle's history and manual outbox require no extra Cloudflare database.
- Original funnel receipts show their signed delivered/read states. Manual
  replies show **accepted by WhatsApp**; this does not prove delivery or read.
- The source discovery index contains the most recent 100 conversations. Once
  imported, conversations remain on Oracle. A burst that replaces the entire
  source index between polls can miss discovery; this is not a guaranteed
  complete phone-history mirror or a verified 10,000-lead/day inbox.
- Historical inbound media records contain their type and text only. Their
  original binary attachments are not present in the old Worker storage.
  Funnel images, videos and audio use the existing public media links.
- WhatsApp messages sent directly from the phone are not exposed by this Cloud
  API history. Replies sent in this separate inbox are saved locally.
- No untested public/mobile access or high-availability claim is made. The
  Oracle service runs without the PC; the PC opens an SSH tunnel to view it.

Run the original test suite plus `inbox-entry.test.mjs` and
`oracle/inbox.test.mjs`. Keep `.env`, SQLite files, SSH keys and API tokens
outside Git. `backup.mjs` creates a consistent Oracle-local SQLite backup;
such a backup alone does not protect against losing the VM's disk.
