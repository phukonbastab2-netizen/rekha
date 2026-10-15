# ₹49 QR payment step

The existing bilingual donation-interest button now adds one QR message after five seconds. Reopening a previously interested chat also fills in this step once. The message is stored with `onboarding:donation-payment-qr-v1`; retries cannot duplicate it. It does not change payment entitlement or trigger older automation.

`public/payment-qr.jpg` is the supplied, unmodified public payment poster. SHA256: `9dae9c28e3aa4de5e17a96f304a0ce0d9fe422f76d14449df0c73ed3d9dbb164`. The QR does not set an amount; the caption instructs customers to enter ₹49 in their UPI app. The app does not collect payment credentials. Receipts require manual owner verification.

The poster ships in the Worker bundle so its delivery does not depend on R2. Replacing it requires rebuilding and deploying the app. Existing private customer attachments, videos and voice notes still use R2.

Validated on 15 October 2026: local message timing/idempotency/entitlement tests; mobile-width media rendering and viewer; deployed poster byte hash; isolated live customer-interest request and retry, with synthetic test conversation removed afterward.

Known separate deployment issue: Cloudflare R2 returned `Please enable R2 through the Cloudflare Dashboard (10042)`. Existing videos, voice notes, uploads and R2-hosted downloads need R2 restored by the account owner. The bundled QR works independently; this change does not claim that the complete onboarding media flow works during that outage.
