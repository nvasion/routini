.PHONY: install dev dev-server dev-client build start worker test test-server test-client test-pg test-docker agents up down clean

# Install all dependencies
install:
	npm install
	cd server && npm install
	cd client && npm install

# API (embedded Postgres + inline worker) and console with hot reload
dev:
	npm run dev
dev-server:
	cd server && npm run dev
dev-client:
	cd client && npm run dev

# Production build and run (API; with DATABASE_URL also run `make worker`)
build:
	npm run build
start:
	cd server && npm start
worker:
	cd server && node dist/worker.js

# Tests
test: test-server test-client
test-server:
	cd server && NODE_ENV=test npx vitest run
test-client:
	cd client && npx vitest run --config vitest.config.ts
# Opt-in suites: a real Postgres (non-superuser owner) and a real Docker daemon
test-pg:
	cd server && NODE_ENV=test npx vitest run ../tests/pg-real.test.ts
test-docker:
	cd server && ROUTINI_E2E_DOCKER=1 NODE_ENV=test npx vitest run ../tests/agent-docker.e2e.test.ts

# Agent images (see agents/README.md)
agents:
	cd agents && docker build -f claude-code/Dockerfile -t routini/agent-claude:latest .
	cd agents && docker build -f fake/Dockerfile -t routini/agent-fake:test .

# Full stack in Docker (needs .env; see .env.example)
up:
	docker compose up --build -d
down:
	docker compose down

clean:
	rm -rf server/dist client/dist node_modules server/node_modules client/node_modules
