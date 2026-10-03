# Rekha Astrology app source

This directory contains the customer app, private owner panel, Cloudflare backend and two Android WebView projects. The website in the repository root is separate and stays unchanged. That static website can be hosted separately; the authenticated chat needs the Cloudflare Worker.

Web and customer Android source package: **0.9.3-preview**, including a familiar mobile chat layout with a compact contact header, grouped bubbles, attachment sheet and microphone/send composer, direct feature permission requests and in-app retry, bounded chat updates, searchable customer pages, adaptive polling, reliable message retries, the owner app editor and local admin call voice effects. Signed APK downloads are hosted separately from this source repository.

Customers have one private conversation with Rekha. The owner can send text, images, video, audio, PDFs and ordered collections without waiting for a customer reply. Ads are disabled. Payments remain a preview with no real charges. No passwords, payment-card collection, OTP access or private-device scraping is implemented.

The current customer startup requires the complete signup video, name and date of birth, Send, and a five-second preparation screen. Chat begins with only the configured shared kundli image and “Your kundli.” The old three-video customer page is removed. `CUSTOMER_AUTOMATION_ENABLED` defaults to false: previous sample replies, workflow triggers and scheduled deliveries are stopped; customer sends stay uncapped by old free-reply credits. Manual owner replies, media access, rate/storage limits and retention cleanup remain available.

An existing installation opens its saved conversation first, including offline. IndexedDB stores received message pages, queued sends with stable client IDs and selected file bytes, and composer drafts without timed expiry. Restored sends wait for the server to confirm the same private conversation before retrying; writes also carry an expected chat ID to prevent a changed cookie from putting them in another chat. Reopening resumes the saved change cursor, including edits and deletions on older archived pages. The public offline shell cache excludes chat APIs, private files and owner routes. Server retention is unchanged; shared files still need server access. Uninstall or cleared device data cannot be recovered. Explicit whole-chat deletion clears the device archive too. Offline or expired sessions can clear only their local archive, with the remaining server copy clearly explained. Customer Android Back and the chat header Back flush saved state and close the app rather than opening privacy; an unsaved draft stays open on a storage failure. Browser tabs may need to be closed by the user.

## Run the checks

Install Node.js 24.15 or newer, then run these commands from this directory:

```sh
npm ci
npm run build
npm test
```

The lockfile pins the dependencies. Building checks JavaScript syntax and generates `cloudflare/worker-bundle.mjs` from the tracked source and public assets. The generated bundle is ignored by Git. Tests use temporary local D1/R2 resources and fake test identities; they make no production changes. They cover the original Node prototype, private messaging, guided delivery, retries, scheduled work, owner settings and the exact generated Worker with actual authentication and media-access checks. Browser and actual phone testing remain separate.

The repository workflow runs these same build and test commands. It has no deployment credentials and does not deploy.

## Capacity on the existing resources

The target is 100,000 registered customer profiles with fewer people online together. Current web clients fetch 80 recent messages, use revision deltas, and load older messages on request. The owner inbox pages and searches names on the server. Hidden/offline screens stop periodic reads, idle screens back off, and durable indexed work replaces repeated history scans. Legacy clients remain compatible.

See [the capacity report](docs/CAPACITY-REPORT.md) for measured local data volume, query plans, request limits and remaining constraints. Reproduce the synthetic benchmark with `node scripts/benchmark-capacity.mjs --profiles=100000`. It creates an ephemeral local database and does not send traffic to Cloudflare. Registered-profile volume is different from concurrent chat throughput; these results do not guarantee 100,000 simultaneous customers or unlimited activity within an account's daily quotas.

Existing installations need the additive scale, workflow, attachment-quota and call indexes migrations before serving this version. Use `applyScaleMigration` and the bounded `backfillScaleCache` helper in `cloudflare/scale-migration.mjs` to resume interrupted upgrades safely. Keep account resources, bindings, secrets and existing schedules intact.

## Main directories

| Directory | Purpose |
| --- | --- |
| `public/` | Customer and owner web screens, original UI assets, three supplied intro clips |
| `cloudflare/` | Current Worker, D1 schema, additive migrations and bundle builder |
| `android/` | Customer APK source, package `in.rekhaastrology.astrorani` |
| `admin-android/` | Separate owner APK source, package `in.rekhaastrology.admin` |
| `src/` | Earlier Node provider/prototype server used by its regression tests |
| `tests/` | Portable prototype and Miniflare tests |

Use the Worker for the current owner editor, rich messaging and guided flow. `npm start` runs the older Node prototype only and requires your own `.env`, copied from `.env.example`; it does not implement every current Worker API.

## Local Worker preview

1. Run `npm ci` and `npm run build`.
2. Copy `.dev.vars.example` to `.dev.vars` and privately set `ADMIN_PASSWORD_HASH` to the SHA-256 hex digest of an owner password you choose. No default password is provided.
3. Initialise the local database:

```sh
npx wrangler d1 execute rekha-astrology --local --file cloudflare/schema.sql --config wrangler.example.jsonc
```

4. Put the optional intro clips into local R2:

