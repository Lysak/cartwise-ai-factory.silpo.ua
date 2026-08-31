DC := docker compose --env-file .env

.PHONY: up infra-up down restart logs ps api-logs api-test tunnel-up tunnel-down tunnel-logs

up:
	$(DC) up -d

infra-up:
	$(DC) up -d postgres redis

down:
	$(DC) down

restart:
	$(DC) up -d --force-recreate

logs:
	$(DC) logs -f

ps:
	$(DC) ps

api-logs:
	$(DC) logs -f backend

api-test:
	$(DC) exec -T backend npm test

tunnel-up:
	$(DC) --profile tunnel up -d --force-recreate frontend cloudflared

tunnel-down:
	$(DC) --profile tunnel stop cloudflared

tunnel-logs:
	$(DC) --profile tunnel logs -f cloudflared
