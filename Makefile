.PHONY: help dev prod build stop clean logs migrate seed

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

dev: ## Start development environment
	docker compose -f docker/docker-compose.dev.yml --env-file .env up --build

prod: ## Start production environment
	bash scripts/deploy.sh

build: ## Build production image
	docker build -t social-backend:latest .

stop: ## Stop all services
	docker compose -f docker/docker-compose.dev.yml --env-file .env down

stop-prod: ## Stop production services
	docker compose -f docker/docker-compose.yml --env-file .env down

clean: ## Stop and remove all volumes (WARNING: destroys data)
	docker compose -f docker/docker-compose.dev.yml --env-file .env down -v

logs: ## Tail app logs
	docker compose -f docker/docker-compose.dev.yml --env-file .env logs -f app

logs-prod: ## Tail production app logs
	docker compose -f docker/docker-compose.yml --env-file .env logs -f app

migrate: ## Run Prisma migrations
	docker compose -f docker/docker-compose.yml --env-file .env exec app npx prisma migrate deploy

seed: ## Seed database
	docker compose -f docker/docker-compose.yml --env-file .env exec app npm run db:seed

studio: ## Open Prisma Studio
	docker compose -f docker/docker-compose.yml --env-file .env exec app npx prisma studio

shell: ## Shell into app container
	docker compose -f docker/docker-compose.yml --env-file .env exec app sh
