#!/usr/bin/env bash
# End-to-end smoke against a real running deckd (npm run dev). Every session is a
# plain local directory now, so this only needs deckd itself -- no sandboxd, no
# other services.
set -euo pipefail
BASE="${DECKD_URL:-http://127.0.0.1:8790}"

echo "-- create session --"
SID=$(curl -fsS -X POST "$BASE/api/sessions" -H 'content-type: application/json' \
  -d '{"name":"smoke test deck"}' | jq -r .id)
echo "session: $SID"

echo "-- put source --"
MTIME=$(curl -fsS "$BASE/api/sessions/$SID/source" | jq -r .mtime)
curl -fsS -X PUT "$BASE/api/sessions/$SID/source" -H 'content-type: application/json' \
  -d "{\"content\":\"---\\nmarp: true\\n---\\n\\n# Smoke test\\n\",\"baseMtime\":$MTIME}" \
  -o /dev/null -w '%{http_code}\n'

echo "-- trigger render --"
curl -fsS -X POST "$BASE/api/sessions/$SID/render" >/dev/null

echo -n "-- waiting for pdf "
for _ in $(seq 1 90); do
  M=$(curl -fsS "$BASE/api/sessions/$SID" | jq -r .pdfMtime)
  [ "$M" != "null" ] && { echo "ok --"; break; }
  echo -n "."; sleep 2
done
[ "$M" != "null" ] || { echo " FAIL: no pdf"; exit 1; }

echo "-- pdf + export --"
curl -fsS "$BASE/api/sessions/$SID/pdf" -o /tmp/deckd-smoke.pdf
# grep WITHOUT -q: under pipefail, -q exits at first match and SIGPIPEs the
# producer, killing the script mid-run with a masked non-zero status.
file /tmp/deckd-smoke.pdf | grep PDF >/dev/null
curl -fsS "$BASE/api/sessions/$SID/export" -o /tmp/deckd-smoke.zip
unzip -l /tmp/deckd-smoke.zip | grep slides.md >/dev/null

echo "-- cleanup --"
curl -fsS -X DELETE "$BASE/api/sessions/$SID" -o /dev/null -w '%{http_code}\n'
echo "SMOKE PASS"
