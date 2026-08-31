# Silpo MCP Identity Discovery Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in a fresh IMPLEMENT context. Steps use checkbox (`- [ ]`) syntax for tracking. The canonical plan is this file; do not create a second `plan.md`.

**Goal:** Obtain fresh, browser-initiated OAuth access to the official Silpo MCP and persist only a sanitized `tools/list` catalog that lets the next planning session identify the documented user-identity operation.

**Architecture:** Add a short-lived, browser-bound discovery OAuth state alongside the existing Telegram-owned and authenticated-user reauthorization states. The callback exchanges its code with PKCE, invokes only MCP `tools/list`, writes no token and no user data, records the sanitized catalog in `McpProbe`, clears the binding cookie, and returns to the same public origin. The frontend exposes one browser/Telegram-neutral discovery button; it does not claim the user is signed in.

**Tech Stack:** NestJS 11, TypeScript 6, PostgreSQL 18/Prisma 7, React 19/Vite 8, Jest, Vitest, Docker Compose, official `https://mcp.silpo.ua/mcp`.

**Spec:** `docs/idea.md` §§2–3 and the approved discovery-only design recorded in this plan.

## Global Constraints

- This is a discovery-only slice. Do not implement Silpo-first login, account migration, product endpoints, Product Score, Telegram account linking, or a browser session.
- Browser and Telegram use the same `APP_ORIGIN`: `https://silpo.lysak.pp.ua`. Do not add a second domain.
- Use only the official Silpo OAuth/MCP endpoints and Authorization Code + PKCE S256. Do not use a static client secret, JWT, Passport, or a new identity provider.
- `POST /api/auth/silpo/discovery/start` must be same-origin and rate-limited. Its callback must require both a single-use ten-minute state and a matching short-lived HttpOnly binding cookie.
- The callback may call only MCP `tools/list`. It must not call arbitrary catalog tools, including candidate profile/account tools, in this slice.
- Never log, return, snapshot, commit, or store raw access tokens, refresh tokens, authorization codes, browser binding values, cookies, personal data, or raw MCP payloads.
- Persist only a sanitized MCP catalog: each tool's `name`, `description`, and `inputSchema`; exclude any server response metadata not required for those fields.
- The OAuth code, verifier, and tokens are process-local during the callback. At callback completion or failure, no `User`, `SilpoConnection`, Redis session, or persisted discovery credential may exist.
- Keep the existing Telegram bootstrap and authenticated reauthorization flow unchanged. This plan only introduces a third, explicitly `discovery` state shape.
- Do not run `rlx init`, do not create `plan.md`, do not use a git worktree, and never run `git commit`.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `backend/prisma/schema.prisma` | Represents the discovery state/binding and a correctly named sanitized MCP catalog column. |
| `backend/prisma/migrations/<timestamp>_silpo_mcp_identity_discovery/migration.sql` | Adds the discovery state invariant and renames the empty local `McpProbe.toolNames` column to `toolCatalog`. |
| `backend/src/silpo/silpo-oauth.service.ts` | Creates/consumes browser-bound discovery OAuth state and performs the one permitted `tools/list` call. |
| `backend/src/silpo/silpo-oauth.controller.ts` | Exposes start/callback behavior and manages only the short-lived discovery binding cookie. |
| `backend/src/silpo/silpo-oauth.service.spec.ts` | Unit-tests state binding, one-use behavior, token non-persistence, sanitized catalog persistence, and failure paths. |
| `backend/src/silpo/silpo-oauth.controller.spec.ts` | Tests same-origin start and callback cookie clearing with synthetic responses. Create only if no controller test exists. |
| `frontend/src/App.tsx` | Renders the single discovery action and a post-callback evidence-pending state. |
| `frontend/src/App.test.tsx` | Covers browser/Telegram-neutral start and no false authenticated state. |
| `docs/superpowers/plans/2026-08-30-silpo-mcp-identity-discovery.md` | This canonical plan and its checkboxes. |

## Contracts

```ts
type DiscoveryStartResponse = { authorizationUrl: string };
type DiscoveryResult = 'complete' | 'failed';

type SanitizedMcpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};
```

