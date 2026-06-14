#!/usr/bin/env bash
#
# Persist the xgate.animalabs.ai vhost into the snap Caddy's on-disk config.
#
# The xgate route was added live via Caddy's admin API (no sudo). The snap loads
# its config from /var/snap/caddy/common/caddy.json on (re)start, so without this
# step a Caddy restart would drop xgate. This captures the *current running*
# config (which already includes xgate and everything else, unchanged) back to
# that file — with a backup and validation, aborting on any anomaly.
#
# Run once, with sudo:   sudo bash ~/x-bridge/deploy/persist-caddy.sh
#
set -euo pipefail

JSON=/var/snap/caddy/common/caddy.json
CADDYFILE=/etc/caddy/Caddyfile
ADMIN=localhost:2019
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

echo "1/4  fetching running config from the admin API…"
curl -fsS "$ADMIN/config/" -o "$TMP"

echo "2/4  validating (valid JSON + contains existing hosts + xgate)…"
python3 - "$TMP" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
blob = json.dumps(cfg)
assert cfg.get("apps", {}).get("http"), "no http app in running config"
for needed in ("borgs.animalabs.ai", "xgate.animalabs.ai", "127.0.0.1:8810"):
    assert needed in blob, f"running config missing {needed!r} — refusing to persist"
print("    ok: existing vhosts present + xgate route present")
PY

echo "3/4  backing up and writing $JSON…"
cp -a "$JSON" "$JSON.bak.$(date +%Y%m%dT%H%M%S)"
cat "$TMP" > "$JSON"
echo "    backup kept alongside $JSON"

echo "4/4  recording the vhost in $CADDYFILE (source-of-truth; idempotent)…"
if ! grep -q "xgate.animalabs.ai" "$CADDYFILE"; then
  cat >> "$CADDYFILE" <<'EOF'

xgate.animalabs.ai {
    reverse_proxy localhost:8810 {
        flush_interval -1
    }
}
EOF
  echo "    appended xgate block to Caddyfile"
else
  echo "    Caddyfile already mentions xgate — left as-is"
fi

echo
echo "Done. xgate is now persisted; it will survive a Caddy restart."
echo "Optional sanity check:  sudo snap restart caddy && curl -s https://xgate.animalabs.ai/health"
