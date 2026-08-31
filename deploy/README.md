# Running the server on another machine

Run the TTS server on a remote host instead of your laptop and point the
extension at it. The server is API-only and always requires an `API_KEY`.

## 1. Install (Ubuntu)

```bash
sudo apt update && sudo apt install -y ffmpeg python3 python3-venv
git clone <repo-url>
cd <repo>/server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## 2. Set the API key

```bash
cp .env.example .env
python3 -c "import secrets; print(secrets.token_hex(16))"   # paste into API_KEY
```

The server refuses to start with an empty `API_KEY`.

## 3. Start it

```bash
tmux new -s localdub
.venv/bin/python main.py
# Ctrl+B then D detaches without stopping it. Reattach: tmux attach -t localdub
```

It stays on `127.0.0.1:18765`, which is what you want: the next step puts a
TLS-terminating proxy in front. Swagger is off by default (`ENABLE_DOCS=1`
turns it on, loopback only).

## 4. HTTPS with Caddy

Without HTTPS the translated text travels to the server in the clear. This
needs a domain whose A record points at the host.

```bash
sudo apt install -y caddy
sudo cp Caddyfile /etc/caddy/Caddyfile   # edit "your-domain.com" first
sudo systemctl restart caddy
```

Caddy obtains a Let's Encrypt certificate and proxies to the server on
`127.0.0.1:18765`. Leave the server bound to loopback — Caddy should be the
only thing listening publicly.

> Binding the server itself to `0.0.0.0` exposes plain HTTP to the internet.
> The API key still guards every route, but the caption text and the key
> itself would cross the network unencrypted. Only do it inside a trusted
> private network.

## 5. Point the extension at it

On the extension's Options page:

- **Server URL**: `https://your-domain.com`
- **Server API key**: the value from step 2

Then use **Check server** and **Load voices** to confirm the connection.

## Keeping it running

```bash
tmux attach -t localdub    # reattach
# Ctrl+C stops the server
```

For restart on crash or reboot, use systemd:

```ini
# /etc/systemd/system/localdub.service
[Unit]
Description=Local AI Vietnamese Dubbing TTS server
After=network.target

[Service]
WorkingDirectory=/path/to/repo/server
ExecStart=/path/to/repo/server/.venv/bin/python main.py
Restart=on-failure
User=your-user

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now localdub
journalctl -u localdub -f      # follow the logs
```

## Sizing

One job runs at a time, and `SYNTH_WORKERS` sentences within it run in
parallel — 3 by default, which is the useful ceiling on a 6-core machine. In a
CPU-limited container, set `ORT_THREADS` as well, or onnxruntime will size its
pools from the host's core count rather than the container's quota.
