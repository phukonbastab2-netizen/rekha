#!/usr/bin/env bash
set -euo pipefail
test "$(id -un)" = ubuntu
cd "$HOME/rekha/openwa-funnel"
test -f "$HOME/rekha-private/gateway.env"
test -f "$HOME/rekha-private/funnel-cutover.sqlite"
test -f "$HOME/rekha-private/source-id"
# Initial migration only: never overwrite a gateway's live conversation state.
test ! -e .local/funnel.sqlite
install -m 600 "$HOME/rekha-private/gateway.env" .env
sed -i 's/^AUTO_CONNECT=.*/AUTO_CONNECT=true/' .env
install -m 600 "$HOME/rekha-private/funnel-cutover.sqlite" .local/funnel.sqlite
install -m 600 "$HOME/rekha-private/source-id" .local/source-id
sudo -n install -m 644 hosting/rekha-whatsapp.service /etc/systemd/system/rekha-whatsapp.service
sudo -n systemctl daemon-reload
sudo -n systemctl enable --now rekha-whatsapp.service
systemctl is-active rekha-whatsapp.service
systemctl is-enabled rekha-whatsapp.service