- `POST /api/auth/silpo/discovery/start` returns `DiscoveryStartResponse` and sets an HttpOnly, `Secure`, `SameSite=Lax`, `Path=/` ten-minute `__Host-cartwise_discovery` binding cookie.
- `GET /api/auth/silpo/callback` accepts the existing OAuth `code` and `state`; when the consumed state has purpose `discovery`, it requires that cookie, calls only `tools/list`, clears the cookie, then redirects to `/?silpo_discovery=complete` or `/?silpo_discovery=failed`.
- `McpProbe.toolCatalog` is a JSON array of `SanitizedMcpTool`. It never contains tokens, tool-call results, user/profile data, headers, authorization codes, or raw callback data.

## Task 1: Add a browser-bound discovery state without changing user identity

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/<timestamp>_silpo_mcp_identity_discovery/migration.sql`
- Modify: `backend/src/silpo/silpo-oauth.service.spec.ts`

**Consumes:** Existing `OAuthState_exact_owner` constraint, AES-256-GCM verifier encryption, and `McpProbe` table.

**Produces:** A third valid `OAuthState` purpose, `discovery`, which has an encrypted verifier, exact redirect URI, ten-minute expiry, and SHA-256 hash of a browser binding but no owner or Telegram fields.

- [x] **Step 1: Write failing service tests for the new state shape.**

  Add synthetic tests that assert:

  ```ts
  it('creates a discovery state with a hash of the browser binding and no user identity', async () => {
    // response has an authorizationUrl; SQL values include only a hash, encrypted verifier,
    // redirect URI, discovery purpose, and binding hash.
  });

  it('rejects a discovery callback whose binding cookie does not match before exchanging the code', async () => {
    // fetch is never called
  });
  ```

  Do not put a real OAuth code, cookie, or token in the test fixture.

- [x] **Step 2: Run the focused tests and confirm they fail for the missing discovery contract.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-oauth.service.spec.ts
  ```

  Expected: failures mention the absent discovery creation/completion methods or state fields, not an unrelated test setup issue.

- [x] **Step 3: Add the minimal schema and migration.**

  Use explicit `purpose` values `telegram_first`, `reauthorize`, and `discovery`. Add nullable `browserBindingHash` to `OAuthState`. Replace the current two-branch check with these exact valid rows:

  ```sql
  ("purpose" = 'telegram_first'
    AND "telegramUserId" IS NOT NULL
    AND "ownerUserId" IS NULL
    AND "initiatingSessionHash" IS NULL
    AND "browserBindingHash" IS NULL)
  OR
  ("purpose" = 'reauthorize'
    AND "telegramUserId" IS NULL
    AND "ownerUserId" IS NOT NULL
    AND "initiatingSessionHash" IS NOT NULL
    AND "browserBindingHash" IS NULL)
  OR
  ("purpose" = 'discovery'
    AND "telegramUserId" IS NULL
    AND "ownerUserId" IS NULL
    AND "initiatingSessionHash" IS NULL
    AND "browserBindingHash" IS NOT NULL)
  ```

  Rename empty local `McpProbe.toolNames` to `toolCatalog`; keep `outcome`, `toolCount`, and `checkedAt`. Do not alter `User` or `SilpoConnection` in this task.

- [x] **Step 4: Implement state creation and exact binding validation.**

  Add a `createDiscoveryAuthorization(browserBinding: string): Promise<string>` method and a completion method that accepts `{ code, state, browserBinding }`. Generate both state and binding with `randomBytes(32).toString('base64url')`; store only SHA-256 hashes. Consume the state with `DELETE ... RETURNING` before exchanging the code. Reject missing, expired, replayed, wrong-purpose, wrong-binding, or redirect-mismatched rows before calling `exchangeCode`.

