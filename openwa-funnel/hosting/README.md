# Private Oracle cloud hosting

The standalone gateway is installed on an Oracle Mumbai Always Free A1 VM with 2 OCPUs, 12 GB RAM, Ubuntu 24.04 ARM and a 50 GB boot volume. No account billing upgrade was performed. The service is active, enabled at boot and configured to restart after a failure. All 20 tests pass on the ARM server, and a service restart was verified. The browser runs with its sandbox enabled.

The PC gateway was stopped before transferring a consistent SQLite backup and its source ID. Server-only Cloudflare backup credentials were transferred privately over SSH, outside Git. The owner controls bind to loopback and are accessed through an owner SSH tunnel; port 4341 is not a public web service. The customer app remains unchanged.

**Release boundary:** WhatsApp is awaiting the owner's QR scan and the funnel remains paused. A running service or QR does not prove recipient delivery. Complete the consenting-recipient and restart checks below before claiming an operational funnel.

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

`provision-ubuntu.sh` implements the package/browser/Node/source preparation. `activate-ubuntu.sh` performs the initial private state migration and systemd activation, and refuses to overwrite an existing conversation database. Do not rerun initial migration against a working service.

## Phone-number linking

The cloud unit enables `ALLOW_PAIRING_RESTART=true`. In the private panel, enter the owner's WhatsApp number with country code and choose **Generate code**. The gateway saves the number in an owner-only local file, responds, and exits with code 75 so systemd starts a fresh authentication attempt. The generated pairing code appears only in the private, no-store controls; enter it on the phone under Linked devices → Link a device → Link with phone number instead. This is a device-linking code, not an SMS OTP. No code needs to be sent to an operator or entered in chat.

Successful linking clears the temporary number file and the displayed code. QR login remains available when WhatsApp does not offer code linking. The route validates international number format, rejects foreign-origin requests and repeated restarts, and refuses to replace an already-connected account. Authentication restarts preserve the SQLite state, queue and funnel pause setting. On a standalone process without a supervisor, leave this option disabled.

The private browser controls renew their HttpOnly session automatically after a service restart. Only an explicit authentication rejection is retried; network failures never automatically retry a possible message send. A QR-mode restart was checked through the live panel: it recovered and restored enabled linking controls without a page reload. Phone-code generation still needs an owner-entered number and confirmation on that phone.

## Other hosts evaluated

Lightning currently shows a platform-access suspension/security incident; its Free plan also requires four-hour restarts. No session/secrets were uploaded there. Render Free sleeps after 15 minutes without inbound traffic and loses local files at restarts, so it is unsuitable for a persistent WhatsApp browser profile. Google Cloud's small free VM and limited free egress are a poorer fit for this video-heavy flow.

Cloudflare's Workers plan in the inspected account is currently **Free**. Workers cannot execute the standalone browser process. Containers require Workers Paid and have separately metered runtime usage; ordinary paid R2/domain services do not establish that Containers are included at no extra cost. No paid Container was created.
