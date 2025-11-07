# dew-streaming-service

Standalone Hono service for live streaming control-plane, designed to pair with Nginx RTMP + HLS.

Features
- Nginx RTMP webhooks: authorize ingest (on_publish) and end-of-stream (on_publish_done)
- Stream management: create stream and issue streamKey
- Public stream status endpoint (no secrets)

Endpoints
- POST /api/streams
  - Body: { userId: string, publicStreamName: string, title?: string }
  - Returns: masked streamKey and RTMP hints
- GET /api/streams/:publicStreamName
- GET /api/status/:publicStreamName
- POST /api/webhooks/publish (application/x-www-form-urlencoded)
- POST /api/webhooks/publish_done (application/x-www-form-urlencoded)

Environment
- PORT (default 8787)
- CORS_ORIGIN (default http://localhost:3001)
- MONGO_URI (default mongodb://localhost:27017/dew_streaming)
- RTMP_HOOK_SECRET (optional; if set, require ?secret=... or X-Hook-Secret)
- RTMP_INGEST_URL (optional hint for clients)

Local run
- cp .env.example .env
- npm install
- npm run dev

Pairing with Nginx RTMP
- Set on_publish and on_publish_done to this service:
  - on_publish http://<SERVICE_HOST>:8787/api/webhooks/publish?secret=$RTMP_HOOK_SECRET
  - on_publish_done http://<SERVICE_HOST>:8787/api/webhooks/publish_done?secret=$RTMP_HOOK_SECRET
- HLS should be served over HTTP (e.g., http://<HLS_HOST>:8080/hls/<publicStreamName>/index.m3u8)

Notes
- streamKey is a secret; never expose via public endpoints
- Return codes: 2xx allows publish; 403 denies
