#!/usr/bin/env bash
# Re-renders the own deck of every session /api/me returns for the calling user
# (the default dev user, unless x-deckd-user is set — /api/me is scoped per user,
# not global). Renders always use the active bundle (see README's "Rendering and
# the bundle"), so this is what to run after a bundle/theme update, to push it out
# to every live session without waiting for each one's next edit.
set -euo pipefail
BASE="${DECKD_URL:-http://127.0.0.1:8790}"

curl -fsS "$BASE/api/me" | jq -r '.sessions[] | "\(.id) \(.slug)"' \
| while read -r SID SLUG; do
  echo "-- rendering $SLUG ($SID) --"
  curl -fsS -X POST "$BASE/api/sessions/$SID/render?deck=$SLUG" >/dev/null
done

echo "queued a render for every session"
