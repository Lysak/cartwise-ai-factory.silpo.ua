# Silpo OAuth Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a React/Vite frontend and NestJS API locally, authenticate a Silpo user with OAuth 2.1 + PKCE, store the token set encrypted, and prove access with a read-only MCP `tools/list` call.

**Architecture:** The browser talks only to the NestJS API. The API owns Dynamic Client Registration, PKCE state, token exchange, AES-256-GCM encryption, PostgreSQL persistence, and the Streamable HTTP MCP client. React/Vite only starts authorization and displays the sanitized result.

**Tech Stack:** Node.js 26.7.0, React 19.2.8, Vite 8.2.1, NestJS 11.1.29, TypeScript 6.0.3, Prisma 7.9.1, PostgreSQL 18, Redis 8, `@modelcontextprotocol/sdk` 1.30.0, ESLint 10.8.1, Vitest 4.1.10, Jest.

## Global Constraints

- Host ports are `11200` for frontend and `11201` for API; PostgreSQL and Redis retain their existing ports.
- Use only `https://mcp.silpo.ua/mcp`; call no MCP write tool in this slice.
- Tokens, client secrets, PKCE verifiers, and raw MCP payloads never enter browser responses, logs, committed files, or test snapshots.
- Use AES-256-GCM with a base64-encoded 32-byte `TOKEN_ENCRYPTION_KEY` from local `.env`.
- Next.js is not used; React/Vite is the Telegram Mini App frontend and NestJS is the only backend.
- Do not add BullMQ, Kafka, microservices, or a queue.
- Do not create a git commit unless the user explicitly says `виконай коміт`.

---

### Task 1: Fix local ports and service entry points

**Files:**
- Modify: `.env`
- Modify: `.env.example`
- Modify: `docker-compose.yml`
- Modify: `Makefile`

**Interfaces:**
- Produces: `http://localhost:11200` frontend and `http://localhost:11201` API routes.

- [ ] **Step 1: Add explicit frontend and API forwarding variables**

Set the local values in both `.env` and `.env.example`:

```dotenv
FORWARD_APP_PORT=11200
FORWARD_API_PORT=11201
```

Remove the unused `FORWARD_APP_HTTPS_PORT` entry. Add a randomly generated local `TOKEN_ENCRYPTION_KEY` only to `.env`; keep a non-secret explanatory placeholder in `.env.example`.

- [ ] **Step 2: Expose the API and use the two variables in Compose**

Change frontend to `npm run dev -- --host 0.0.0.0 --port 5173` and map `${FORWARD_APP_PORT}:5173`. Map backend `${FORWARD_API_PORT}:3000`; keep the container-to-container frontend proxy target as `http://backend:3000`.

- [ ] **Step 3: Add focused Make targets**

Add these targets without changing the existing lifecycle targets:

```make
api-logs:
	$(DC) logs -f backend

api-test:
	$(DC) exec -T backend npm test
```

- [ ] **Step 4: Validate Compose interpolation**

Run: `docker compose --env-file .env config --quiet`

Expected: exit code 0, with frontend published at `11200` and backend at `11201`.

### Task 2: Bootstrap the React/Vite client

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/tsconfig.json`
- Create: `frontend/index.html`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/App.test.tsx`
- Create: `frontend/eslint.config.js`
- Modify: `frontend/vite.config.ts`

**Interfaces:**
- Consumes: `GET /api/auth/silpo/start` and `GET /api/auth/silpo/probe`.
- Produces: a mobile-safe page with a single “Підключити Сільпо” link and a sanitized result display.

- [ ] **Step 1: Install exact client dependencies**

