# Cloud host preparation — not yet deployed

No VM has been created and no WhatsApp profile or secrets have been transferred. The local setup remains separate from the existing customer app.

## Oracle Always Free candidate

Current official documentation gives Always Free tenancies 1,500 Ampere A1 OCPU-hours and 9,000 GB-hours each month: equivalent to **2 OCPUs and 12 GB RAM**, not the older 4/24 allowance. Choose an Always Free eligible Ubuntu ARM image, a single A1 instance at or below 2 OCPU/12 GB, and a 50 GB boot volume within the total 200 GB free volume allocation. Verify the exact Console price/eligibility before creating anything. Do not upgrade to Pay As You Go.

Limits: eligible home-region capacity may be unavailable; idle instances may be reclaimed after a seven-day low-utilization period; outbound data is limited to 10 TB/month. Do not generate artificial load to evade reclamation. This is not a guaranteed-uptime service. Phone/card verification is normally required for signup and the owner must provide real contact/billing data and accept account terms.

Sources checked directly:

- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm
- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm

## Deployment checklist once an account and eligible VM exist

1. Install Node >=24.15 from the official Node distribution for the VM architecture; validate the published checksum. Install Chromium and `zstd` from the OS package registry. Keep the browser sandbox enabled.
2. Clone the owner's repository and run `npm ci` in `openwa-funnel`. Use a dedicated unprivileged owner account. Verify that Chromium launches under that account before connecting WhatsApp.
3. Keep `.local/`, `.sessions/` and the browser profile on the persistent boot disk, owned by that account. On Ubuntu Snap Chromium, `WHATSAPP_PROFILE_DIR` can point inside the user's `~/snap/chromium/common/` directory so the browser has access to its profile.
4. Configure server-only `.env` backup secrets with restrictive file permissions. Do not put credentials in cloud-init text, a public image, a Git repository, browser URLs or logs. Existing local WhatsApp profiles are not automatically transferred; link the server's own private QR instead.
5. Adapt the accompanying systemd template's user, paths and Chromium location to the actual VM. It restarts the process after a crash/VM reboot; it cannot prevent Oracle from reclaiming the VM. Startup automatically connects the saved profile but the funnel's own pause setting remains durable.
6. Leave port 4341 bound to loopback. Access the private controls with an SSH tunnel (`ssh -L 4341:127.0.0.1:4341 <owner>@<vm>`). The owner's PC need only be online while using the tunnel; the VM runs the funnel independently. Never expose this unauthenticated local bootstrap page publicly. Public/mobile owner access would require a separately authenticated HTTPS gateway.
7. Before cutover, stop the PC gateway so only one linked runtime sends messages. If there are existing customers, migrate the SQLite state with a consistent backup and preserve its installation ID to avoid replay. Mark any in-progress sends uncertain and resolve them before enabling automation. Keep the old machine's state until recipient tests succeed.
8. Pair WhatsApp, enable the funnel, and verify one consenting sender end to end: greeting/media order, true delivered ACK, one-time replay protection and a manual reply. Test process restart and queued follow-up recovery. Only then claim the server is live without the PC.

## Other hosts evaluated

Lightning currently shows a platform-access suspension/security incident; its Free plan also requires four-hour restarts. No session/secrets were uploaded there. Render Free sleeps after 15 minutes without inbound traffic and loses local files at restarts, so it is unsuitable for a persistent WhatsApp browser profile. Google Cloud's small free VM and limited free egress are a poorer fit for this video-heavy flow.

Cloudflare's Workers plan in the inspected account is currently **Free**. Workers cannot execute the standalone browser process. Containers require Workers Paid and have separately metered runtime usage; ordinary paid R2/domain services do not establish that Containers are included at no extra cost. No paid Container was created.
