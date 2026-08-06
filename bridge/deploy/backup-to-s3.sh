#!/bin/bash
#
# x-bridge (xgate) archive backup -> S3
#
# Takes a *consistent* snapshot of the live WAL-mode SQLite cache using the
# SQLite online-backup API (safe while the bridge daemon is writing), verifies
# it, compresses it, and uploads to OVH S3. Also mirrors the media cache and
# prunes old snapshots.
#
# Invoked by x-bridge-backup.timer (daily). Safe to run by hand.
#
set -euo pipefail

XBRIDGE_DIR="${XBRIDGE_DIR:-/home/antra/x-bridge}"
DB="$XBRIDGE_DIR/x-cache.db"
MEDIA_DIR="$XBRIDGE_DIR/media-cache"
VENV_PY="$XBRIDGE_DIR/.venv/bin/python"
RCLONE_CONFIG="${RCLONE_CONFIG:-/home/antra/.config/rclone/rclone.conf}"

REMOTE_BASE="tessera-s3:tesserastorage/xgate-backups"
DB_PREFIX="$REMOTE_BASE/db"
MEDIA_PREFIX="$REMOTE_BASE/media-cache"

# Runtime state lives OUTSIDE $XBRIDGE_DIR on purpose: that tree is a deploy
# target for `rsync -az --delete ./ borgs:x-bridge/` from the repo, which would
# otherwise delete the log mid-flight (or the temp dir out from under a run).
STATE_DIR="${STATE_DIR:-/home/antra/.local/state/xgate-backup}"
mkdir -p "$STATE_DIR"
LOG_FILE="$STATE_DIR/backup.log"
LOCK_FILE="$STATE_DIR/backup.lock"
WORK_DIR="$STATE_DIR/tmp"

# Retention: keep every snapshot from the last N days; keep the 1st-of-month
# snapshot forever; delete everything else.
KEEP_DAYS="${KEEP_DAYS:-30}"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
RC="rclone --config $RCLONE_CONFIG"

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" | tee -a "$LOG_FILE"; }
fail() { log "ERROR: $*"; exit 1; }

# Serialize runs — a slow upload must not overlap the next timer firing.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    log "another backup run is in progress; exiting"
    exit 0
fi

trap 'rm -rf "$WORK_DIR"' EXIT
mkdir -p "$WORK_DIR"

log "=========================================="
log "Starting xgate backup ($STAMP)"

[ -f "$DB" ] || fail "database not found: $DB"
[ -x "$VENV_PY" ] || fail "python not found: $VENV_PY"

SNAP="$WORK_DIR/x-cache-$STAMP.db"

# ---------------------------------------------------------------- snapshot
# sqlite3.Connection.backup() is the online backup API: it produces a
# transactionally consistent copy without stopping the daemon. Copying the
# .db file directly would be corrupt (WAL contents live in a sibling file).
log "Snapshotting $DB via SQLite online-backup API..."
"$VENV_PY" - "$DB" "$SNAP" <<'PY'
import sqlite3, sys

src_path, dst_path = sys.argv[1], sys.argv[2]
src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True, timeout=60)
dst = sqlite3.connect(dst_path)
with dst:
    src.backup(dst, pages=2000)
dst.close()
src.close()
PY

# ------------------------------------------------------------------ verify
# Never let a corrupt or truncated snapshot overwrite good backups.
log "Verifying snapshot..."
VERIFY="$("$VENV_PY" - "$SNAP" "$DB" <<'PY'
import sqlite3, sys

snap_path, live_path = sys.argv[1], sys.argv[2]
snap = sqlite3.connect(f"file:{snap_path}?mode=ro", uri=True)

integrity = snap.execute("pragma integrity_check").fetchone()[0]
if integrity != "ok":
    sys.exit(f"integrity_check failed: {integrity}")

snap_tweets = snap.execute("select count(*) from tweets").fetchone()[0]
snap_media = snap.execute("select count(*) from media").fetchone()[0]
snap.close()

if snap_tweets == 0:
    sys.exit("snapshot has 0 tweets")