- [x] **Step 5: Verify focused tests and Prisma schema validation.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-oauth.service.spec.ts
  docker compose --env-file .env exec -T backend npm run prisma:validate
  ```

  Expected: focused tests pass and Prisma validates the changed schema.

## Task 2: Fetch and persist only the sanitized `tools/list` catalog

**Files:**
- Modify: `backend/src/silpo/silpo-oauth.service.ts`
- Modify: `backend/src/silpo/silpo-oauth.service.spec.ts`

**Consumes:** A valid consumed `discovery` state and token set returned by the official OAuth token endpoint.

**Produces:** One `McpProbe` row containing `outcome`, `toolCount`, and sanitized `toolCatalog`; no user, connection, session, or credential row.

- [x] **Step 1: Add failing tests for the exact MCP boundary.**

  Add synthetic tests that require:

  ```ts
  it('calls only MCP tools/list with the in-memory access token and stores a sanitized catalog', async () => {
    // mock JSON-RPC result.tools with a token-looking extra field;
    // assert persisted toolCatalog retains name/description/inputSchema and drops the extra field.
  });

  it('does not create a User, SilpoConnection, or Session during discovery', async () => {
    // assert SQL contains no INSERT into User/SilpoConnection and session mocks are unused.
  });
  ```

- [x] **Step 2: Run the focused tests and verify the missing catalog behavior fails.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-oauth.service.spec.ts
  ```

  Expected: failure is caused by the absent `tools/list` JSON-RPC call or missing sanitized persistence.

- [x] **Step 3: Implement the smallest MCP discovery call.**

  Send exactly one request to `https://mcp.silpo.ua/mcp`:

  ```ts
  {
    jsonrpc: '2.0',
    id: 'cartwise-discovery',
    method: 'tools/list',
    params: {},
  }
  ```

  Supply the decrypted access token only as the `Authorization: Bearer` request header. Parse only a successful `result.tools` array. Map every item to `{ name, description, inputSchema }`; reject a malformed catalog. Insert one `McpProbe` row with `outcome = 'tools_list_success'`. On token exchange, MCP transport, or schema failure, insert no probe with raw error details and surface a generic discovery failure.

- [x] **Step 4: Verify the service behavior and non-persistence invariants.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-oauth.service.spec.ts
  docker compose --env-file .env exec -T backend npm run typecheck
  ```

  Expected: all focused tests pass, including token non-persistence and no-user/no-connection assertions.

## Task 3: Expose the safe browser entry and result state

**Files:**
- Modify: `backend/src/silpo/silpo-oauth.controller.ts`
- Create: `backend/src/silpo/silpo-oauth.controller.spec.ts` if absent
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.test.tsx`

**Consumes:** `createDiscoveryAuthorization` and discovery completion from Tasks 1–2.

**Produces:** A single public browser/Telegram-neutral discovery action that never treats the result as an authenticated application session.

- [x] **Step 1: Write failing controller and UI tests.**

  Cover these synthetic behaviors:

  ```ts
  it('starts discovery only from the configured origin and sets an HttpOnly binding cookie', async () => {
    // valid Origin -> authorizationUrl and Set-Cookie; foreign/missing Origin -> reject
  });

  it('shows a Connect Silpo action outside Telegram and navigates only to the server returned URL', async () => {
    // mock { authorizationUrl: 'https://example.test/authorize' }
  });

  it('shows evidence pending after silpo_discovery=complete without claiming authentication', () => {
    // no session/profile/connected UI
  });
  ```

- [x] **Step 2: Run the focused controller and frontend tests and confirm they fail.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-oauth.controller.spec.ts
  docker compose --env-file .env exec -T frontend npm test -- App.test.tsx
  ```

  Expected: failures reflect the absent discovery endpoint/UI, not real network calls.

- [x] **Step 3: Implement controller, cookie, and UI.**

  Add `POST /api/auth/silpo/discovery/start`; require `Origin === APP_ORIGIN`, rate-limit it with the existing Redis service, generate the binding, and return `{ authorizationUrl }`. On discovery callback success or failure, always clear `__Host-cartwise_discovery` with the same cookie scope.

  Replace only the outside-Telegram instruction with a `Підключити Сільпо для перевірки` button. It posts same-origin to the new endpoint and follows only its returned URL. Read `silpo_discovery` from the query string and render `MCP-каталог отримано. Наступний крок — перевірка Silpo identity.` for `complete`; render a generic retry error for `failed`. Do not add local storage, a Telegram dependency, credentials UI, or an authenticated state.

- [x] **Step 4: Verify controller/UI tests and production build.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-oauth.controller.spec.ts silpo-oauth.service.spec.ts
  docker compose --env-file .env exec -T frontend npm test -- App.test.tsx
  docker compose --env-file .env exec -T frontend npm run build
  ```

  Expected: all named suites and frontend build exit 0.

## Task 4: Controlled live OAuth and evidence handoff