Create `frontend/package.json` with scripts:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "lint": "eslint .",
    "test": "vitest run"
  }
}
```

Install `react@19.2.8`, `react-dom@19.2.8`, `vite@8.2.1`, `typescript@6.0.3`, `vitest@4.1.10`, `eslint@10.8.1`, and the matching TypeScript/React ESLint plugins.

- [ ] **Step 2: Write the failing UI test**

```tsx
it('links to the API authorization start endpoint', () => {
  render(<App />);
  expect(screen.getByRole('link', { name: 'Підключити Сільпо' }))
    .toHaveAttribute('href', '/api/auth/silpo/start');
});
```

- [ ] **Step 3: Implement the smallest client**

`App.tsx` renders the link above and, after redirect back from the API, fetches `/api/auth/silpo/probe` to show only `status`, `checkedAt`, and tool count. Do not persist auth data in browser storage.

- [ ] **Step 4: Run client checks**

Run: `docker compose --env-file .env run --rm frontend npm run lint && docker compose --env-file .env run --rm frontend npm test && docker compose --env-file .env run --rm frontend npm run build`

Expected: all commands exit 0.

### Task 3: Bootstrap the NestJS API and quality gates

**Files:**
- Create: `backend/package.json`
- Create: `backend/tsconfig.json`
- Create: `backend/nest-cli.json`
- Create: `backend/eslint.config.mjs`
- Create: `backend/src/main.ts`
- Create: `backend/src/app.module.ts`
- Create: `backend/src/health/health.controller.ts`
- Create: `backend/src/health/health.controller.spec.ts`

**Interfaces:**
- Produces: `GET /api/health` returns `{ "status": "ok" }`.
- Consumes: `PORT=3000`, `FRONTEND_ORIGIN=http://localhost:11200`, and `DATABASE_URL`.

- [ ] **Step 1: Add exact API dependencies and scripts**

Use NestJS `11.1.29`, Prisma `7.9.1`, TypeScript `6.0.3`, ESLint `10.8.1`, and Jest. Define these scripts:

```json
{
  "start:dev": "nest start --watch",
  "lint": "eslint \"src/**/*.ts\" \"test/**/*.ts\"",
  "typecheck": "tsc --noEmit",
  "test": "jest --runInBand",
  "prisma:validate": "prisma validate"
}
```

- [ ] **Step 2: Write the health test before the controller**

```ts
it('returns the API health payload', () => {
  expect(new HealthController().get()).toEqual({ status: 'ok' });
});
```

- [ ] **Step 3: Implement API bootstrap**

`main.ts` sets global prefix `api`, enables CORS only for `http://localhost:11200`, listens on `0.0.0.0:3000`, and loads configuration through `@nestjs/config`. `HealthController.get()` returns `{ status: 'ok' }`.

- [ ] **Step 4: Run API baseline gates**

Run: `docker compose --env-file .env run --rm backend npm run lint && docker compose --env-file .env run --rm backend npm run typecheck && docker compose --env-file .env run --rm backend npm test`

Expected: all commands exit 0.

### Task 4: Add Prisma persistence and token encryption

**Files:**
- Create: `backend/prisma/schema.prisma`
- Create: `backend/src/database/database.module.ts`
- Create: `backend/src/database/prisma.service.ts`
- Create: `backend/src/security/token-cipher.service.ts`
- Create: `backend/src/security/token-cipher.service.spec.ts`
- Create: `backend/src/silpo/silpo.module.ts`

**Interfaces:**
- Produces: `TokenCipherService.encrypt(plain: string): string` and `decrypt(payload: string): string`.
- Produces: Prisma models `OAuthClient`, `OAuthState`, `SilpoConnection`, and `McpProbe`.

- [ ] **Step 1: Write cipher tests**

```ts
it('round-trips a token and produces distinct ciphertexts', () => {
  const cipher = new TokenCipherService(testKey);
  const first = cipher.encrypt('access-token');
  expect(cipher.decrypt(first)).toBe('access-token');
  expect(cipher.encrypt('access-token')).not.toBe(first);
});
```

- [ ] **Step 2: Implement AES-256-GCM**

Reject a decoded key whose byte length is not 32. For each encrypt operation, generate a 12-byte IV with `randomBytes(12)`, append the 16-byte authentication tag, and serialize `iv.tag.ciphertext` as base64url segments. Throw a generic `Invalid encrypted token` error on failed decryption.

- [ ] **Step 3: Define the first migration**

Create the four models using UUID primary keys. `OAuthState` stores `stateHash`, encrypted verifier, redirect URI, expiry, and `consumedAt`; `SilpoConnection` stores encrypted access and refresh tokens plus expiry/status; `McpProbe` stores only tool count, JSON array of names, outcome, and timestamp.

- [ ] **Step 4: Validate persistence**

Run: `docker compose --env-file .env run --rm backend npm run prisma:validate && docker compose --env-file .env run --rm backend npx prisma migrate dev --name silpo_oauth_bootstrap`

Expected: schema validation and migration succeed against the local PostgreSQL container.

### Task 5: Implement OAuth 2.1 + PKCE and the read-only MCP probe

