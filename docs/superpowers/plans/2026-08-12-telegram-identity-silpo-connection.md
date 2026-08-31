# Telegram Identity and Silpo Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ownerless Silpo OAuth bootstrap with verified Telegram identity, owned Silpo connections, opaque Redis sessions, and safe refresh behavior.

**Architecture:** NestJS remains a modular monolith. `AuthModule` verifies Telegram input and owns opaque Redis sessions; `SilpoModule` owns OAuth callback, token persistence, and the read-only refresh/retry boundary. PostgreSQL is authoritative for User/OAuth/connection data and Redis is authoritative only for live sessions and rate counters.

**Tech Stack:** NestJS 11, TypeScript, PostgreSQL 18 (`uuidv7()`), Prisma 7 migrations/schema, `pg`, Redis 8 with the `redis` client, React 19/Vite 8, Jest backend tests, Vitest frontend tests.

## Global Constraints

- No JWT, Passport, external identity provider, Next.js, BullMQ, Kafka, microservices, Redis queue, catalogue, score, prices, promotions, or MCP writes.
- The frontend never receives Silpo tokens, refresh tokens, OAuth client secrets, `TOKEN_ENCRYPTION_KEY`, bot token, or raw `initData` after bootstrap.
- Production is one HTTPS origin: `/` is React build and `/api` is NestJS. Production CORS is disabled.
- Use PostgreSQL 18 `uuidv7()` for every new primary key; do not use `gen_random_uuid()` for new Phase 1 records.
- Do not apply the ownership migration to a database with unowned `SilpoConnection` rows until an operator has explicitly approved the legacy cutover. Do not delete or remotely revoke legacy credentials in this implementation.
- Never commit unless the user explicitly says `виконай коміт`.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `backend/prisma/schema.prisma` | Identity-aware persistent models and database defaults. |
| `backend/prisma/migrations/*_telegram_identity/migration.sql` | Fresh-production schema and fail-closed legacy preflight. |
| `backend/src/auth/telegram-init-data.service.ts` | Strict Telegram HMAC and TTL validation. |
| `backend/src/auth/session.service.ts` | Opaque Redis session lifecycle, CSRF secret, and rate counters. |
| `backend/src/auth/session.guard.ts` | Resolves one User from Redis for authenticated routes. |
| `backend/src/auth/csrf.guard.ts` | Exact-origin plus synchronizer-token validation for unsafe routes. |
| `backend/src/auth/auth.controller.ts` | Bootstrap, local-session status, and logout HTTP contract. |
| `backend/src/auth/auth.module.ts` | Auth providers, route text-body parser, and guards. |
| `backend/src/silpo/silpo-oauth.service.ts` | Owned OAuth state, callback transaction, and DCR URI selection. |
| `backend/src/silpo/silpo-connection.service.ts` | Per-connection token refresh and read-only retry boundary. |
| `backend/src/silpo/silpo-oauth.controller.ts` | Callback and authenticated reauthorization routes only. |
| `backend/src/main.ts` | Cookie parser, exact proxy trust, production CORS policy, and safe parser limits. |
| `backend/src/app.module.ts`, `backend/src/silpo/silpo.module.ts` | Auth/Silpo module wiring. |
| `backend/package.json`, `backend/package-lock.json`, `.env.example` | Redis/cookie packages and required secret/origin configuration. |
| `deploy/nginx/cartwise.conf` | Same-origin production proxy contract; no frontend feature code is included in this phase. |
| `docs/superpowers/specs/2026-08-12-user-identity-and-silpo-connection-design.md` | Keep implementation decisions authoritative if code reveals a necessary clarification. |

