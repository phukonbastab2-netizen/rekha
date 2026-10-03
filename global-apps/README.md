# Rekha Global — 12 country apps

Twelve independently branded astrology-themed web apps and connected Android customer apps, adapted from the Rekha Astrology messaging project. Each app has its own private owner inbox. The separate **Rekha Global Admin** Android app opens the collection's 12 owner inboxes.

**Start here:** [Apps and customer APKs](https://rekhaastrology.in/global-apps/preview/) · [Owner control centre](https://rekhaastrology.in/global-apps/preview/control.html) · [Admin Android APK](https://rekhaastrology.in/global-apps/preview/apks/rekha-global-admin.apk) · [Connected deployment](docs/CONNECTED-DEPLOYMENT.md)

All 12 services run at `https://rekha-<app-id>.phukonbastab2.workers.dev/`; their owner panels are at `/admin`. The collection also keeps separate offline web demos. APK 1.3.2-connected (versionCode 6) loads the live service, so messaging needs an internet connection. Preserve existing customer package IDs and the signing key for updates.

Release 1.3.2 adds a private voice relay through the existing backend, bounded audio startup and recovery controls for interrupted audio. It retains the communication-audio permission, playback recovery and two-minute participant leases. It includes 12 customer APKs and one admin APK. See [release notes](docs/RELEASE-NOTES-1.3.2.md), [relay details](docs/VOICE-RELAY.md), [phone test steps](docs/PHONE-CALL-TEST.md) and [verification](docs/VERIFICATION.md).

Replies are manual. Live AI, real payments and voice cloning are disabled. Voice calls use the authenticated app relay when configured; video retains WebRTC and may need TURN. Audio passes through the app server over encrypted connections and is not recorded or end-to-end encrypted. Calls need both apps open. Physical phone audio remains untested.

## Use the admin app

1. Install **Rekha Global Admin** or open the owner control centre in a browser.
2. Choose a country's **Owner inbox** link.
3. Sign in with that app's existing private owner password. Each app uses a separate password and session; the admin APK contains no passwords.
4. Open a customer conversation to reply, view deliberately shared attachments or start a foreground voice/video call. Choose Natural, Warm, Bright, Radio or Robot in the call controls for the outgoing microphone effect.
5. In the Android admin app, tap **Apps** to return to the 12-app list and choose another inbox.

Owner passwords stay outside GitHub and the APKs. The admin app can access conversations and submitted files; it does not read a customer's SMS or entire gallery.

| Country | App | Customer languages | Android package |
|---|---|---|---|
| United States | Luna Harbor | English | `in.rekha.global.lunaharbor` |
| United Kingdom | Willow Moon | English | `in.rekha.global.willowmoon` |
| South Africa | Southern Star | English, Afrikaans | `in.rekha.global.southernstar` |
| Thailand | Siam Dao / สยามดาว | Thai, English | `in.rekha.global.siamdao` |
| Kenya | Nyota Path / Njia ya Nyota | Swahili, English | `in.rekha.global.nyotapath` |
| Philippines | Tala Guide / Gabay ng Tala | Filipino, English | `in.rekha.global.talaguide` |
| Nigeria | Orion Naija | English | `in.rekha.global.orionnaija` |
| South Korea | Byeol Saju / 별사주 | Korean, English | `in.rekha.global.byeolsaju` |
| Sri Lanka | Serendib Stars / සෙරන්ඩිබ් තරු | Sinhala, English | `in.rekha.global.serendibstars` |
| Japan | Hoshi Note / 星ノート | Japanese, English | `in.rekha.global.hoshinote` |
| Singapore | Xing Light / 星光小语 | Simplified Chinese, English | `in.rekha.global.xinglight` |
| Hungary | Csillag Út | Hungarian, English | `in.rekha.global.csillagut` |

## What you control

- `apps/catalog.mjs`: country apps, names, colours, default languages, cultural guidance, currency and time-zone metadata.
- `shared/translations.mjs`: complete customer onboarding, privacy, sample-chat and deletion wording in 10 languages. English is available in every app.
- `shared/app.js` and `shared/style.css`: common customer behaviour and design.
- `shared/admin.*`: private owner inbox, personal replies, private notes/labels, pin/archive/block, saved replies, media library and per-conversation reply modes.
- `backend/`: the inherited messaging, private media, call signaling and workflow foundation. The build creates a distinct deployment per app.
- `android/`: Android launcher project with 12 independently installable customer flavours and one owner flavour.

Change a file through GitHub's pencil button, commit it, then rebuild with the steps below. Generated previews must be rebuilt after source edits. Source control is separate from the private customer inbox.

## Run and rebuild

Requires Node.js 24+ (the full Node distribution includes npm).

```sh
npm install
npm run build
npm test
npm run preview
```

Open `http://127.0.0.1:4318`. The build writes the static collection to `dist/` and connected server packages to `live/<app-id>/`. See [Android instructions](docs/ANDROID.md) for signed APK updates.

To refresh the committed static previews after a build, copy `dist/` into `preview/` and commit those files. Preserve `preview/apks/` until new signed APKs have been built. Do not copy private keys, `.env`, databases or owner passwords into GitHub.

## Current boundaries

- **Offline web demos:** localized onboarding, optional culture/reflection cards and sample conversations. Their conversation data lives only in the open device session and is cleared on reload; they have no remote owner inbox.
- **Connected services:** server-side sessions, owner-to-customer chat, private submitted attachments and owner tools. The 12 deployed Workers use fixed database namespaces and private storage prefixes. Owner controls and advanced call/media labels use English.
- **Android:** 12 customer APKs and one admin APK; Android 8+ required. They load their live HTTPS pages and require internet access. Physical phone/emulator runtime behavior remains unverified.
- No live payments, AI-provider credentials, birth-chart calculations, calendar conversion, auspicious-time calculation, app-store listing, practitioner certification or cloned testimonials are supplied. Prices are not invented for new markets.
- Voice calls can use the private app relay; video signaling and local microphone effects are included. Optional TURN is supported but inactive. Successful signaling or generated-audio tests do not establish audible two-phone speech. Background ringing and instant push are not implemented; end-to-end encryption is not claimed.
- Translations and cultural wording are drafts for native-speaker/cultural review before a commercial launch. Country selection uses a comparable survey proxy, not a global ranking of astrology belief. See [research notes](docs/COUNTRIES.md).

Existing Rekha website files and customer data are outside this folder and were not changed.