**Files:**
- Create: `backend/src/silpo/silpo.constants.ts`
- Create: `backend/src/silpo/silpo-oauth.service.ts`
- Create: `backend/src/silpo/silpo-oauth.controller.ts`
- Create: `backend/src/silpo/silpo-mcp.service.ts`
- Create: `backend/src/silpo/dto/silpo-probe-response.dto.ts`
- Create: `backend/src/silpo/silpo-oauth.service.spec.ts`
- Create: `backend/src/silpo/silpo-oauth.controller.spec.ts`

**Interfaces:**
- Produces: `GET /api/auth/silpo/start`, `GET /api/auth/silpo/callback`, and `GET /api/auth/silpo/probe`.
- Consumes: official protected-resource metadata, authorization-server metadata, DCR, `authorize`, `token`, and Streamable HTTP MCP endpoint.

- [ ] **Step 1: Write service tests around the trust boundary**

```ts
it('rejects an unknown or consumed callback state', async () => {
  await expect(service.completeAuthorization('bad-state', 'code'))
    .rejects.toThrow('Invalid or expired authorization state');
});

it('persists only encrypted tokens and a sanitized tools/list result', async () => {
  await service.completeAuthorization(validState, 'code');
  expect(connection.accessTokenEncrypted).not.toContain('access-token');
  expect(probe.toolNames).toContain('silpo_get_my_shopping_cart');
});
```

- [ ] **Step 2: Implement metadata and DCR**

Read the `resource_metadata` URL from the MCP `401` challenge, then read authorization-server metadata. Persist the DCR `client_id` and encrypt any returned `client_secret`; reuse that record on later authorization starts. Register exactly `http://localhost:11201/api/auth/silpo/callback` as the redirect URI, with `token_endpoint_auth_method` `none` unless the live registration response requires a client secret.

- [ ] **Step 3: Implement authorization start and callback**

Generate 32 random bytes each for state and verifier, calculate `SHA256(verifier)` base64url as the S256 challenge, store only `SHA256(state)` and an encrypted verifier with a ten-minute expiry. Redirect to the metadata `authorization_endpoint` using `response_type=code`, client id, redirect URI, state, code challenge, and `code_challenge_method=S256`. On callback, atomically consume state before exchanging code; then encrypt and upsert the token set.

- [ ] **Step 4: Implement `tools/list` through the official SDK**

Create `StreamableHTTPClientTransport(new URL('https://mcp.silpo.ua/mcp'), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } })`, connect a `Client`, call `listTools()`, and persist only `{ toolCount, toolNames, checkedAt, outcome }`. Ensure the controller returns that same sanitized DTO and closes the client transport in `finally`.

- [ ] **Step 5: Run automated OAuth checks**

Run: `docker compose --env-file .env run --rm backend npm run lint && docker compose --env-file .env run --rm backend npm run typecheck && docker compose --env-file .env run --rm backend npm test`

Expected: all commands exit 0; tests use mocked metadata, DCR, token, and MCP transports and no real credentials.

### Task 6: Perform the human OAuth proof and capture only safe evidence

**Files:**
- Modify: `README.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: live Silpo login performed by the user in the browser.
- Produces: documented safe local start command and a verified `McpProbe` record.

- [ ] **Step 1: Document the one interactive command**

Add this exact local sequence to `README.md`:

```bash
cp .env.example .env
make up
open http://localhost:11200
```

Document that the browser login is required, no token should be copied into the terminal, and the result is limited to tool names/count.

- [ ] **Step 2: Start the stack and test routing**

Run: `make up && curl --fail http://localhost:11201/api/health && curl --fail http://localhost:11200`

Expected: health returns `{ "status": "ok" }`; frontend returns HTML.

- [ ] **Step 3: Complete the authorization interactively**

Open `http://localhost:11200`, select “Підключити Сільпо”, complete Silpo login in the browser, and return to the frontend. Do not use any write tool or paste credentials into chat/terminal output.

- [ ] **Step 4: Verify the sanitized proof**

Run: `curl --fail http://localhost:11201/api/auth/silpo/probe`

Expected: JSON includes successful status, timestamp, and a positive tool count/names; it contains no access token, refresh token, client secret, user profile, cart, or tool result payload.

- [ ] **Step 5: Run final repository checks**

Run: `docker compose --env-file .env run --rm backend npm run lint && docker compose --env-file .env run --rm backend npm run typecheck && docker compose --env-file .env run --rm backend npm test && docker compose --env-file .env run --rm frontend npm run lint && docker compose --env-file .env run --rm frontend npm test && docker compose --env-file .env run --rm frontend npm run build && git diff --check`

Expected: every command exits 0.
