# xgate archive backups

The prod cache (`borgs.animalabs.ai:~/x-bridge/x-cache.db`, WAL-mode SQLite) is
backed up daily to OVH S3.

- **Script**: `deploy/backup-to-s3.sh` → deployed to `~/x-bridge/deploy/`
- **Schedule**: `x-bridge-backup.timer` (systemd *user* timer), daily 04:17 UTC
  + up to 10min jitter, `Persistent=true` so a missed run catches up.
  User lingering is enabled, so it runs without an active login.
- **Destination**: `tessera-s3:tesserastorage/xgate-backups/`
  - `db/x-cache-YYYYMMDD-HHMMSS.db.zst` — timestamped snapshots (~41 MB each)
  - `db/x-cache-latest.db.zst` — always the newest good snapshot
  - `media-cache/` — additive incremental mirror
- **Retention**: all snapshots from the last 30 days, plus the 1st-of-month
  snapshot forever. `x-cache-latest` is never pruned.
- **Log**: `~/.local/state/xgate-backup/backup.log` (deliberately outside
  `~/x-bridge/` — see below)

## Interaction with the deploy rsync

`~/x-bridge/` on borgs is a deploy target, not a working copy. It is refreshed
by hand from the repo with:

    cd ~/connectome-local/xgate/bridge && rsync -az [--delete] \
      --exclude='.env' --exclude='.venv' --exclude='x-cache.db*' \
      --exclude='media-cache' --exclude='tokens.json' ... ./ borgs.animalabs.ai:x-bridge/

Two consequences the backup has to survive:

1. `rsync -a` propagates the *repo's* file mode, so `chmod +x` applied only on
   the host is silently reverted. The script is kept executable in git, and the
   unit invokes it via `/bin/bash` so the exec bit is not load-bearing.
2. `--delete` removes host files absent from the repo. All runtime state (log,
   lock, temp snapshot dir) therefore lives in `~/.local/state/xgate-backup/`,
   outside the synced tree.

## Why not just copy the file

The bridge daemon writes continuously and the DB is in WAL mode, so a plain
`cp`/`rclone copy` of `x-cache.db` yields a corrupt backup — recent commits live
in the sibling `-wal` file. The script uses SQLite's online-backup API for a
transactionally consistent snapshot without stopping the daemon.

Each snapshot is verified before upload (`integrity_check`, non-zero tweet
count, and within 5% of the live row count) and the upload is size-checked
against the local file. Retention is skipped entirely if the remote listing
fails, so a transient S3 error can never delete the archive.

## Checking on it

    systemctl --user list-timers x-bridge-backup.timer
    systemctl --user status x-bridge-backup.service
    tail -30 ~/x-bridge/backup.log
    rclone lsl tessera-s3:tesserastorage/xgate-backups/db/

Run on demand (safe any time; concurrent runs are locked out via flock):

    ~/x-bridge/deploy/backup-to-s3.sh

## Restore

    systemctl --user stop x-bridge
    cd ~/x-bridge
    mv x-cache.db x-cache.db.bak && rm -f x-cache.db-wal x-cache.db-shm
    rclone copyto tessera-s3:tesserastorage/xgate-backups/db/x-cache-latest.db.zst /tmp/r.db.zst
    zstd -d /tmp/r.db.zst -o x-cache.db
    systemctl --user start x-bridge
    curl -s localhost:8810/health

To restore a specific date, list `db/` and use that object instead of `latest`.

## Not covered

`~/x-bridge/.env` and `tokens.json` (X API bearer + consumer tokens) are
deliberately **not** backed up — secrets stay out of the bucket. They must be
restored by hand when rebuilding the host from scratch.
