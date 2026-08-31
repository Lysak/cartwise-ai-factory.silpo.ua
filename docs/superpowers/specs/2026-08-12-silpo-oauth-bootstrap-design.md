# Silpo OAuth Bootstrap Design

## Goal

Create the first working product slice: a React/Vite web application and a NestJS API that complete Silpo OAuth 2.1 Authorization Code + PKCE, retain credentials only on the API, and make one read-only `tools/list` MCP probe.

## Scope

- Keep the planned React/Vite frontend. Next.js is not used because this authenticated Telegram Mini App does not need SSR or SEO.
- Run the frontend on host port `11200` and the API on host port `11201`.
- Bootstrap only the minimum API modules required for the OAuth proof: configuration, database, Silpo OAuth/MCP, and a health endpoint.
- Use PostgreSQL to persist the OAuth client registration and the encrypted token set. Redis is not used by this slice.
- Do not invoke any MCP write tool, expose tokens to the browser, or build product, price, score, or discount modules.

## Technology

- Node.js 26.7.0 image.
- React 19, Vite, TypeScript 6.0.3. TypeScript 7.0.2 is intentionally deferred because the current ESLint TypeScript integration does not support it.
- NestJS 11.1.29, Prisma 7.9.1, PostgreSQL 18.
- `@modelcontextprotocol/sdk` 1.30.0 with the official Streamable HTTP transport.

## Runtime flow

1. The browser opens `GET http://localhost:11201/api/auth/silpo/start`.
2. The API loads the one locally registered OAuth client, or registers it with `https://mcp.silpo.ua/register` using redirect URI `http://localhost:11201/api/auth/silpo/callback`.
3. The API generates a PKCE verifier, challenge, and single-use state, persists the short-lived verifier/state server-side, and redirects the browser to Silpo `authorize`.
4. Silpo redirects the browser to the callback with `code` and `state`.
5. The API validates and consumes state, exchanges the code at Silpo `token`, encrypts the token set with AES-256-GCM, and persists it. The raw token never enters an HTTP response or log.
6. The API creates the MCP client from the decrypted access token, calls only `tools/list`, stores a sanitized probe result, and responds with the authenticated result and tool names/count.

## Data model

- `oauth_clients`: one active Silpo DCR registration, storing client id and any returned secret encrypted.
- `silpo_connections`: one encrypted OAuth token set for this initial local test user, expiry metadata, status, and a replacement-safe refresh token field.
- `oauth_states`: hashed state, encrypted PKCE verifier, redirect URI, and expiration; deleted after callback consumption.
- `mcp_probes`: timestamp, outcome, tool count, and sanitized tool names/schema metadata; no credentials or personal response data.

## Security

- `TOKEN_ENCRYPTION_KEY` is exactly 32 random bytes encoded as base64 and exists only in local `.env`/deployment secrets.
- AES-256-GCM uses a fresh 12-byte IV per encrypted value and stores IV plus auth tag with ciphertext.
- Callback state is single-use and expires after 10 minutes.
- API CORS permits only `http://localhost:11200` during local development.
- Browser gets a success/failure page only. It never receives a Silpo access token, refresh token, client secret, or full MCP response.

## Verification

- Automated tests cover PKCE/state consumption, encryption round-trip, and a mocked OAuth callback/token exchange.
- Backend quality gates run ESLint, `tsc --noEmit`, Jest, and `prisma validate`.
- Manual proof: start Compose, open the start endpoint, complete Silpo login, then verify a successful stored connection and read-only `tools/list` probe through a sanitized API result.
- The first authenticated tool schema is treated as the authority for subsequent Product, Price Tracking, and Discount Optimizer plans.
