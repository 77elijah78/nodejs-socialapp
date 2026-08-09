param()

$ErrorActionPreference = "Stop"

$ComposeFile = "docker\docker-compose.yml"
$EnvFile = ".env"

if (-not (Test-Path $EnvFile)) {
    Write-Host "❌ .env file not found. Copy .env.example to .env and configure it." -ForegroundColor Red
    exit 1
}

Write-Host "🚀 Deploying social-backend..." -ForegroundColor Cyan

# Pull latest images
docker compose -f $ComposeFile --env-file $EnvFile pull

# Build and start
docker compose -f $ComposeFile --env-file $EnvFile up -d --build

# Run migrations
Write-Host "🗄️  Running migrations..." -ForegroundColor Cyan
docker compose -f $ComposeFile --env-file $EnvFile exec app npx prisma migrate deploy

# Seed (optional)
# docker compose -f $ComposeFile --env-file $EnvFile exec app npm run db:seed

Write-Host "✅ Deployment complete!" -ForegroundColor Green
Write-Host "📊 API: http://localhost:3000" -ForegroundColor Green
Write-Host "🔧 Kafka UI: http://localhost:8080" -ForegroundColor Green
