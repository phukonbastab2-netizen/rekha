# Connected deployment — 3 October 2026

The 12 services run at `https://rekha-<app-id>.phukonbastab2.workers.dev/`, with each owner inbox at `/admin`. The collection hub links to all services. Android 1.3.2-connected (versionCode 6) has 12 customer builds using their compiled HTTPS addresses and one Rekha Global Admin build opening the owner control centre. Original customer package IDs and the signing certificate are preserved for updates. Physical-device validation remains outstanding.

## Infrastructure

This deployment uses one newly created D1 database, `rekha-global-connected`, with fixed `g01_` through `g12_` table and index namespaces. Existing databases were not modified. Each Worker selects its own namespace in server code; customers cannot select an app namespace. SQL values remain bound parameters. Tests cover cross-app customer/owner session rejection and wrong-origin writes.

The existing private Rekha R2 bucket is bound through a wrapper that prepends `global-connected/gXX_/` to every object read, write, head and deletion. Files outside these prefixes are not accessible through the new apps. Creating a new bucket was rejected by the current credential's permissions; the existing Worker binding supports private file operations. No public bucket or public media URL was enabled. Database tables and storage prefixes are logically isolated, while infrastructure limits and Cloudflare account administration are shared.

Release 1.3.2 adds a separate `CALL_AUDIO_RELAY` SQLite Durable Object binding to each of the 12 Workers, using the `voice-relay-v1` migration. The object's database wrapper selects the same fixed app namespace as its HTTP routes. Only call ID, expiry and ended status persist; audio stays in memory while forwarding. Existing passwords, D1 tables and R2 prefixes are preserved. No D1 schema initialization is needed for this release.

Only Luna Harbor registers the maintenance cron. It rotates through two app namespaces each minute; the six minutes from 02:17 through 02:22 UTC include daily retention cleanup. This avoids a separate pair of cron triggers for every app. Shared hosting is intended for modest usage; database and storage quotas, availability and underlying billing remain account-wide. No paid-plan upgrade or paid AI/TURN provider was enabled.

## Access and limitations

Each app has a unique generated admin password. Passwords and the Cloudflare credential are kept outside the source, APKs and GitHub. Never add them to this repository. The owner's private local access file lists the addresses and passwords; it should be backed up securely.

Customer replies are manual. AI, paid checkout and voice cloning are not enabled. Voice calls use the private WebSocket relay when configured; video uses WebRTC and may need TURN. Calls remain foreground-only. Physical phone audio is unverified. See [voice relay](VOICE-RELAY.md) for its security and deployment boundaries.

The admin APK is `preview/apks/rekha-global-admin.apk` (package `in.rekha.global.owner`). Its entry page is [control.html](https://rekhaastrology.in/global-apps/preview/control.html). Choose **Owner inbox** for a country and enter that app's existing private password. The native **Apps** button returns to the 12-app list. Passwords are not bundled; each service authenticates its own owner session. Uploaded files remain scoped to the submitting conversation and app storage prefix.

Release 1.3 checks for incoming calls every approximately five seconds while idle, and polls an active call every approximately 1.5 seconds. Hidden pages pause polling and resume when visible. Ending or declining a call leaves the incoming listener running. A delayed microphone permission result cannot create or accept a call after its client was cancelled. A disconnected established call gets up to 15 seconds to recover, then ends and releases its media resources. Release 1.3.1 adds private participant heartbeats: an active call is ended during the next call-route request if either participant has been absent for over two minutes. This prevents an abandoned call blocking later calls for its full one-hour limit. No schema migration was required.

Optional Cloudflare TURN support can issue short-lived connection credentials for an authenticated participant in a current call. Each call fetches fresh settings using its own call ID. No TURN provider was activated: the current account credential received HTTP 403 from Cloudflare TURN management. No paid provider or plan upgrade was enabled. Video defaults to STUN-only; voice can use the private app relay. Network and device behavior still require testing. See [TURN setup](TURN-SETUP.md) for the exact server secrets and later configuration steps.

## Rebuilding

1. Run `node scripts/build.mjs` and the tests. Generate connected output with `node scripts/connected.mjs`; `CONNECTED_OUTPUT` selects a destination outside the repository.
2. For deployment configs, provide `DEPLOY_ACCOUNT_ID`, `DEPLOY_DB_ID` and `MEDIA_BUCKET` locally. These are infrastructure identifiers, not owner credentials. Preserve the namespace ordering in `apps/catalog.mjs` after deployment; reordering it would select different table prefixes.
3. Deploy each generated Worker with Wrangler. Preserve its `ADMIN_PASSWORD_HASH` secret. Apply the combined schema only to the intended new collection database. Do not replace or initialize an existing unrelated database.
4. Rebuild and sign Android with the existing key. Keep app hosts, package IDs and signing certificates stable for updates.

The GitHub repository holds source and public downloads. Editing it does not automatically redeploy Cloudflare Workers; the deployment step above is still required.
