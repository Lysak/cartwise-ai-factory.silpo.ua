# Silpo-First Durable Identity and Token Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the verified Silpo browser OAuth grant into a durable Cartwise account keyed by the approved `profile.id` subject path, with encrypted server-side token persistence and an opaque session.

**Architecture:** Add a separate browser-bound `silpo_connect` OAuth purpose. The callback exchanges the code in memory, calls only `silpo_get_my_profile`, extracts `profile.id` without retaining the raw response, atomically upserts `User.silpoExternalId` and its `SilpoConnection`, then creates the existing Redis session. Telegram identity remains optional metadata; no heuristic merge or personal-profile copy is added.

**Tech Stack:** NestJS 11, TypeScript 6, PostgreSQL 18 with Prisma 7, Redis 8, React 19/Vite 8, Jest, Vitest, Docker Compose, AES-256-GCM, official `https://mcp.silpo.ua/mcp`.

**Spec:** `docs/idea.md` §§3 and 9, `docs/superpowers/specs/2026-08-12-phase-1-production-decisions.md` §§2–8, and live redacted evidence in `docs/superpowers/plans/2026-08-30-silpo-identity-subject-verification.md`.

## Global Constraints

- The exact external subject path for this plan is `profile.id`; `loyalty.card.memberId` is not persisted or used for lookup.
- Store only the minimum identity needed by the product: `User.silpoExternalId`, encrypted access/refresh tokens, expiry metadata, status, and opaque Redis session metadata.
- Never persist or log raw MCP responses, names, phone, email, birthday, address, loyalty balance, display text, OAuth code, verifier, browser binding, access token, or refresh token in plaintext.
- The only new MCP action is `tools/call` for `silpo_get_my_profile` with `arguments: {}`; do not call loyalty or write tools during account creation.
- Use Authorization Code + PKCE S256, exact `APP_ORIGIN`, a single-use ten-minute state, and a dedicated short-lived HttpOnly `__Host-cartwise_silpo_connect` cookie.
- Reuse `TokenCipherService`, `SessionService`, `SilpoConnectionService`, existing refresh semantics, exact-origin checks, and existing session cookie settings; do not add Passport, JWT, queues, services, or dependencies.
- Existing Telegram-first and catalog-discovery flows must keep their current contracts. A browser Silpo account is not heuristically merged with a Telegram user; explicit future linking remains out of scope.
- This is the current checkout on `main`; preserve unrelated dirty files. Do not create a worktree, commit, push, merge, delete, or run `rlx init`.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `backend/prisma/schema.prisma` | Adds the nullable unique Silpo external subject. |
| `backend/prisma/migrations/20260830150000_silpo_first_identity/migration.sql` | Adds only `User.silpoExternalId`. |
| `backend/prisma/migrations/20260830151000_silpo_connect_state/migration.sql` | Adds the exact `silpo_connect` OAuth state invariant. |
| `backend/src/auth/session.service.ts` | Allows a session with no Telegram binding while retaining existing TTL/CSRF rules. |
| `backend/src/auth/session.guard.ts` | Propagates nullable Telegram metadata without weakening session authentication. |
| `backend/src/silpo/silpo-oauth.service.ts` | Adds the `silpo_connect` state, subject extraction, atomic user/connection upsert, and session creation. |
| `backend/src/silpo/silpo-oauth.controller.ts` | Adds connect start/callback cookie dispatch and session cookie issuance. |
| `backend/src/auth/auth.controller.ts` | Keeps `/session` valid for Silpo-only sessions and preserves Telegram bootstrap behavior. |
| `backend/src/*/*.spec.ts` | Tests state binding, subject extraction, token encryption/persistence, nullable sessions, and no raw-value leakage. |
| `frontend/src/App.tsx` | Starts Silpo-first login and loads the resulting opaque session status. |
| `frontend/src/App.test.tsx` | Covers browser login success/failure without rendering credentials. |
| `docs/superpowers/specs/2026-08-12-phase-1-production-decisions.md` | Records that Silpo external identity is the account key and Telegram is optional metadata for this phase. |

