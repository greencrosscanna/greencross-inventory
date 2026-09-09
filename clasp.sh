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
#
# NOT FOR A LIBRARY RE-PIN. If appsscript.json's GXCore version changed, use ./gxengine.sh --deploy
# instead — this script ships the pin correctly but RECORDS NOTHING, and core_pins is the suite's
# only answer to "what is this app actually running". On 2026-09-09 a v306->v310 re-pin went out
# through here: the live app really was on 310 and reported so, while core_pins still read 306 from
# that morning and core-admin's re-pin note stayed open. Nothing failed and nothing warned; the
# record was simply wrong, which is the kind of wrong you only find by going to look. (Four spokes
# were found stale the same way on 2026-09-03 — crew by 23 commits, inventory by 13.)
# The guard below refuses that case rather than trusting anyone to remember, because this script is
# the one sitting next to deploy.sh and is what a session reaches for first.
CLASP="/opt/homebrew/bin/node /opt/homebrew/bin/clasp"
DEPLOYMENT_ID="AKfycbw2Jg8xlLd4uk4lVVGLu_-BtDjbOdoUWXz3Fyn2k_LfYLo1_L3eReyZLmlARxBePpHtwA"
HASH_FILE=".last_backend_deploy"

if [ "$1" = "deploy" ]; then
  FORCE=""
  [ "$2" = "--force" ] && FORCE="1"

  # ── A RE-PIN MUST GO THROUGH gxengine, WHICH RECORDS IT ─────────────────────────────────────
  # The pinned GXCore version is stored alongside the backend hash. If it has moved since the last
  # deploy from here, this is a re-pin, and a re-pin that records nothing leaves core_pins asserting
  # a version the app is no longer running. Refuse and name the tool that does it properly.
  # Purely local — no network call — so a Core outage can never be what stops a deploy.
  PIN_NOW=$(sed -n '/"userSymbol": *"GXCore"/,/}/p' appsscript.json | sed -n 's/.*"version": *"\{0,1\}\([0-9][0-9]*\)"\{0,1\}.*/\1/p' | head -1)
  PIN_LAST=$(sed -n '2p' "$HASH_FILE" 2>/dev/null || echo "")
  if [ -z "$FORCE_PIN" ] && [ -n "$PIN_NOW" ] && [ -n "$PIN_LAST" ] && [ "$PIN_NOW" != "$PIN_LAST" ]; then
    echo "✋ This is a GXCore RE-PIN (v$PIN_LAST → v$PIN_NOW), and this script records nothing."
    echo ""
    echo "   Use:  ./gxengine.sh --deploy"
    echo ""
    echo "   It pushes, redeploys the deployment your own source already points at, writes the sha"
    echo "   to core_pins, and closes core-admin's re-pin note. Deploying from here instead ships"
    echo "   the pin correctly but leaves core_pins asserting the OLD version — silently, which is"
    echo "   how four spokes were found stale on 2026-09-03."
    echo ""
    echo "   If you genuinely mean to deploy a pin change without recording it:"
    echo "     FORCE_PIN=1 bash clasp.sh deploy"
    exit 1
  fi

  # Always push the working files to the project HEAD (this alone never creates a version).
  # GREMLIN FIX: clasp intermittently prints "Skipping push" from stale mtime change-detection
  # and then deploys the OLD code — and --force alone does NOT reliably override it. Bumping the
  # source mtimes first is what actually defeats the skip. This can't cause spurious versions:
  # version-cutting is gated separately by BACKEND_HASH below, not by whether a push happened.
  touch ./*.gs appsscript.json index.html 2>/dev/null
  $CLASP push --force || exit 1

  # Hash the backend so we can tell whether a new version is actually warranted.
  BACKEND_HASH=$(cat ./*.gs appsscript.json 2>/dev/null | shasum -a 256 | awk '{print $1}')
  LAST_HASH=$(sed -n '1p' "$HASH_FILE" 2>/dev/null || echo "")

  if [ -z "$FORCE" ] && [ -n "$LAST_HASH" ] && [ "$BACKEND_HASH" = "$LAST_HASH" ]; then
    echo "✓ Backend unchanged since last deploy — pushed files, skipped new GAS version."
    echo "  (Frontend changes are served by GitHub Pages, not this deployment.)"
    exit 0
  fi

  # Backend changed (or --force / first run) → cut a version and repoint the pinned deployment.
  if $CLASP deploy -i "$DEPLOYMENT_ID"; then
    { echo "$BACKEND_HASH"; echo "$PIN_NOW"; } > "$HASH_FILE"
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
