# Rekha Global — 12 country apps

Twelve independently branded astrology-themed web apps and signed Android **offline previews**, adapted from the Rekha Astrology messaging project. Includes a connected server package and private owner web inbox for each app.

**Start here:** [Open the preview collection](preview/index.html) · [Owner control centre](preview/control.html) · [Android APK downloads](preview/apks) · [Deployment guide](docs/DEPLOYMENT.md)

The preview collection is static and can be hosted on GitHub Pages or another static host. A file shown on GitHub is source/download content; it is not proof that a web server is live.

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
- `android/`: Android launcher project with 12 independently installable country flavours.

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

- **Offline web/APK previews:** localized onboarding, optional culture/reflection cards, sample conversations, text export and deletion. Conversation data lives only in the open device session and is cleared on reload. These previews have no remote owner inbox.
- **Connected packages:** real server-side sessions and owner-to-customer chat; private attachments and inherited owner tools. Tested locally, not deployed for these new apps. Each needs its own database, storage and owner secret. Owner controls and advanced call/media labels use English.
- **Android:** all 12 release APKs are signed preview builds; Android 8+ required. They bundle the preview and work without a hosted server. They do not silently point at the existing Rekha customer service. No phone/emulator was connected for runtime testing.
- No live payments, AI-provider credentials, birth-chart calculations, calendar conversion, auspicious-time calculation, app-store listing, practitioner certification or cloned testimonials are supplied. Prices are not invented for new markets.
- Voice/video signaling is inherited; reliable calling needs HTTPS, permissions and usually a TURN service. No background ringing, instant push or end-to-end encryption is claimed.
- Translations and cultural wording are drafts for native-speaker/cultural review before a commercial launch. Country selection uses a comparable survey proxy, not a global ranking of astrology belief. See [research notes](docs/COUNTRIES.md).

Existing Rekha website files and customer data are outside this folder and were not changed.