## Contracts

```ts
type SilpoConnectResult = {
  userId: string;
  sessionId: string;
  csrfToken: string;
};

type SessionRecord = {
  userId: string;
  telegramUserId: string | null;
  issuedAt: string;
  absoluteExpiresAt: string;
  csrfSecret: string;
};
```

- `User.silpoExternalId` is nullable and unique. `NULL` remains allowed for existing Telegram-first users until an explicit future linking flow is approved.
- `POST /api/auth/silpo/connect/start` returns only `{ authorizationUrl }` and sets the dedicated binding cookie.
- `GET /api/auth/silpo/callback` dispatches connect only when `__Host-cartwise_silpo_connect` is present, always clears it, sets `__Host-cartwise_session` on success, and redirects to `/?silpo=connected` or `/?silpo=failed`.
- `GET /api/auth/session` returns the existing authenticated response for a Silpo-only session; it never returns `silpoExternalId` or credentials.

## Task 1: Make the local identity/session schema support Silpo-first accounts

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20260830150000_silpo_first_identity/migration.sql`
- Modify: `backend/src/auth/session.service.ts`
- Modify: `backend/src/auth/session.guard.ts`
- Modify: `docs/superpowers/specs/2026-08-12-phase-1-production-decisions.md`
- Test: `backend/src/auth/session.service.spec.ts`
- Test: `backend/src/auth/session.guard.spec.ts`

**Consumes:** Existing nullable Telegram columns, unique User identity constraints, opaque Redis session format, and the empty production database verified by the preceding plan.

**Produces:** A schema and session contract that can represent a Silpo-only authenticated user without inventing a Telegram ID.

- [x] **Step 1: Write failing tests for nullable Telegram session metadata.**

  Add a session test that calls `create({ userId: 'user-1', telegramUserId: null })`, parses the Redis value, and expects `telegramUserId` to be `null`. Add a guard fixture with `telegramUserId: null` and expect `request.user` to contain `{ id: 'user-1', telegramUserId: null }` after a valid opaque session resolves.

- [x] **Step 2: Run the focused auth tests and confirm the old required-string contract fails.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test -- session.service.spec.ts session.guard.spec.ts
  ```

  Expected: the new nullable-input test fails at the TypeScript/session contract before implementation; existing auth tests remain attributable.

- [x] **Step 3: Add the minimal schema and session type change.**

  Add:

  ```prisma
  silpoExternalId String? @unique
  ```

  to `User`, and create the migration:

  ```sql
  ALTER TABLE "User" ADD COLUMN "silpoExternalId" TEXT;
  CREATE UNIQUE INDEX "User_silpoExternalId_key" ON "User"("silpoExternalId");
  ```

  Change only `SessionRecord.telegramUserId`, `CreateSessionInput`, and the guard request metadata to `string | null`; keep the opaque cookie, Redis hash, TTLs, CSRF, and absolute expiry unchanged.

- [x] **Step 4: Update the decision record without broadening product scope.**

  Amend the canonical identity section to state that `silpoExternalId` from the approved `profile.id` path is the local account key, Telegram is optional metadata, and no automatic merge/link is performed. Keep the existing token encryption, refresh, session, and no-personal-data rules.

