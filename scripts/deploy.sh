#!/usr/bin/env bash
# Push this app + the sibling toolkit to the server behind PUBLIC_URL and
# restart it (README §2). Where that is comes from this repo's .env (never
# committed): DEPLOY_VM and DEPLOY_ZONE name the GCP VM, PUBLIC_URL is what
# nginx answers on. The server's own .env and data/ are never touched — edit
# those over ssh.
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
env_value() { grep -E "^$1=" "$HERE/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' ; }
VM=$(env_value DEPLOY_VM)
ZONE=$(env_value DEPLOY_ZONE)
URL=$(env_value PUBLIC_URL)
[ -n "$VM" ] && [ -n "$ZONE" ] && [ -n "$URL" ] || { echo "set DEPLOY_VM, DEPLOY_ZONE and PUBLIC_URL in $HERE/.env (see .env.example)" >&2; exit 1; }
URL=${URL%/}
REMOTE_DIR=a11y-toolkit            # under the server's home directory
SERVICE=wearable-a11y
APP=$(basename "$HERE")            # this repo's folder; the same name is used on the server

cd "$HERE/.."                      # the parent, so both siblings are in reach
TGZ=$(mktemp -t a11y-deploy).tgz
trap 'rm -f "$TGZ"' EXIT

COPYFILE_DISABLE=1 tar czf "$TGZ" \
  --exclude node_modules --exclude .git --exclude '.env' --exclude '.env.example' \
  --exclude "$APP/data" --exclude "$APP/runs" --exclude "$APP/.tts-cache" --exclude "$APP/.camera-lag.json" --exclude "$APP/phone" --exclude bench-out --exclude '*.mov' --exclude '*.mp4' \
  "$APP" AI-for-Accessibility-Toolkit/toolkit

gcloud compute scp --zone="$ZONE" "$TGZ" "$VM:/tmp/a11y-deploy.tgz"
gcloud compute ssh "$VM" --zone="$ZONE" --command="set -e
  mkdir -p ~/$REMOTE_DIR && cd ~/$REMOTE_DIR
  tar xzf /tmp/a11y-deploy.tgz && rm /tmp/a11y-deploy.tgz
  cd $APP && ~/.bun/bin/bun install | tail -1
  sudo systemctl restart $SERVICE && sleep 5
  systemctl is-active $SERVICE
  journalctl -u $SERVICE --since '-15s' --no-pager -o cat | grep '^\[wearable\]' || true"

# 401 is the good answer: the panel is up and asking for ADMIN_PASSWORD.
curl -s -o /dev/null -w "$URL/webview -> %{http_code}\n" --max-time 15 "$URL/webview"
