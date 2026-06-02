#!/bin/bash
# Wrapper so clasp works without node in PATH.
# When running "deploy", always UPDATE the existing deployment used by PROXY_URL so the
# PROXY_URL in index.html stays valid. Creating new deployments produces new
# IDs that the frontend never calls.
CLASP="/opt/homebrew/bin/node /opt/homebrew/bin/clasp"
DEPLOYMENT_ID="AKfycbw2Jg8xlLd4uk4lVVGLu_-BtDjbOdoUWXz3Fyn2k_LfYLo1_L3eReyZLmlARxBePpHtwA"

if [ "$1" = "deploy" ]; then
  # Push latest code, then update the pinned deployment
  $CLASP push && $CLASP deploy -i "$DEPLOYMENT_ID" "${@:2}"
else
  exec $CLASP "$@"
fi
