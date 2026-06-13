# Putting the bridge behind HTTPS (Caddy on borgs)

The bridge runs on `127.0.0.1:8810` (systemd user service). To reach it from
off-host, front it with the existing Caddy. The bridge is **token-gated**
(`X_BRIDGE_TOKEN` in `.env`): every endpoint except `GET /health` and raw
`GET /media/:id` image bytes requires `Authorization: Bearer <token>`, so it's
safe to expose publicly.

Caddy here is the **snap** build (config `/var/snap/caddy/common/caddy.json`,
root-owned; Caddyfile at `/etc/caddy/Caddyfile`). Durable changes need `sudo`.
Pick one option, add the block, and reload.

## Option A — dedicated subdomain (recommended)

1. Add a public DNS record: `xgate.animalabs.ai  A  15.204.5.179`.
2. Append to `/etc/caddy/Caddyfile`:

   ```
   xgate.animalabs.ai {
       reverse_proxy localhost:8810 {
           flush_interval -1          # stream SSE without buffering
       }
   }
   ```

3. Reload: `sudo systemctl reload caddy`  (snap: `sudo snap restart caddy`).

Endpoint: `https://xgate.animalabs.ai`. Caddy auto-provisions the cert.

## Option B — path on the existing host (no DNS change)

Edit the existing `borgs.animalabs.ai { … }` block so `/xgate/*` is matched
**before** the catch-all `handle`:

```
borgs.animalabs.ai {
    handle_path /relay/* { reverse_proxy localhost:8800 }
    handle_path /xgate/* {
        reverse_proxy localhost:8810 { flush_interval -1 }
    }
    handle { reverse_proxy localhost:3306 }
}
```

Endpoint: `https://borgs.animalabs.ai/xgate` (the prefix is stripped, so the
bridge still sees `/health`, `/timeline`, …). 443-only, no DNS/firewall work.

## Option C — dedicated port (matches the trace-viewer pattern)

```
borgs.animalabs.ai:3851 {
    reverse_proxy localhost:8810 { flush_interval -1 }
}
```

Endpoint: `https://borgs.animalabs.ai:3851`. Needs the port open in the firewall.

## Client config (x-mcpl)

Point the frontend at the chosen URL and give it the token:

```bash
X_BRIDGE_URL=https://xgate.animalabs.ai \
X_BRIDGE_TOKEN=<token from bridge .env> \
  npm run start -- --tcp 9100
```

## Verify

```bash
curl -s https://<host>/health                                   # 200, open
curl -s -o /dev/null -w '%{http_code}\n' https://<host>/timeline/repligate   # 401
curl -s -H "Authorization: Bearer $TOKEN" https://<host>/timeline/repligate?limit=1   # 200
```
