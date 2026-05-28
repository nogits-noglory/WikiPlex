#!/usr/bin/env bash
# ── WikiDactic deploy script ──────────────────────────────────────────────
# Usage:  bash deploy.sh
#         bash deploy.sh --skip-push    (server already has latest; just sync)
#
# What it does:
#   1. git push local master to GitHub  (skipped with --skip-push)
#   2. SSH to server: git pull /opt/wikidactic
#   3. node --check server.js           (syntax gate — aborts if broken)
#   4. python3 -m py_compile pipeline.py (syntax gate)
#   5. rsync static files  → /var/www/wikidactic/
#      rsync server.js     → /var/www/wikidactic-proxy/server.js
#   6. systemctl restart wikidactic-proxy
#   7. Health-check: GET /api/stats must return 200 within 10s
# ─────────────────────────────────────────────────────────────────────────

set -euo pipefail

SERVER="root@64.227.83.151"
SSH_PORT=2222
REPO_DIR="/opt/wikidactic"
STATIC_DIR="/var/www/wikidactic"
PROXY_DIR="/var/www/wikidactic-proxy"
HEALTH_URL="http://localhost:3001/api/stats"

SKIP_PUSH=false
for arg in "$@"; do
  [[ "$arg" == "--skip-push" ]] && SKIP_PUSH=true
done

echo ""
echo "==> WikiDactic deploy"
echo ""

# ── 1. Push to GitHub ──────────────────────────────────────────────────────
if [ "$SKIP_PUSH" = false ]; then
  echo "[1/7] Pushing to GitHub..."
  git push origin master
else
  echo "[1/7] Skipping push (--skip-push)"
fi

# ── 2–5. Everything on the server ─────────────────────────────────────────
echo "[2/7] Pulling on server..."
ssh -p "$SSH_PORT" "$SERVER" bash <<'REMOTE'
set -euo pipefail

REPO_DIR="/opt/wikidactic"
STATIC_DIR="/var/www/wikidactic"
PROXY_DIR="/var/www/wikidactic-proxy"

# Pull latest
git -C "$REPO_DIR" pull origin master

# Syntax checks before touching live files
echo "[3/7] Checking server.js syntax..."
node --check "$REPO_DIR/server.js"

echo "[4/7] Checking pipeline.py syntax..."
python3 -m py_compile "$REPO_DIR/pipeline.py"

# Backup current server.js before overwriting
cp "$PROXY_DIR/server.js" "$PROXY_DIR/server.js.bak"

# Sync files explicitly — avoids rsync include/exclude subdirectory gotchas
echo "[5/7] Syncing files..."
rsync -av --checksum "$REPO_DIR/index.html"        "$STATIC_DIR/index.html"
rsync -av --checksum "$REPO_DIR/pipeline.py"       "$STATIC_DIR/pipeline.py"
rsync -av --checksum "$REPO_DIR/js/app.js"         "$STATIC_DIR/js/app.js"
rsync -av --checksum "$REPO_DIR/css/style.css"     "$STATIC_DIR/css/style.css"
rsync -av --checksum "$REPO_DIR/server.js"         "$PROXY_DIR/server.js"
echo "Files synced."
REMOTE

# ── 6. Restart service ─────────────────────────────────────────────────────
echo "[6/7] Restarting wikidactic-proxy..."
ssh -p "$SSH_PORT" "$SERVER" "systemctl restart wikidactic-proxy"
sleep 2

# ── 7. Health check ────────────────────────────────────────────────────────
echo "[7/7] Health check..."
ssh -p "$SSH_PORT" "$SERVER" bash <<'HEALTHCHECK'
set -euo pipefail
for i in $(seq 1 5); do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/stats 2>/dev/null || echo "000")
  if [ "$STATUS" = "200" ]; then
    echo "    Health check passed (HTTP 200)"
    exit 0
  fi
  echo "    Waiting... ($i/5, got HTTP $STATUS)"
  sleep 2
done
echo "    Health check FAILED after 10s"
exit 1
HEALTHCHECK

echo ""
echo "Deploy complete."
echo ""
