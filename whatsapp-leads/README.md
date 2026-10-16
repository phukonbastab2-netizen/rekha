# Rekha WhatsApp lead assistant

Prepared for Meta app `3058202874566006`, WABA `1630536172004218`, registered number `+15812636719` and phone number ID `1368894806304328`, verified in Meta's production setup on 16 October 2026.

The separate `rekha-whatsapp-leads` Worker answers incoming text in Hindi, English or Hinglish and points interested customers to https://rekhaastrology.in. It uses OpenAI Responses instructions, not model fine-tuning. The existing `whatsapp` Worker, its media funnel, bindings and schedules are unchanged. Check for other subscribed apps/automations before activation so customers do not receive two flows.

## Current rollout

- Callback: `https://rekha-whatsapp-leads.phukonbastab2.workers.dev/webhook`
- Health/readiness: `/health`
- Deployed with `SEND_ENABLED=false` and no scheduled trigger. Meta token and app secret are now stored as Worker secrets; the OpenAI key is pending owner entry.
- The verification token is a Worker secret. Its setup copy is kept outside Git in the workspace's private Cloudflare folder.
- The Meta callback is saved. App-level `messages` subscription and WABA app subscription were verified using Meta's API. No messages have been sent.
- Graph API `v26.0` was observed in Meta's webhook setup and successfully used for app subscription verification. OpenAI model `gpt-6-luna` uses `reasoning.effort=none` for short support replies, per its official model documentation. Project access and a real reply remain to be verified after key entry.

## Finish activation

1. Store `META_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN` and `OPENAI_API_KEY` as **Worker secrets**, using Cloudflare Settings -> Variables and Secrets. Never commit keys or paste them in chat. The Meta token must belong to the app/account above and allow `whatsapp_business_messaging`. Follow Meta's system-user/token flow and use only necessary assets/permissions.
   Meta secrets are already configured in this deployment. For owner-operated OpenAI key entry, run `node secure-key-setup.mjs` and open its loopback URL. The form checks model access and saves the key directly to Cloudflare without local persistence or paid generation. It expires after 30 minutes. Do not expose it through a public tunnel. Cloudflare's existing Wrangler session must be current.
2. Set `OPENAI_MODEL` to an available Responses model in the owner's OpenAI project; set `GRAPH_API_VERSION` to the supported version shown in Meta's API setup. Keep `SEND_ENABLED=false`.
3. With the owner's required approval for persistent API access, configure Meta's callback and matching verify token, and subscribe to `messages`. Meta displays a separate WABA subscription switch; it was already on during inspection. Verify both app field subscription and WABA subscription.
4. Validate Meta token access to the configured phone, then make one owner-approved small OpenAI test using noncustomer text. Credentials must not appear in output/logs.
5. Before enabling, review/drop any preactivation pending jobs that should not be answered. Check that no legacy automation is subscribed to this number. Add `* * * * *` to the new Worker's cron triggers, and set `SEND_ENABLED=true` only after credentials and test recipient are ready. Keep deployment configuration synchronized with live variables; do not redeploy this disabled config over an active service accidentally.
6. Ask the owner to send an inbound WhatsApp message from their own phone. Check the reply and `delivered`/`read` webhook in `lead_jobs`. A successful challenge or `accepted` state does not prove delivery.

## Operational behavior

- Raw-body HMAC SHA256 verification before processing. Events must match the configured WABA and phone ID. Body size is bounded.
- Text/interactive-title inputs only; images, audio and personal documents are not downloaded or sent to OpenAI.
- Recent incoming messages are deduplicated by WhatsApp ID in D1. Customer locks and conditional job claims prevent competing processors from double sending.
- Replies remain within the 24-hour service window. There is no unsolicited campaign or template sender.
- STOP/unsubscribe pauses automation immediately, even during generation. START resumes only if newer than the last control message. Requests for a person also pause automation; the owner must follow up. This service has no separate human inbox UI yet.
- Each generation uses `store:false`, up to four recent turns and 300 output tokens. This setting does not mean zero provider retention; review the applicable OpenAI project data controls.
- Defaults: 100 total AI requests/day and 12 accepted/ambiguous sends per contact/day. Failed attempts still consume the global reservation. Raising limits can increase charges and requires owner review.
- One queued message is processed after an inbound webhook; cron processes up to five per minute for recovery. This initial service is bounded; it is not a high-concurrency campaign engine.
- Meta acceptance, delivery, read and failure states are separate. Ambiguous timeouts/interrupted processing are marked `unknown` and never resent automatically. OpenAI/Meta errors are marked failed for owner review, not retried in a loop.
- Message bodies/replies expire after seven days when cron runs. Opt-out records persist. Logs contain generic error codes only. Add explicit retention/deletion handling if the support workflow changes.
- To pause, set `SEND_ENABLED=false`. Do not remove opt-out records while cleaning content.

## Checks

Run `node --test worker.test.mjs` from this folder. Tests use real SQLite and fake provider requests; they do not spend API credits or send WhatsApp messages. Run the existing installed Wrangler with `deploy --dry-run --config wrangler.jsonc` for a bundle check.

Official API guidance: [OpenAI Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses), [Meta WhatsApp webhooks](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview/).