# Guard against a truncated/rolled-back source: the snapshot should be within
# a few percent of the live table. The cache only grows in normal operation.
live = sqlite3.connect(f"file:{live_path}?mode=ro", uri=True)
live_tweets = live.execute("select count(*) from tweets").fetchone()[0]
live.close()

if snap_tweets < live_tweets * 0.95:
    sys.exit(f"snapshot has {snap_tweets} tweets vs live {live_tweets} — too small")

print(f"{snap_tweets} {snap_media}")
PY
)" || fail "snapshot verification failed: $VERIFY"

log "Snapshot OK: $(echo "$VERIFY" | awk '{print $1}') tweets, $(echo "$VERIFY" | awk '{print $2}') media rows"

# ---------------------------------------------------------------- compress
log "Compressing..."
zstd -q -12 -T0 --rm "$SNAP" -o "$SNAP.zst"
SNAP_ZST="$SNAP.zst"
log "Compressed size: $(du -h "$SNAP_ZST" | cut -f1) (raw $(du -h "$DB" | cut -f1))"

# ------------------------------------------------------------------ upload
BASENAME="$(basename "$SNAP_ZST")"
log "Uploading $BASENAME -> $DB_PREFIX/"
$RC copyto "$SNAP_ZST" "$DB_PREFIX/$BASENAME" --stats-one-line --stats=30s

# Confirm the object actually landed at the expected size before we let
# retention delete anything.
LOCAL_SIZE="$(stat -c %s "$SNAP_ZST")"
REMOTE_SIZE="$($RC size "$DB_PREFIX/$BASENAME" --json 2>/dev/null | grep -o '"bytes":[0-9]*' | cut -d: -f2 || echo 0)"
[ "$LOCAL_SIZE" = "$REMOTE_SIZE" ] || fail "upload size mismatch: local $LOCAL_SIZE vs remote $REMOTE_SIZE"
log "Upload verified ($REMOTE_SIZE bytes)"

# Convenience pointer for restores — always the most recent good snapshot.
$RC copyto "$SNAP_ZST" "$DB_PREFIX/x-cache-latest.db.zst"

# Media cache: additive incremental mirror (no --delete, media is immutable).
if [ -d "$MEDIA_DIR" ]; then
    log "Syncing media-cache..."
    $RC copy "$MEDIA_DIR" "$MEDIA_PREFIX" --transfers=4 --stats-one-line --stats=30s
fi

# --------------------------------------------------------------- retention
log "Pruning snapshots older than $KEEP_DAYS days (keeping monthlies)..."
CUTOFF="$(date -u -d "$KEEP_DAYS days ago" +%Y%m%d)"
LISTING="$WORK_DIR/listing.txt"

if $RC lsf "$DB_PREFIX" --files-only > "$LISTING" 2>>"$LOG_FILE"; then
    DELETED=0
    while read -r f; do
        # Only ever touch timestamped snapshots; x-cache-latest is never pruned.
        [[ "$f" =~ ^x-cache-([0-9]{8})-[0-9]{6}\.db\.zst$ ]] || continue
        d="${BASH_REMATCH[1]}"
        [ "$d" -ge "$CUTOFF" ] && continue      # inside the daily window
        [ "${d:6:2}" = "01" ] && continue        # monthly keeper
        if $RC deletefile "$DB_PREFIX/$f" 2>>"$LOG_FILE"; then
            log "  pruned $f"
            DELETED=$((DELETED + 1))
        else
            log "  WARN: failed to prune $f"
        fi
    done < "$LISTING"
    log "Pruned $DELETED old snapshot(s)"
else
    # A failed listing must not be read as "nothing to keep".
    log "WARN: could not list $DB_PREFIX — skipping retention this run"
fi

TOTAL="$($RC size "$REMOTE_BASE" --json 2>/dev/null | grep -o '"bytes":[0-9]*' | cut -d: -f2 || echo 0)"
log "Backup complete. Total xgate-backups size in S3: $((TOTAL / 1024 / 1024)) MB"
log "=========================================="