- [x] **Step 5: Verify schema and focused auth behavior.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test -- session.service.spec.ts session.guard.spec.ts
  docker compose --env-file .env exec -T backend npm run prisma:validate
  docker compose --env-file .env exec -T backend npx prisma migrate deploy
  ```

  Expected: focused auth tests pass, Prisma validates, and only the new nullable unique column is applied.

## Task 2: Persist the verified Silpo subject and encrypted token set

**Files:**
- Modify: `backend/src/silpo/silpo-oauth.service.ts`
- Modify: `backend/src/silpo/silpo-oauth.service.spec.ts`
- Modify: `backend/src/silpo/silpo-connection.service.spec.ts`
- Create: `backend/prisma/migrations/20260830151000_silpo_connect_state/migration.sql`

**Consumes:** `User.silpoExternalId`, nullable sessions, current browser-binding state, `TokenCipherService`, and `SilpoConnectionService` refresh behavior.

**Produces:** `createSilpoConnectionAuthorization(browserBinding)` and `completeSilpoConnectionAuthorization({ code, state, browserBinding })`.

- [x] **Step 1: Write failing tests for the connect state and atomic persistence contract.**

  Add tests that mock one token exchange and one profile MCP response, then assert:

  ```ts
  expect(fetch).toHaveBeenNthCalledWith(2, 'https://mcp.silpo.ua/mcp', expect.objectContaining({
    body: expect.stringContaining('silpo_get_my_profile'),
    headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
  }));
  ```

  Decode the request body and require `method === 'tools/call'`, `params.name === 'silpo_get_my_profile'`, and `params.arguments` equal `{}`. Mock the transaction and assert one `User` upsert by `silpoExternalId`, one `SilpoConnection` upsert, and one session created with `telegramUserId: null`.

  Assert that the SQL/query arguments contain no name, phone, email, birthday, loyalty value, raw response, OAuth code, or plaintext token; decrypt only the test ciphertext in memory to prove the stored access and refresh values use `TokenCipherService`.

- [x] **Step 2: Run the focused service test and confirm the missing connect method fails.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-oauth.service.spec.ts
  ```

  Expected: failure identifies the absent connect method/state path, not a malformed provider fixture.

- [x] **Step 3: Add the separate `silpo_connect` OAuth state.**

  Extend the purpose invariant with:

  ```sql
  ("purpose" = 'silpo_connect'
    AND "telegramUserId" IS NULL
    AND "ownerUserId" IS NULL
    AND "initiatingSessionHash" IS NULL
    AND "browserBindingHash" IS NOT NULL)
  ```

  Store only the hashed state, encrypted verifier, exact redirect URI, purpose, and browser-binding hash. Consume with `DELETE ... RETURNING` before token exchange; reject wrong purpose, expiry, replay, binding, and redirect before any provider call.

- [x] **Step 4: Extract only `profile.id` and persist the minimum durable state.**

  Reuse the existing MCP result parsing rule: prefer object `result.structuredContent`; otherwise accept exactly one `result.content` text block parsing to an object. Read only `profile.id`, require a non-empty string, and fail generically if absent or malformed.

  In one PostgreSQL transaction, execute the equivalent of:

  ```sql
  INSERT INTO "User" (id, "silpoExternalId", "createdAt", "updatedAt")
  VALUES (uuidv7(), $1, NOW(), NOW())
  ON CONFLICT ("silpoExternalId") DO UPDATE SET "updatedAt" = NOW()
  RETURNING id, "telegramUserId";

  INSERT INTO "SilpoConnection" (...)
  VALUES (... encrypted access token ..., ... encrypted refresh token ..., ...)
  ON CONFLICT ("userId") DO UPDATE SET
    "accessTokenEncrypted" = EXCLUDED."accessTokenEncrypted",
    "refreshTokenEncrypted" = EXCLUDED."refreshTokenEncrypted",
    "accessTokenExpiresAt" = EXCLUDED."accessTokenExpiresAt",
    status = 'active',
    "updatedAt" = NOW();
  ```

  Create the existing opaque session only after commit, passing the returned Telegram ID (normally `null`). If session creation fails, surface a generic unavailable response; do not issue a browser session or log credentials.

- [x] **Step 5: Add negative and concurrency tests.**

  Cover missing/non-string/empty `profile.id`, wrong binding before exchange, state replay, token exchange failure with no User/connection, MCP failure with no partial commit, duplicate `silpoExternalId` resolving to one User, and replacement of an existing connection without erasing a provider-omitted refresh token.

