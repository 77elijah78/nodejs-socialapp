# Environment and Runtime Notes

## Existing backend env vars reused
- `NODE_ENV`
- `PORT`
- `BASE_URL`
- `CORS_ORIGIN`
- `DATABASE_URL`
- `REDIS_URL`
- `KAFKA_BROKERS`
- `KAFKA_CLIENT_ID`
- `KAFKA_GROUP_ID`
- `JWT_SECRET`
- `JWT_ACCESS_EXPIRES`
- `JWT_REFRESH_EXPIRES`
- `UPLOADS_PATH`
- `RATE_LIMIT_WINDOW_MS`
- `RATE_LIMIT_MAX`
- `LOG_LEVEL`

## Admin frontend env vars
- `VITE_API_BASE_URL` — optional override for API base, defaults to `/api/v1`
- `VITE_PROXY_TARGET` — local dev proxy target for Vite, defaults to `http://localhost:3000`

## Build commands
- Backend only: `npm run build`
- Admin only: `npm run admin:build`
- Full production bundle: `npm run build:all`

## Runtime path
- Admin UI is served by the backend at `/admin`