**Files:**
- Modify: `docs/superpowers/plans/2026-08-30-silpo-mcp-identity-discovery.md` (checkmarks and observed evidence only)

**Consumes:** Passing synthetic checks, a public tunnel, a non-empty `APP_ORIGIN`, and user-operated Silpo login.

**Produces:** A redacted report containing the fresh MCP catalog and a precise decision whether an official identity tool is discoverable. This task ends the IMPLEMENT session.

- [x] **Step 1: Confirm only required runtime configuration is present without printing its values.**

  Check presence only:

  ```bash
  awk -F= '/^(APP_ORIGIN|TOKEN_ENCRYPTION_KEY|CLOUDFLARE_TUNNEL_TOKEN)=/ { print $1 "=" ($2 == "" ? "[empty]" : "[set]") }' .env
  ```

  Expected: all three are `[set]`; `APP_ORIGIN` is the public `https://silpo.lysak.pp.ua` origin. Do not print any secret.

- [x] **Step 2: Start the public runtime through Make.**

  Run:

  ```bash
  make tunnel-up
  make ps
  ```

  Expected: frontend, backend, PostgreSQL, Redis, and cloudflared are running. Confirm Cloudflare connectivity in redacted `make tunnel-logs` output if necessary.

- [x] **Step 3: Ask the user to perform the interactive Silpo login.**

  The user opens `https://silpo.lysak.pp.ua`, selects `Підключити Сільпо для перевірки`, and completes Silpo OAuth in their own browser. Never request their password, OTP, cookies, callback URL, authorization code, or token.

- [x] **Step 4: Read only sanitized database evidence.**

  Run:

  ```bash
  docker compose --env-file .env exec -T postgres sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "SELECT outcome, \"toolCount\", jsonb_path_query_array(\"toolCatalog\", '\''$[*].name'\'') AS tool_names, \"checkedAt\" FROM \"McpProbe\" ORDER BY \"checkedAt\" DESC LIMIT 1; SELECT count(*) AS users FROM \"User\"; SELECT count(*) AS connections FROM \"SilpoConnection\";"'
  ```

  Expected: one `tools_list_success` record with tool names only; `users = 0` and `connections = 0`.

- [x] **Step 5: Stop at the identity decision gate.**

  Report the exact candidate tool names and their sanitized input schemas from `toolCatalog`. Do not call any candidate tool in this session. State one of:

  ```text
  Identity tool found: next PLAN must verify its output schema and select the stable subject field.
Identity tool not found: next PLAN must decide whether Silpo-only login is possible; do not invent an identity heuristic.
```

Observed evidence on 2026-08-30:
- Latest probe: `tools_list_success`, `toolCount = 39`; only the sanitized catalog is persisted.
- Candidate identity tools: `silpo_get_my_profile` and `silpo_get_loyalty_info`.
- Both candidate tools have `inputSchema = {"type":"object","properties":{}}`; no candidate tool was called.
- `OAuthClient = 1`, `OAuthState = 0`, `User = 0`, `SilpoConnection = 0`.

- [x] **Step 6: Run final non-live verification and report known unrelated failures separately.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-oauth.service.spec.ts silpo-oauth.controller.spec.ts
  docker compose --env-file .env exec -T backend npm run typecheck
  docker compose --env-file .env exec -T backend npm run prisma:validate
  docker compose --env-file .env exec -T frontend npm test -- App.test.tsx
  docker compose --env-file .env exec -T frontend npm run build
  docker compose --env-file .env --profile tunnel config --quiet
  git diff --check
  ```

  Report result counts and distinguish the known unrelated backend ESLint failure in `token-cipher.service.spec.ts:27` from this plan's evidence.

## Plan Self-Review

- Scope is deliberately limited to obtaining and sanitizing the MCP catalog. It does not claim a Silpo identity field before observing one.
- Every live call is OAuth, `tools/list`, or read-only SQL against local evidence; no MCP write is permitted.
- The callback discards bearer credentials and creates neither users nor connections, preventing an ownerless credential from surviving this discovery slice.
- The browser binding, single-use state, exact redirect URI, PKCE, and same-origin POST protect the new anonymous entry without adding a second login system.
- The follow-up Silpo-first authentication migration is intentionally excluded and requires a new approved plan based on Task 4 evidence.
