# Remote deployment

Run the TTS server on another Linux machine and point the extension to it.

## Install

```bash
sudo apt update
sudo apt install -y ffmpeg
curl -LsSf https://astral.sh/uv/install.sh | sh
git clone <repo-url>
cd <repo>
uv sync --python 3.12
cp server/.env.example server/.env
```

Set a random `API_KEY` in `server/.env`, then download the model:

```bash
uv run python scripts/download_vieneu_model.py
```

## Run

For a quick session:

```bash
tmux new -s localdub
uv run python server/main.py
```

The server listens on `127.0.0.1:18765`. Put Caddy or another HTTPS reverse
proxy in front of it before exposing it publicly.

## systemd

```ini
[Unit]
Description=Local AI Vietnamese Dubbing TTS
After=network.target

[Service]
WorkingDirectory=/path/to/repo
ExecStart=/path/to/uv run --directory /path/to/repo --no-sync python server/main.py
Restart=on-failure
User=your-user

[Install]
WantedBy=multi-user.target
```

The extension needs the HTTPS server URL and the same `API_KEY` in its Options.

## Model files

The model lives in `server/models/vieneu-nano/`, which is ignored by Git. A
fresh machine must run the downloader once, or receive that directory from your
deployment artifact storage. See [MODEL_DEPLOY.md](../MODEL_DEPLOY.md).
