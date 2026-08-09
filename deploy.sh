#!/bin/bash
# Ship Inventory and record the release to GX Core's CENTRAL version log.
#   Usage:  bash deploy.sh                              # version-only record
#           GX_NOTES=$'Line 1\nLine 2' bash deploy.sh   # record WITH release notes
#
# Records ONCE per run via GX Core's shared `deploy_version` endpoint (the single
# release-note log for the whole GX suite — do NOT build a per-app recordversion
# action). Records show up as deployed_by:"app".
#
# Needs .gx_deploy_secret (untracked, never committed) = the shared GC_DEPLOY_SECRET.
# Without it, recording is skipped with a warning — the deploy itself still happens.
set -e

VERSION=$(grep -oE "APP_VERSION = '[^']+'" index.html | head -1 | sed "s/.*'\(.*\)'/\1/")
[ -z "$VERSION" ] && { echo "✗ Could not read APP_VERSION from index.html"; exit 1; }
echo "── Shipping Inventory $VERSION ──"

# Backend (Apps Script). Non-fatal so a frontend-only release isn't blocked by clasp auth.
bash clasp.sh deploy || echo "⚠ backend deploy failed/skipped — continuing with frontend + record."

# Frontend (GitHub Pages).
git push

# Record the release to GX Core's single version log (safe no-op without the secret).
GXCORE="https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec"
if [ -f .gx_deploy_secret ]; then
  curl -sL -G "$GXCORE" \
    --data-urlencode "action=deploy_version" \
    --data-urlencode "secret=$(cat .gx_deploy_secret)" \
    --data-urlencode "app=inventory" \
    --data-urlencode "version=$VERSION" \
    --data-urlencode "sha=$(git rev-parse --short HEAD)" \
    --data-urlencode "notes=$GX_NOTES"
  echo ""
  echo "✓ recorded $VERSION to GX Core (deployed_by:app)"
else
  echo "⚠ .gx_deploy_secret missing — skipped GX Core record for $VERSION."
  echo "  Create it (untracked) with the shared GC_DEPLOY_SECRET value to enable auto-recording."
fi