## Task 1: Fail-closed schema and environment foundation

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/<timestamp>_telegram_identity/migration.sql`
- Modify: `backend/package.json`, `backend/package-lock.json`, `.env.example`
- Test: `backend/prisma/schema.prisma` via `npm run prisma:validate`

**Consumes:** PostgreSQL 18 and the existing OAuth bootstrap tables.

**Produces:** UUIDv7 User/connection/state schema plus server-only configuration required by the remaining tasks.

- [x] **Step 1: Add a migration preflight before structural SQL.**

  The migration must stop, rather than invent an owner, when legacy connection rows exist:

  ```sql
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM "SilpoConnection") THEN
      RAISE EXCEPTION
        'Legacy unowned SilpoConnection rows require an operator-approved cutover before Telegram identity migration';
    END IF;
  END $$;
  ```

- [x] **Step 2: Define persistent models with database UUIDv7 defaults.**

  Use the Prisma shape below; add explicit SQL check/indexes Prisma cannot express:

  ```prisma
  model User {
    id                   String  @id @default(dbgenerated("uuidv7()"))
    telegramUserId       String? @unique
    telegramUsername     String?
    telegramFirstName    String?
    telegramLastName     String?
    telegramLanguageCode String?
    silpoConnection      SilpoConnection?
    createdAt            DateTime @default(now())
    updatedAt            DateTime @updatedAt
  }

  model SilpoConnection {
    id                    String @id @default(dbgenerated("uuidv7()"))
    userId                String @unique
    user                  User   @relation(fields: [userId], references: [id])
    accessTokenEncrypted  String
    refreshTokenEncrypted String?
    accessTokenExpiresAt  DateTime?
    refreshTokenExpiresAt DateTime?
    status                String @default("active")
    createdAt             DateTime @default(now())
    updatedAt             DateTime @updatedAt

    @@index([status, accessTokenExpiresAt])
  }
  ```

  Add `OAuthState` owner fields, `OAuthClient.redirectUri`, `oauth_states.expiresAt` index, and this SQL check:

  ```sql
  ALTER TABLE "OAuthState" ADD CONSTRAINT "OAuthState_exact_owner"
  CHECK (
    ("ownerUserId" IS NULL AND "initiatingSessionHash" IS NULL AND "telegramUserId" IS NOT NULL)
    OR
    ("ownerUserId" IS NOT NULL AND "initiatingSessionHash" IS NOT NULL AND "telegramUserId" IS NULL)
  );
  ```

- [x] **Step 3: Add only required runtime dependencies and environment names.**

  Add `redis` and `cookie-parser` to backend dependencies and `@types/cookie-parser` to dev dependencies. Add these placeholders, never values, to `.env.example`:

  ```dotenv
  APP_ORIGIN=https://app.example.com
  TELEGRAM_BOT_TOKEN=replace-with-bot-token
  SESSION_COOKIE_INSECURE=false
  TRUST_PROXY=loopback
  ```

  Keep `TOKEN_ENCRYPTION_KEY`, database credentials, Redis URL, and Telegram bot token server-only; do not add any `VITE_*` secret.

- [x] **Step 4: Verify the foundation.**

  Run:

  ```bash
  docker compose run --rm backend npm run prisma:validate
  docker compose run --rm backend npm run typecheck
  ```

  Expected: schema validation and typecheck pass. Do not run the destructive/structural migration against a database until the preflight condition is explicitly approved.

## Task 2: Opaque Redis session service and guards

**Files:**
- Create: `backend/src/auth/session.service.ts`, `backend/src/auth/session.guard.ts`, `backend/src/auth/csrf.guard.ts`, `backend/src/auth/auth.module.ts`
- Create: `backend/src/auth/session.service.spec.ts`, `backend/src/auth/session.guard.spec.ts`, `backend/src/auth/csrf.guard.spec.ts`
- Modify: `backend/src/app.module.ts`, `backend/src/main.ts`

**Consumes:** Redis URL, cookie parser, authenticated `User.id`, and the schema from Task 1.

**Produces:** `SessionService`, `SessionGuard`, and `CsrfGuard` for all later authenticated routes.

- [x] **Step 1: Write the session lifecycle tests with fake time and a Redis test double.**

  Cover these exact cases:

  ```ts
  it('renews to thirty days but never beyond absolute expiry', async () => {
    // issuedAt = now - 89 days; successful resolve uses EXPIRE with <= 1 day
  });

  it('does not recreate a deleted key when renewing', async () => {
    // GET returns a valid session, DEL happens, EXPIRE returns 0, no SET occurs
  });

  it('rotates by deleting the old hash key before writing the new key', async () => {
    // old cookie ID cannot resolve after rotate
  });
  ```

- [x] **Step 2: Implement the smallest session record and Redis operations.**

  ```ts
  export type SessionRecord = {
    userId: string;
    telegramUserId: string;
    issuedAt: string;
    absoluteExpiresAt: string;
    csrfSecret: string;
  };

  const keyFor = (id: string) =>
    `session:${createHash('sha256').update(id).digest('base64url')}`;
  ```

  Generate IDs/secrets with `randomBytes(32).toString('base64url')`. `resolve()` performs `GET`, rejects/deletes expired records, then calls only `EXPIRE(key, remainingSeconds)`; it never uses `SET` during renewal. `create()` and `rotate()` return the opaque ID plus CSRF token only to the same-origin response builder.

- [x] **Step 3: Implement guard behavior and exact cookie options.**

  `SessionGuard` reads only `__Host-cartwise_session` in production, resolves it via `SessionService`, puts `{ id: userId, telegramUserId }` on the request, and throws 401 if Redis is down, absent, or expired. `CsrfGuard` for unsafe methods requires both `Origin === APP_ORIGIN` and a constant-time `x-csrf-token` match to the session record.

  ```ts
  const sessionCookie = {
    httpOnly: true,
    secure: !isInsecureLocalMode,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: ttlMilliseconds,
  };
  ```

  In production the name is exactly `__Host-cartwise_session` and no `domain` option is supplied. Local insecure mode must use a distinct non-`__Host-` name.

- [x] **Step 4: Wire application middleware safely.**

  In `main.ts`, install `cookieParser()`, set Express `trust proxy` to the explicit `TRUST_PROXY` value, and do not enable CORS when `APP_ORIGIN` is HTTPS production. In `AuthModule`, use `express.text({ type: 'text/plain', limit: '8kb' })` only on the bootstrap POST route; retain JSON parsing for normal APIs.

- [x] **Step 5: Run focused tests.**

  ```bash
  docker compose run --rm backend npm test -- session.service.spec.ts session.guard.spec.ts csrf.guard.spec.ts
  ```

  Expected: expiry, rotation, Redis fail-closed, origin, and CSRF tests pass.

## Task 3: Strict Telegram validator and bootstrap endpoint

**Files:**
- Create: `backend/src/auth/telegram-init-data.service.ts`, `backend/src/auth/auth.controller.ts`
- Create: `backend/src/auth/telegram-init-data.service.spec.ts`, `backend/src/auth/auth.controller.spec.ts`
- Modify: `backend/src/auth/auth.module.ts`

**Consumes:** Task 2 session services and `User` lookup SQL through the existing `pg` Pool pattern.

**Produces:** `POST /api/auth/telegram/bootstrap`, `GET /api/auth/session`, and `POST /api/auth/logout` contracts.

- [x] **Step 1: Create synthetic Telegram validation vectors.**

  Tests must create their own bot-token fixture and valid raw query string; they must assert rejection of stale, future, tampered, duplicated, malformed-user, and wrong-length hash input. The success assertion is:

  ```ts
  expect(result).toEqual({
    telegramUserId: '123456789012',
    username: 'test_user',
    firstName: 'Test',
    lastName: undefined,
    languageCode: 'uk',
  });
  ```

- [x] **Step 2: Implement Telegram parsing exactly once.**

  `TelegramInitDataService.validate(raw: string)` must use `URLSearchParams`, reject duplicate keys, remove `hash`, alphabetically sort remaining `key=value` entries joined by `\n`, calculate the Telegram two-stage HMAC, and compare equal-length Buffers with `timingSafeEqual`. Parse `user` JSON only after signature verification; require a safe integer Telegram ID and convert it to canonical decimal string. Do not log `raw` or include it in exceptions.

- [x] **Step 3: Define the bootstrap response union.**

  ```ts
  export type BootstrapResponse =
    | { status: 'authenticated'; csrfToken: string; silpoStatus: 'active' | 'reauth_required' | 'missing' }
    | { status: 'oauth_required'; authorizationUrl: string };
  ```

  The controller path is:

  ```text
  same session -> renew
  different session -> delete it
  existing verified Telegram User -> create session
  no User -> create first-owner OAuth state and return URL
  ```

  Apply IP limiting before `validate()` and verified-Telegram-ID limiting after it using atomic Redis counters with expiry. Return 429 without echoing `initData`.

- [x] **Step 4: Add status and logout routes.**

  `GET /api/auth/session` is SessionGuard-protected and returns the rotated/current CSRF token plus the connection status. `POST /api/auth/logout` is SessionGuard + CsrfGuard-protected, deletes the session and its initiating OAuth states, then clears the matching cookie. Neither response returns tokens or profile data.

- [x] **Step 5: Run focused tests.**

  ```bash
  docker compose run --rm backend npm test -- telegram-init-data.service.spec.ts auth.controller.spec.ts
  ```

  Expected: only validated raw `initData` can create a first-auth state; existing users receive a local session without an OAuth URL.

## Task 4: Owned OAuth state and callback transaction

**Files:**
- Modify: `backend/src/silpo/silpo-oauth.service.ts`, `backend/src/silpo/silpo-oauth.controller.ts`, `backend/src/silpo/silpo.module.ts`
- Create: `backend/src/silpo/silpo-oauth.service.spec.ts` replacement cases if the existing test is no longer representative
- Modify: `backend/src/auth/auth.module.ts`

**Consumes:** verified first-owner Telegram context or SessionGuard `userId` / session hash from Tasks 2–3.

**Produces:** `createFirstAuthorization()`, `createReauthorization()`, and a callback that cannot create an unowned connection.

- [x] **Step 1: Replace current ownerless state tests.**

  Add tests for atomic single consumption, state expiry, logout-invalidated reauthorization state, existing-user reauthorization replacement, two concurrent first callbacks resolving one User, and first callback creating exactly one User/connection/session. Keep the failed callback assertion: no User is created when token exchange fails.

- [x] **Step 2: Replace the old start endpoint with two typed service entrypoints.**

  ```ts
  createFirstAuthorization(telegram: VerifiedTelegramUser): Promise<string>
  createReauthorization(owner: { userId: string; sessionId: string }): Promise<string>
  completeAuthorization(input: { code: string; state: string }): Promise<{ userId: string; sessionId: string }>
  ```

  Both creation methods create state/verifier with a ten-minute expiry. Reauthorization hashes the initiating session ID. Remove the public `GET /auth/silpo/start` and public global `/probe` route; retain `tools/list` only as an internal sanitized diagnostic if still needed.

- [x] **Step 3: Implement callback ordering.**

  Use `DELETE FROM "OAuthState" ... RETURNING ...` to consume before exchange. For reauthorization, verify the referenced Redis session before exchange. After exchange, use a PostgreSQL transaction to either insert User + connection for the Telegram owner or update the connection identified by `ownerUserId`. Use `uuidv7()` in raw SQL. Create/rotate the Redis session after commit; on Redis failure return an authentication failure without emitting credentials.

- [x] **Step 4: Scope DCR registrations to the configured origin.**

  Build callback URI only from `APP_ORIGIN`. Query `OAuthClient` by `redirectUri`; register and persist a new client only if no registration matches. Never reuse the localhost DCR client for production.

- [x] **Step 5: Run OAuth tests.**

  ```bash
  docker compose run --rm backend npm test -- silpo-oauth.service.spec.ts
  ```

  Expected: state replay fails, logout cancels reauthorization, and callback creates only an owned connection.

## Task 5: Centralized Silpo access, refresh, and reauthorization state

**Files:**
- Create: `backend/src/silpo/silpo-connection.service.ts`, `backend/src/silpo/silpo-connection.service.spec.ts`
- Modify: `backend/src/silpo/silpo-oauth.service.ts`, `backend/src/silpo/silpo.module.ts`, `backend/src/app.module.ts`
- Modify: `backend/src/silpo/silpo-oauth.service.spec.ts`

**Consumes:** owned `SilpoConnection`, TokenCipherService, and authenticated User ID.

**Produces:** one user-scoped token accessor and no global refresh side effects.

- [x] **Step 1: Write refresh-concurrency and classification tests.**

  Cover these exact behaviors:

  ```ts
  it('refreshes only the requested user connection on demand', async () => {});
  it('preserves the old refresh token when no rotated token is returned', async () => {});
  it('sets reauth_required only for a 400 or 401 refresh rejection', async () => {});
  it('retries one explicitly read-only operation once after authorization rejection', async () => {});
  it('never retries a write operation automatically', async () => {});
  ```

- [x] **Step 2: Expose a narrow API.**

  ```ts
  withReadAccess<T>(userId: string, operation: (accessToken: string) => Promise<T>): Promise<T>
  withWriteAccess<T>(userId: string, operation: (accessToken: string) => Promise<T>): Promise<T>
  refreshExpiringConnections(): Promise<void>
  ```

  `withReadAccess` may refresh and retry the passed operation exactly once on a classified authorization failure. `withWriteAccess` obtains a valid token but never retries its operation. Neither accepts a connection ID from HTTP input.

- [x] **Step 3: Serialize work per connection.**

  Cron runs hourly and selects `active` rows expiring within two hours. For each selected ID, start a separate transaction, `SELECT ... FOR UPDATE`, refresh only that row, atomically save its token set, and commit. Do not retain a transaction across a batch and do not call cron from an on-demand access method.

- [x] **Step 4: Normalize reauthorization output.**

  If connection status is `reauth_required`, throw a typed domain exception mapped to a non-401 response such as:

  ```json
  { "code": "SILPO_REAUTH_REQUIRED", "message": "Silpo reauthorization required" }
  ```

  Existing local session remains valid. Temporary upstream failures map separately and never change connection status.

- [x] **Step 5: Run focused tests.**

  ```bash
  docker compose run --rm backend npm test -- silpo-connection.service.spec.ts silpo-oauth.service.spec.ts
  ```

  Expected: read-only retry and refresh rotation pass; write retry and transient-to-reauth transitions fail if introduced.

## Task 6: Production same-origin ingress contract

**Files:**
- Create: `deploy/nginx/cartwise.conf`
- Modify: `docker-compose.yml` only if needed to keep local Vite proxy behavior explicit

**Consumes:** endpoints from Tasks 3–5 and compiled Vite static assets.

**Produces:** same-origin deployment routing. Frontend implementation remains explicitly deferred.

- [x] **Step 1: Write a production reverse-proxy contract.**

  `deploy/nginx/cartwise.conf` must route only `/api/` to the NestJS upstream and all other paths to Vite static files, pass `Host`, `X-Forwarded-Proto`, and one trusted `X-Forwarded-For`, and not expose backend/Redis/Postgres ports publicly. TLS certificate provisioning remains an infrastructure secret outside git.

- [x] **Step 2: Verify routing and Vite production build without changing frontend behavior.**

  ```bash
  docker compose run --rm frontend npm run build
  ```

  Expected: successful production build. Audit the built assets and proxy configuration to confirm no server secret, backend credential, or production CORS rule is exposed.

## Task 7: Final verification and operational handoff

**Files:**
- Modify: `README.md` or an existing operations section only with exact required production env names and cutover preflight; do not document secret values.
- Modify: `docs/superpowers/specs/2026-08-12-user-identity-and-silpo-connection-design.md` only if implementation reveals an unavoidable decision change.

**Consumes:** all prior tasks.

**Produces:** evidence that Phase 1 works without accessing personal Silpo data or a real OAuth session in automated tests.

- [x] **Step 1: Run static and test suites.**

  ```bash
  docker compose run --rm backend npm run lint
  docker compose run --rm backend npm run typecheck
  docker compose run --rm backend npm test
  docker compose run --rm backend npm run prisma:validate
  docker compose run --rm frontend npm run lint
  docker compose run --rm frontend npm test
  docker compose run --rm frontend npm run build
  git diff --check
  ```

  Expected: every command exits 0. If an unrelated existing failure occurs, record it separately and do not mask it.

- [x] **Step 2: Perform the non-personal manual smoke check.**

  In a non-production test environment with synthetic Telegram fixtures, verify: stale/tampered bootstrap is rejected; a synthetic existing User receives a new cookie session; logout clears it; `reauth_required` preserves the local session and returns the explicit domain code. Do not inspect, print, or persist Silpo profile/cart/token payloads.

- [x] **Step 3: Validate cutover readiness before production migration.**

  Operator confirmed on 2026-08-12 that the target database is fresh. This plan intentionally has no deletion command and no automatic remote revoke.

## Plan Self-Review

- Spec coverage: Tasks 1–4 cover canonical identity, legacy cutover, Telegram HMAC, owned OAuth state, and sessions; Task 5 covers token lifecycle and `reauth_required`; Task 6 covers same-origin React/Vite transport without frontend implementation; Task 7 covers quality and operational preflight.
- Scope: no product domain, web auth, queue, or provider expansion appears in a task.
- Consistency: all task interfaces use canonical `userId`, PostgreSQL `uuidv7()`, opaque Redis session IDs, and explicit read/write MCP access.
- Repository policy: commit steps were intentionally omitted; a commit is allowed only after a user explicitly asks `виконай коміт`.