- [x] **Step 6: Verify persistence behavior and refresh compatibility.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-oauth.service.spec.ts silpo-connection.service.spec.ts
  docker compose --env-file .env exec -T backend npm run typecheck
  ```

  Expected: all focused tests pass; no test asserts or prints a plaintext credential.

## Task 3: Expose Silpo-first login and session status

**Files:**
- Modify: `backend/src/silpo/silpo-oauth.controller.ts`
- Modify: `backend/src/silpo/silpo-oauth.controller.spec.ts`
- Modify: `backend/src/auth/auth.controller.spec.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.test.tsx`

**Consumes:** Connect service methods, existing session cookie helpers, and `GET /api/auth/session`.

**Produces:** A browser/Telegram-neutral Silpo login action that ends in an opaque local session without exposing identity or tokens.

- [x] **Step 1: Write failing controller/UI tests.**

  Test exact `Origin === APP_ORIGIN`, the existing Redis rate-limit boundary, `__Host-cartwise_silpo_connect` cookie attributes, success/failure callback cleanup, and session cookie issuance. Add a frontend test that starts `/api/auth/silpo/connect/start`, follows only the returned URL, then loads `/api/auth/session` after `silpo=connected`; assert no external ID, token, or raw provider value is rendered.

- [x] **Step 2: Run focused controller/frontend tests and confirm the route/UI are absent.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-oauth.controller.spec.ts auth.controller.spec.ts
  docker compose --env-file .env exec -T frontend npm test -- App.test.tsx
  ```

  Expected: only the new connect route/state assertions fail.

- [x] **Step 3: Implement the connect endpoint and callback branch.**

  Add `POST /api/auth/silpo/connect/start` with the same exact-origin and rate-limit rules as discovery. Set `__Host-cartwise_silpo_connect` with `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, and ten-minute max age. In the callback, dispatch connect only when this cookie is present, clear it on both success and failure, set `__Host-cartwise_session` from the returned session, and redirect only to the configured origin.

- [x] **Step 4: Make the frontend consume only session status.**

  Change the browser-neutral primary action to start Silpo login. On `silpo=connected`, call `GET /api/auth/session` with same-origin credentials and render only the existing generic connected/status/logout controls. Keep discovery/identity-evidence states available for the completed verification path; do not add localStorage, profile display, credential inputs, or token state.

- [x] **Step 5: Verify controller/UI behavior and build.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-oauth.controller.spec.ts auth.controller.spec.ts
  docker compose --env-file .env exec -T frontend npm test -- App.test.tsx
  docker compose --env-file .env exec -T frontend npm run build
  ```

  Expected: named suites and build pass, with no credential material in response/UI assertions.

  Evidence: RED initially failed on the absent `connectStart`/connect callback branch and missing `silpo=connected` session load. GREEN passed with backend controller/auth `21/21`, frontend `16/16`, and the frontend production build.

## Task 4: Controlled live cutover and verification

**Files:**
- Modify: `docs/superpowers/plans/2026-08-30-silpo-first-durable-identity.md` (checkboxes and redacted evidence only)

- [x] **Step 1: Confirm the database precondition without reading credentials.**

  Redacted evidence (2026-08-31, live DB via `psql` counts only, no token/personal columns selected):
  `User=1`, `User.silpoExternalId NOT NULL=1`, `SilpoConnection=1`, `SilpoConnection.status='active'=1`,
  `SilpoConnection` rows with both `accessTokenEncrypted` and `refreshTokenEncrypted` present `=1`, `OAuthState=0`.
  The pre-login baseline was zero rows in all three tables; the single row set is the user's own fresh grant.

- [x] **Step 2: Start and verify the public runtime.**

  Redacted evidence (2026-08-31): `docker compose ps` shows 5 services `Up` (`postgres`/`redis` healthy,
  `backend`, `frontend`, `cloudflared`), `restart` policy in effect, tunnel with active connections.
  `curl -fsS -o /dev/null -w '%{http_code}' https://silpo.lysak.pp.ua/api/health` → `200`.

- [x] **Step 3: Have the user complete fresh Silpo login.**

  Done by the user in their own browser via `Увійти через Silpo`. The agent handled no password, OTP, callback
  URL, cookie, authorization code, or token. Result observed only as durable non-secret rows below.

