#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/.."

# Host is the first argument — matches a Host entry in ~/.ssh/config.
# Usage: ./scripts/deploy.sh [host]
# Defaults to "forge" (local network). Use "forge-ts" when outside home.
if [ ! -f .env ]; then
  echo "Error: .env not found." >&2
  exit 1
fi

set -a
source .env
set +a

SSH_HOST="${1:-forge}"

echo "→ Syncing to $SSH_HOST:$REMOTE_PATH"

# Write current timestamp as VERSION for cache-busting
date +%s > VERSION

rsync -az --progress \
  --exclude='.git/' \
  --exclude='.env' \
  --exclude='node_modules/' \
  --exclude='data/' \
  -e "ssh" \
  . "$SSH_HOST:$REMOTE_PATH"

echo "→ Installing dependencies"
ssh "$SSH_HOST" "bash -l -c 'cd $REMOTE_PATH && npm install --omit=dev'"

echo "→ Restarting service"
ssh "$SSH_HOST" "sudo systemctl restart motion-studio"

echo "✓ Deployed → $SSH_HOST"
