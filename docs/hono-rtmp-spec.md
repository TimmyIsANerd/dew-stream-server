# Hono + Nginx RTMP live streaming spec

This is the per-service copy of the spec from the PDF.

See root docs or this service’s README for endpoints and nginx config. The service implements:
- POST /api/webhooks/publish
- POST /api/webhooks/publish_done
- GET /api/status/:publicStreamName
- POST /api/streams