- [x] **Step 4: Verify only durable non-secret invariants.**

  Redacted evidence: exactly one `User` with a non-null `silpoExternalId`, one `active` `SilpoConnection` with
  non-null encrypted access and refresh columns, zero pending `OAuthState`, and `GET /api/auth/session` returns
  `status: 'authenticated'` after a clean root refresh with `silpoStatus` resolving to `active`
  (`Сільпо підключено` in the UI). No subject value printed; no token decrypted in any probe.

- [x] **Step 5: Verify refresh/logout boundaries and stop.**

  - Logout boundary (code-verified, `backend/src/auth/auth.controller.ts:66-75`): `POST /api/auth/logout`
    destroys only the opaque Redis session and deletes `OAuthState` rows matching `initiatingSessionHash`,
    then clears the `__Host-cartwise_session` cookie. It does not touch `SilpoConnection` or the encrypted
    tokens, so the durable Silpo identity survives a browser logout as intended.
  - Refresh boundary (code-verified, `backend/src/silpo/silpo-connection.service.ts:83-125`): both the
    on-demand and scheduled refresh paths read `refreshTokenEncrypted` from `SilpoConnection`, decrypt it
    only in memory via `TokenCipherService`, call `oauth.refreshToken`, and persist the new set atomically
    under `SELECT ... FOR UPDATE` with `COALESCE` preserving a provider-omitted refresh token. The stored
    encrypted refresh token is confirmed present for the live connection (Step 1).
  - Not exercised live: a real token rotation against Silpo (would require forcing expiry of a valid grant);
    deferred to the first authenticated product read, which will exercise this path naturally.
  - Telegram linking flow is not verified — `TELEGRAM_BOT_TOKEN` is unset — and remains out of scope.
  - Stop condition met. No additional identity/loyalty tool was called; no MCP write; no product read yet.

- [x] **Step 6: Run final verification without commit/delete.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test
  docker compose --env-file .env exec -T backend npm run typecheck
  docker compose --env-file .env exec -T backend npm run prisma:validate
  docker compose --env-file .env exec -T frontend npm test
  docker compose --env-file .env exec -T frontend npm run build
  docker compose --env-file .env --profile tunnel config --quiet
  git diff --check
  ```

  Report exact pass/fail counts, preserve unrelated dirty files, and do not commit.

  Redacted evidence (2026-08-31):
  - `backend npm test` → `Test Suites: 11 passed`, `Tests: 109 passed`.
  - `backend npm run typecheck` → clean, no output.
  - `backend npm run prisma:validate` → `The schema at prisma/schema.prisma is valid`.
  - `frontend npm test` → `Test Files 1 passed`, `Tests 21 passed`.
  - `frontend npm run build` → built `dist/` successfully (`index-*.js ~195 kB`).
  - `docker compose --env-file .env --profile tunnel config --quiet` → valid (only unset-optional-var warnings: `TRUST_PROXY`, `SESSION_COOKIE_INSECURE`, `TELEGRAM_BOT_TOKEN`).
  - `git diff --check` → clean.
  - Unrelated dirty files preserved; no commit, delete, push, or merge performed.

**Task 4 status: complete.** Durable Silpo-first identity is live and verified against redacted non-secret
invariants. Remaining deferrals (live token rotation, Telegram linking) are explicitly carried forward and
do not block the next plan. Next: `docs/superpowers/plans/2026-08-31-silpo-first-product-read.md`.

## Self-Review

- `profile.id` is the only selected subject path; `loyalty.card.memberId` and all display/personal fields remain out of the identity key.
- The plan uses the existing encrypted token and opaque-session mechanisms rather than adding a new auth stack.
- The transaction is idempotent for the same external subject and keeps Telegram metadata nullable.
- Negative tests cover state binding, malformed subject data, partial persistence, duplicate callbacks, token rotation, and secret leakage boundaries.
- The plan stops after durable session verification; it does not silently expand into Telegram linking, product reads, or MCP writes.
