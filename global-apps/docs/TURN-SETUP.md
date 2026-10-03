# Optional TURN setup for video calls

Release **1.3.2-connected** uses an active private, same-origin WSS relay for voice calls. Voice calls do not need TURN. Voice audio passes through this app's server and is not recorded; admin voices may use effects. If voice-call audio pauses, use **Resume call audio**. If altered microphone audio pauses, use **Resume microphone** or **Use Natural**. The 117 automated tests do not verify physical-phone sound or cross-network device calls; those checks remain pending.

Video calls continue to use WebRTC. TURN helps a video call connect when the two devices cannot establish a direct connection. The current collection has **no activated TURN relay**: the available Cloudflare management credential returned HTTP 403 when checking TURN management. A credential that can deploy Workers may not have permission to manage Realtime TURN. No paid relay activation or plan change was performed automatically. If incoming video-call sound is blocked, use **Play call audio**.

The source includes server-side generation of temporary Cloudflare TURN credentials. Follow [Cloudflare's Generate Credentials guide](https://developers.cloudflare.com/realtime/turn/generate-credentials/) to obtain a TURN key in your own account. Review the account's applicable service terms and billing before enabling it. The long-term key must remain on the server; only the generated, expiring connection credentials belong in a client.

## Required secrets

These names are exact:

| Worker secret | Value |
| --- | --- |
| `TURN_KEY_ID` | The Cloudflare TURN key ID. |
| `TURN_API_TOKEN` | The API token for generating credentials for that TURN key. This is the value Cloudflare's example calls `TURN_KEY_API_TOKEN`. |

An owner of the Cloudflare account must obtain these values manually through the TURN service. A customer does not enter them. The app admin inbox has no field for managing Cloudflare credentials. Do not put them in GitHub, APKs, public configuration, screenshots, logs or ordinary Wrangler `vars`.

## Add them to the intended Worker

Use the **generated connected deployment config** for an existing collection service. `scripts/connected.mjs` writes one `wrangler.json` per app beneath the local `CONNECTED_OUTPUT` directory when the deployment identifiers are supplied. Verify its Worker name, account, D1 binding and R2 binding before proceeding. Do not substitute the standalone `live/<app-id>/wrangler.example.json` for the deployed shared-infrastructure config.

For example, replace the placeholder path below with the actual generated config for Luna Harbor:

```powershell
npx wrangler secret put TURN_KEY_ID --config "C:/path/to/connected/luna-harbor/wrangler.json"
npx wrangler secret put TURN_API_TOKEN --config "C:/path/to/connected/luna-harbor/wrangler.json"
```

Enter each value in Wrangler's private prompt. [Cloudflare documents that `secret put` immediately deploys a new Worker version](https://developers.cloudflare.com/workers/configuration/secrets/#adding-secrets-to-your-project). Complete both writes before testing calls; an incomplete pair produces a relay configuration error. The commands update only these named secrets. Preserve `ADMIN_PASSWORD_HASH`, all other secrets, existing bindings, namespaces, service addresses and customer data. Do not recreate databases, rerun initialization against unrelated data or reset owner passwords for this setup.

Repeat for each intended country Worker using its own generated config. Each Worker needs its configured secret pair. Alternatively, the account owner can add both as **Secret** values under that Worker's Variables and Secrets settings and deploy together. Instructions here do not execute either method or create a TURN resource.

## What the server does

The call configuration endpoint authenticates the customer or owner before generating any credentials. When TURN is configured, the request needs the ID of an unexpired, current call. Customers can request settings only for their own conversation. Requests are limited to four per actor and call per minute. The endpoint returns `Cache-Control: no-store`; do not share or cache its credentials between users.

The integration uses a **3,600-second credential lifetime**. The reusable helper defaults to 600 seconds, but the call route explicitly selects 3,600. This lifetime starts when credentials are requested. Keep calls within their credential lifetime. Extending calls or selecting a shorter lifetime requires client-side renewal before expiry; the current app does not renew TURN credentials during an established call. Cloudflare describes renewal with `RTCPeerConnection.setConfiguration()` in its [credential guide](https://developers.cloudflare.com/realtime/turn/generate-credentials/).

Only the documented standard Cloudflare STUN/TURN hosts are accepted. Requests have a five-second timeout and a 16 KB response limit. Malformed responses, reflected server tokens and non-successful provider responses are rejected. Provider error bodies and server tokens are never forwarded to the client.

## Fallback and verification

- With neither TURN secret configured, video calls use the existing STUN-only settings, so restrictive mobile or workplace networks can still prevent video calls. Voice calls with the private WSS relay configured use that relay independently of TURN.
- With a missing, invalid or rejected configured TURN secret, or a provider timeout, video-call configuration returns HTTP 503 with an understandable message. It does not silently claim a TURN relay is working or downgrade the configured provider to STUN.
- Unauthenticated requests fail; unknown, expired or unrelated call IDs are rejected. Excess credential requests are rate limited.

After configuration, use two actual devices on different networks with both app pages open. Start and answer a video call, verify audio in both directions, mute/unmute, voice effects and clean call ending. Confirm a selected ICE candidate pair uses a relay before calling TURN traversal verified. Check only non-secret status and connection statistics; do not log complete credential responses.

Synthetic browser audio checks are **not evidence of physical-phone sound, cross-network device calling, TURN traversal, Android permission behavior or background ringing**. Those checks remain separate from code, signaling and relay tests.
