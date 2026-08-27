# Deploy to a server

Run the TTS server on a remote machine instead of locally, and point the
extension at it. The server is API-only and always requires an `API_KEY`.

## 1. Set up the server (Ubuntu)

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
python3 -c "import secrets; print(secrets.token_hex(16))"   # paste into API_KEY in .env
```

The server refuses to start with an empty `API_KEY`.

## 3. Run the server (in tmux)

```bash
tmux new -s localdub
.venv/bin/python main.py --host 0.0.0.0
# Ctrl+B then D to detach without stopping the server. Reattach: tmux attach -t localdub
```

On startup it logs its environment, detected public IP, and the Swagger
UI link.

## 4. HTTPS via Caddy

Without HTTPS, translated text sent to the server travels unencrypted.
Requires a domain with an A record pointing at the server's IP.

```bash
sudo apt install -y caddy
sudo cp Caddyfile /etc/caddy/Caddyfile   # edit "your-domain.com" first
sudo systemctl restart caddy
```

Caddy handles Let's Encrypt certificates and proxies to the server running
locally on `127.0.0.1:18765`. Keep the server bound to `127.0.0.1`
(the default) — Caddy is the only thing that should be exposed publicly.

## 5. Configure the extension

In the extension's settings, **Voice** tab:

- **Server URL**: `https://your-domain.com`
- **API key**: the value from step 2

## Stop / restart

```bash
tmux attach -t localdub    # reattach to the running session
# Ctrl+C to stop the server
```

To auto-restart on crash or reboot, use `systemd`:

```ini
# /etc/systemd/system/localdub.service
[Unit]
Description=Local AI Vietnamese Dubbing TTS server
After=network.target

[Service]
WorkingDirectory=/path/to/repo/server
ExecStart=/path/to/repo/server/.venv/bin/python main.py --host 0.0.0.0
Restart=on-failure
User=your-user

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now localdub
```
