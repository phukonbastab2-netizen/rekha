#!/usr/bin/env bash
set -euo pipefail
# Owner-run bootstrap for the reviewed Ubuntu ARM Always Free VM.
# Secrets and WhatsApp profiles are transferred separately over SSH.
export DEBIAN_FRONTEND=noninteractive
sudo -n apt-get update -qq
sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates xz-utils zstd chromium-browser

case "$(uname -m)" in
  aarch64) node_arch=arm64 ;;
  x86_64) node_arch=x64 ;;
  *) printf '%s\n' 'Unsupported architecture' >&2; exit 1 ;;
esac
node_version=v24.19.0
node_archive="node-${node_version}-linux-${node_arch}.tar.xz"
download_dir="$(mktemp -d)"
cd "$download_dir"
curl --fail --silent --show-error --location --proto '=https' "https://nodejs.org/dist/${node_version}/${node_archive}" -o "$node_archive"
curl --fail --silent --show-error --location --proto '=https' "https://nodejs.org/dist/${node_version}/SHASUMS256.txt" -o SHASUMS256.txt
awk -v file="$node_archive" '$2 == file {print}' SHASUMS256.txt > selected.sha256
test "$(wc -l < selected.sha256)" -eq 1
sha256sum -c selected.sha256
mkdir -p "$HOME/.local/node"
tar -xJf "$node_archive" --strip-components=1 -C "$HOME/.local/node"
export PATH="$HOME/.local/node/bin:$PATH"
node --version
npm --version

if [ ! -d "$HOME/rekha/.git" ]; then
  git clone --filter=blob:none --sparse --depth 1 https://github.com/phukonbastab2-netizen/rekha.git "$HOME/rekha"
  git -C "$HOME/rekha" sparse-checkout set openwa-funnel
fi
cd "$HOME/rekha/openwa-funnel"
npm ci --ignore-scripts --omit=dev --no-audit --no-fund
npm test
mkdir -p "$HOME/snap/chromium/common/rekha-29" .local .sessions
chmod 700 .local .sessions "$HOME/snap/chromium/common/rekha-29"
zstd --version
/snap/bin/chromium --version
printf '%s\n' 'Bootstrap complete. Service and secrets are not enabled by this script.'
