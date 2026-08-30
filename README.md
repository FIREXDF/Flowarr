# Flowarr

Flowarr is a free, self-hosted media automation platform. It watches libraries, queues files, executes visual flows, drives FFmpeg safely, and reports storage savings.

## Development

Requirements: Node.js 24+, pnpm 11+, FFmpeg and ffprobe.

```bash
pnpm install
pnpm dev
```

Web UI: `http://localhost:5173`; API: `http://localhost:3000`.

## Distributed worker

Open **Nodes**, create a one-time registration token, then start a worker with a JSON path mapping. The server path is the library path known by Flowarr; the worker path is the same storage as mounted on the worker.

```powershell
$env:FLOWARR_SERVER_URL = "http://127.0.0.1:3000"
$env:FLOWARR_REGISTRATION_TOKEN = "paste-one-time-token"
$env:FLOWARR_PATH_MAPPINGS = '[{"serverPath":"D:\\Media","workerPath":"D:\\Media"}]'
pnpm --filter @flowarr/worker dev
```

The worker stores its signed identity under `apps/worker/data`, sends a heartbeat every 15 seconds, advertises FFmpeg encoders, and only claims compatible jobs whose paths are mapped.

## Docker

```bash
docker compose up --build
```

Mount media under `/media`. Flowarr never overwrites an input while FFmpeg is running.

Behind HTTPS, set `FLOWARR_SECURE_COOKIES=true`.

Prometheus metrics are available at `GET /api/metrics`. Administrator JWT works interactively. For a collector, set `FLOWARR_METRICS_TOKEN` and send `Authorization: Bearer <token>`.

Set `FLOWARR_WEBHOOK_URL` to receive JSON notifications when jobs succeed or fail. Optional `FLOWARR_WEBHOOK_SECRET` adds an HMAC-SHA256 signature in `X-Flowarr-Signature`.

The **Integrations** page connects Sonarr, Radarr, and Jellyfin instances and tests their credentials from the Flowarr server. API keys are encrypted with `FLOWARR_ENCRYPTION_KEY`; set a stable unique value before saving connections. Each connection can trigger a manual library refresh. Optional refresh-after-success automation is throttled to once every 15 minutes per service.

To start the optional Compose worker, create its token in **Nodes** and run:

```bash
FLOWARR_WORKER_REGISTRATION_TOKEN=token docker compose --profile worker up --build
```

License: AGPL-3.0-only.
