#!/bin/bash
# Wrapper so clasp works without node in PATH.
# When running "deploy", always UPDATE the existing deployment used by PROXY_URL so the
# PROXY_URL in index.html stays valid. Creating new deployments produces new
# IDs that the frontend never calls.
#
# VERSION-LIMIT GUARD: Apps Script caps a project at 200 immutable versions and there is NO
# API/clasp way to delete them (deletion is UI-only, from the editor's project history). Each
# `clasp deploy` cuts a new version, so we ration them: the frontend (index.html) ships via
# GitHub Pages, NOT this deployment, so a frontend-only change needs `clasp push` (updates HEAD,
# no version) but NOT a new version. We therefore only cut a version when the BACKEND
# (*.gs / appsscript.json) actually changed since the last successful deploy.
#   bash clasp.sh deploy           # push; version only if backend changed
#   bash clasp.sh deploy --force   # push + always cut a version (bypass the change check)
CLASP="/opt/homebrew/bin/node /opt/homebrew/bin/clasp"
DEPLOYMENT_ID="AKfycbw2Jg8xlLd4uk4lVVGLu_-BtDjbOdoUWXz3Fyn2k_LfYLo1_L3eReyZLmlARxBePpHtwA"
HASH_FILE=".last_backend_deploy"

if [ "$1" = "deploy" ]; then
  FORCE=""
  [ "$2" = "--force" ] && FORCE="1"

  # Always push the working files to the project HEAD (this alone never creates a version).
  $CLASP push || exit 1

  # Hash the backend so we can tell whether a new version is actually warranted.
  BACKEND_HASH=$(cat ./*.gs appsscript.json 2>/dev/null | shasum -a 256 | awk '{print $1}')
  LAST_HASH=$(cat "$HASH_FILE" 2>/dev/null || echo "")

  if [ -z "$FORCE" ] && [ -n "$LAST_HASH" ] && [ "$BACKEND_HASH" = "$LAST_HASH" ]; then
    echo "✓ Backend unchanged since last deploy — pushed files, skipped new GAS version."
    echo "  (Frontend changes are served by GitHub Pages, not this deployment.)"
    exit 0
  fi

  # Backend changed (or --force / first run) → cut a version and repoint the pinned deployment.
  if $CLASP deploy -i "$DEPLOYMENT_ID"; then
    echo "$BACKEND_HASH" > "$HASH_FILE"
  else
    status=$?
    echo ""
    echo "⚠️  clasp deploy failed. If this is the 200-version limit, delete old versions in the"
    echo "    Apps Script editor (Deploy ▸ Manage deployments / project history) — versions cannot"
    echo "    be deleted via API. The pinned deployment keeps serving the last good version until then."
    exit $status
  fi
else
  exec $CLASP "$@"
fi
