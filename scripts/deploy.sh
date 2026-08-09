#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="docker/docker-compose.yml"
ENV_FILE=".env"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ .env file not found. Copy .env.example to .env and configure it."
  exit 1
fi

echo "🚀 Deploying social-backend..."

# Pull latest images
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" pull

# Build and start
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --build

# Run migrations
echo "🗄️  Running migrations..."
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec app npx prisma migrate deploy

# Seed (optional)
# docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" exec app npm run db:seed

echo "✅ Deployment complete!"
echo "📊 API: http://localhost:3000"
echo "🔧 Kafka UI: http://localhost:8080"