```sh
npx wrangler r2 object put rekha-astrology-media/intro/welcome.mp4 --local --file public/intro/welcome.mp4 --content-type video/mp4 --config wrangler.example.jsonc
npx wrangler r2 object put rekha-astrology-media/intro/introduction.mp4 --local --file public/intro/introduction.mp4 --content-type video/mp4 --config wrangler.example.jsonc
npx wrangler r2 object put rekha-astrology-media/intro/testimonials.mp4 --local --file public/intro/testimonials.mp4 --content-type video/mp4 --config wrangler.example.jsonc
npm run worker:dev
```

Open the local address printed by Wrangler. The owner panel is `/admin`. Intro playback can be skipped; it does not autoplay.

## Deploy on your own Cloudflare account

1. Authenticate with `npx wrangler login` in your own session.
2. Create a D1 database and an R2 bucket, or use the existing app resources. Copy `wrangler.example.jsonc` to the ignored `wrangler.jsonc`, replace the placeholder database ID, and set your bucket and Worker names. The template contains no account ID, route or credentials.
3. For a **new** database, execute `cloudflare/schema.sql`. For an existing app database, back it up and apply the relevant `migration-*.sql` files once. Keep the existing conversations and media grants.
4. Set the private owner hash through the interactive secret prompt:

```sh
npx wrangler secret put ADMIN_PASSWORD_HASH --config wrangler.jsonc
```

5. Upload the current required MP4 under `intro/onboarding.mp4` and choose the shared kundli image from the private owner library. The owner upload route is `/api/admin/intro/onboarding`. Old introduction clips remain stored for compatibility, but no customer page selects them. Keep `CUSTOMER_AUTOMATION_ENABLED` false until a new sequence is deliberately implemented. Upload library assets through the owner panel instead of publishing customer files.
6. Run `npm run build`, `npm test`, then review a dry-run before deploying:

```sh
npx wrangler deploy --config wrangler.jsonc --dry-run --outdir build/worker
npx wrangler deploy --config wrangler.jsonc
```

Bind the Worker to the app subdomain, such as `astrorani.rekhaastrology.in`. Keep the repository-root website and its current hosting intact; do not add a root-domain wildcard route unless you explicitly intend to replace that website. The minute cron advances guided messages and the daily cron handles retention cleanup.

The Worker currently returns preview payments and has no enabled real AI/payment integration. A successful deploy or HTTP response alone does not verify phone playback, calling, payment collection or store publication.

## Owner controls

See [OWNER-GUIDE.md](OWNER-GUIDE.md). Sign in through `/admin` or the separate owner APK using your private owner password. The owner application contains no embedded password.

## Build Android applications

Both projects use Android Gradle Plugin 8.9.1, Java 17 source compatibility, compile SDK 36, target SDK 35 and minimum SDK 26. Open either directory as a Gradle project in Android Studio, or use a compatible Gradle installation:

```sh
gradle -p android assembleDebug
gradle -p admin-android assembleDebug
```

The source uses the public Rekha app host. Change the allowed host and app URLs in `MainActivity.java` when deploying a separate installation. Confirm camera, microphone, downloads, notification settings and navigation on actual devices.

The provided PowerShell `build.ps1` scripts accept your JDK, SDK, Gradle executable, private signing directory and output path. Keep signing material outside this repository. Preserve the customer application's existing release key when shipping an update. No key, password, signed APK, Android build cache or `local.properties` file is included here. Put APK downloads in release storage only after you build and verify them; the preserved download page needs those release objects.

## Current boundaries

The main `rekhaastrology.in` homepage serves the guided download page: Hindi/English, three large Android install steps, optional help and an iPhone browser option. The download response uses the same `RekhaAstrology.apk` filename shown in the guide. Download clicks do not claim that installation has finished.

Blue double ticks confirm that an outgoing message has reached the recipient's chat. Long-press a message to see its receipt label; read labels use the actual read cursor. Pending or failed sends show their current status.

Original send and receive tones play in the open chat after the first tap or key press. Chat sounds can be muted from the customer's conversation menu or the owner's toolbar. Old messages, edits and repeat updates stay silent; calls, voice recording and media playback pause the tones. Background message alerts use Android notification settings.

Tap Voice or Camera to request only that feature's Android permission inside the app. Use **Feature access** to set up microphone, camera and optional message alerts directly. A dismissed or retryable denied request offers an in-app retry. Only a confirmed permanent denial offers Android app settings; the APK does not send customers to browser site settings. Files are chosen through the phone's picker; the app does not request SMS, full-gallery or all-files access.

Admin calls offer Natural, Lower pitch, Higher pitch, Warm and Robot effects. Audio processing stays on the device and does not clone another person's voice. Install the updated Android APK to receive the native permission bridge.

- The owner/server can read conversations; chats are not end-to-end encrypted.
- Foreground voice/video calls require both apps to remain open. TURN relay and real device/network validation are separate from local signaling checks; there is no background call ringing.
- Optional Android message alerts use periodic checks, not instant push delivery.
- Birth details are saved with consent; a calculated kundli still needs a calculation engine, birth time and birthplace.
- The initial supplied media is owned project content. Private library uploads, customer records and database exports are not included in this source package.

Do not commit `.env`, `.dev.vars`, live Cloudflare config, owner access files, database data, signing material or tokens. The included ignore rules and source inventory document the intended package boundary.
