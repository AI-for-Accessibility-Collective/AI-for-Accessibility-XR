#!/usr/bin/env bash
# Push this app + the sibling toolkit to the server behind
# https://a11y.attunemitserver.dev and restart it (README §2).
# The server's .env and data/ are never touched — edit those over ssh.
set -euo pipefail

VM=attune-server
ZONE=us-east1-b
REMOTE_DIR=a11y-toolkit            # under the server's home directory
SERVICE=wearable-a11y

cd "$(dirname "$0")/../.."         # toolkitv2/, so both siblings are in reach
TGZ=$(mktemp -t a11y-deploy).tgz
trap 'rm -f "$TGZ"' EXIT

COPYFILE_DISABLE=1 tar czf "$TGZ" \
  --exclude node_modules --exclude .git --exclude '.env' --exclude '.env.example' \
  --exclude 'wearable-extension/data' --exclude bench-out --exclude '*.mov' --exclude '*.mp4' \
  wearable-extension AI-for-Accessibility-Toolkit/toolkit

gcloud compute scp --zone="$ZONE" "$TGZ" "$VM:/tmp/a11y-deploy.tgz"
gcloud compute ssh "$VM" --zone="$ZONE" --command="set -e
  mkdir -p ~/$REMOTE_DIR && cd ~/$REMOTE_DIR
  tar xzf /tmp/a11y-deploy.tgz && rm /tmp/a11y-deploy.tgz
  cd wearable-extension && ~/.bun/bin/bun install | tail -1
  sudo systemctl restart $SERVICE && sleep 5
  systemctl is-active $SERVICE
  journalctl -u $SERVICE --since '-15s' --no-pager -o cat | grep '^\[wearable\]' || true"

curl -s -o /dev/null -w 'https://a11y.attunemitserver.dev/webview -> %{http_code}\n' --max-time 15 \
  https://a11y.attunemitserver.dev/webview
