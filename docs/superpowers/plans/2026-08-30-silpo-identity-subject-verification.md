# Silpo MCP Identity Subject Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task in a fresh IMPLEMENT context. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use a fresh browser OAuth grant to call only the two documented Silpo identity candidates and persist a redacted field/type inventory that supports choosing a stable subject field.

**Architecture:** Add a separate browser-bound `identity_probe` OAuth purpose next to the completed catalog-only discovery flow. The callback exchanges the code in memory, calls `silpo_get_my_profile` and `silpo_get_loyalty_info` with empty arguments, reduces each response to field paths and JSON types, stores only that redacted evidence alongside the latest `McpProbe`, and discards all credentials and response values.

**Tech Stack:** NestJS 11, TypeScript 6, PostgreSQL 18/Prisma 7, React 19/Vite 8, Jest, Vitest, Docker Compose, official `https://mcp.silpo.ua/mcp`.

**Spec:** `docs/idea.md` §§2–3, `docs/superpowers/plans/2026-08-30-silpo-mcp-identity-discovery.md`, and the live `tools/list` evidence recorded there.

## Global Constraints

- This is an identity-evidence probe only. Do not create `User`, `SilpoConnection`, Redis session, local login, account migration, product endpoint, or MCP write action.
- The only allowed MCP methods are `tools/call` for `silpo_get_my_profile` and `silpo_get_loyalty_info`, in that order, with `{}` arguments.
- Use the official Silpo OAuth endpoint and Authorization Code + PKCE S256 with the existing `APP_ORIGIN` `https://silpo.lysak.pp.ua`.
- Use a distinct `identity_probe` OAuth state with a single-use ten-minute state and matching short-lived HttpOnly browser binding cookie.
- Access token, refresh token, authorization code, verifier, cookie value, headers, raw MCP responses, and personal values remain process-local and must never be logged, returned, snapshotted, or persisted.
- Persist only `toolName`, `outcome`, and bounded `{ path, type }` field inventory in `McpProbe.identityEvidence`.
- Do not classify `name`, `phone`, `email`, birthday, address, loyalty balance, or display text as a stable subject by heuristic.
- The user completes the interactive Silpo login. Do not request or handle password, OTP, callback URL, authorization code, cookies, or tokens.
- Preserve the completed catalog-only flow and the existing Telegram bootstrap/reauthorization flow.
- Do not run `rlx init`, create `plan.md`, use a git worktree, commit, push, merge, or delete anything.

## Verified Inputs

- Latest sanitized catalog: `tools_list_success`, 39 tools.
- Candidate tools: `silpo_get_my_profile` and `silpo_get_loyalty_info`.
- Both candidate input schemas are `{ "type": "object", "properties": {} }`.
- Current post-discovery state: `OAuthState = 0`, `User = 0`, `SilpoConnection = 0`.

## File Structure

| Path | Responsibility |
| --- | --- |
| `backend/prisma/schema.prisma` | Adds nullable redacted identity evidence to `McpProbe`. |
| `backend/prisma/migrations/20260830140000_silpo_identity_subject_probe/migration.sql` | Adds the `identityEvidence` JSONB column. |
| `backend/prisma/migrations/20260830141000_silpo_identity_probe_state/migration.sql` | Adds the `identity_probe` state invariant. |
| `backend/src/silpo/silpo-oauth.service.ts` | Creates/consumes `identity_probe` state, calls the two allowlisted tools, and sanitizes responses. |
| `backend/src/silpo/silpo-oauth.service.spec.ts` | Tests allowlisting, empty arguments, redaction, and non-persistence. |
| `backend/src/silpo/silpo-oauth.controller.ts` | Exposes identity-probe start/callback handling and cookie cleanup. |
| `backend/src/silpo/silpo-oauth.controller.spec.ts` | Tests same-origin start and callback binding behavior. |
| `frontend/src/App.tsx` | Starts the identity probe and displays redacted-evidence-pending state only. |
| `frontend/src/App.test.tsx` | Covers browser-neutral identity-probe entry and no authenticated state. |
| `docs/superpowers/plans/2026-08-30-silpo-identity-subject-verification.md` | Canonical plan and live evidence. |

## Contracts

```ts
type IdentityProbeTool = 'silpo_get_my_profile' | 'silpo_get_loyalty_info';

type IdentityField = { path: string; type: string };

type IdentityProbeEvidence = {
  toolName: IdentityProbeTool;
  outcome: 'success' | 'failed';
  fields: IdentityField[];
};
```

- `POST /api/auth/silpo/identity-probe/start` returns `{ authorizationUrl: string }` and sets `__Host-cartwise_identity_probe` for ten minutes with `HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/`.
- `GET /api/auth/silpo/callback` dispatches an `identity_probe` state only when its matching identity-probe cookie is present; it always clears that cookie and redirects to `/?silpo_identity_probe=complete` or `/?silpo_identity_probe=failed`.
- `McpProbe.identityEvidence` is a JSON array of `IdentityProbeEvidence`; it contains no response values, tokens, headers, error messages, or arbitrary server metadata.

## Task 1: Add bounded redacted identity evidence storage

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20260830140000_silpo_identity_subject_probe/migration.sql`
- Modify: `backend/src/silpo/silpo-oauth.service.spec.ts`

**Consumes:** Existing `McpProbe` catalog row and Prisma migration chain.

**Produces:** A nullable `McpProbe.identityEvidence` JSONB column and a tested redaction contract.

- [x] **Step 1: Write the failing redaction test.**

  Add a test with synthetic values that asserts the output contains only field paths and JSON types:

  ```ts
  it('redacts identity response values into bounded field evidence', () => {
    const evidence = redactIdentityPayload('silpo_get_my_profile', {
      id: 'silpo-user-1',
      name: 'Private Name',
      loyalty: { cardId: 'card-1' },
      items: [{ code: 'x' }],
    });

    expect(evidence).toEqual({
      toolName: 'silpo_get_my_profile',
      outcome: 'success',
      fields: expect.arrayContaining([
        { path: 'id', type: 'string' },
        { path: 'name', type: 'string' },
        { path: 'loyalty.cardId', type: 'string' },
        { path: 'items[]', type: 'array' },
      ]),
    });
    expect(JSON.stringify(evidence)).not.toContain('Private Name');
    expect(JSON.stringify(evidence)).not.toContain('silpo-user-1');
  });
  ```

  Bound the inventory to 128 paths and depth 4; represent arrays as `[]` and do not retain array items. A payload exceeding the bound must produce a generic failed outcome, never partial raw data.

- [x] **Step 2: Run the focused test and confirm the missing redaction contract fails.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-oauth.service.spec.ts
  ```

  Expected: the new test fails because the redaction helper/contract is absent; existing tests must remain attributable and unrelated setup failures must not be introduced.

- [x] **Step 3: Add the nullable schema column and migration.**

  Add `identityEvidence Json?` to `McpProbe`. Create a migration that only runs:

  ```sql
  ALTER TABLE "McpProbe" ADD COLUMN "identityEvidence" JSONB;
  ```

  Do not alter `User`, `SilpoConnection`, `OAuthClient`, or the completed catalog column.

- [x] **Step 4: Implement the smallest bounded redaction helper.**

  Export or keep test-accessible a helper with this exact behavior:

  ```ts
  redactIdentityPayload(toolName: IdentityProbeTool, payload: unknown): IdentityProbeEvidence
  ```

  Record paths and JSON types only. Reject non-object roots, scalar-only roots, depth overflow, and path overflow as `outcome: 'failed', fields: []`; never include an error string or original value.

- [x] **Step 5: Verify the redaction test and Prisma validation.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-oauth.service.spec.ts
  docker compose --env-file .env exec -T backend npm run prisma:validate
  ```

  Expected: focused service tests pass and the schema validates.

## Task 2: Probe only the two documented identity candidates

**Files:**
- Modify: `backend/src/silpo/silpo-oauth.service.ts`
- Modify: `backend/src/silpo/silpo-oauth.service.spec.ts`
- Create: `backend/prisma/migrations/20260830141000_silpo_identity_probe_state/migration.sql`

**Consumes:** `IdentityProbeEvidence`, existing PKCE/token exchange, and the current `McpProbe` catalog row.

**Produces:** `createIdentityProbeAuthorization(browserBinding)` and `completeIdentityProbeAuthorization({ code, state, browserBinding })`.

- [x] **Step 1: Write failing tests for exact candidate calls and token non-persistence.**

  Add tests that mock only token exchange and two MCP responses, then assert:

  ```ts
  expect(fetch).toHaveBeenNthCalledWith(2, 'https://mcp.silpo.ua/mcp', expect.objectContaining({
    body: expect.stringContaining('silpo_get_my_profile'),
    headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
  }));
  expect(fetch).toHaveBeenNthCalledWith(3, 'https://mcp.silpo.ua/mcp', expect.objectContaining({
    body: expect.stringContaining('silpo_get_loyalty_info'),
  }));
  ```

  Assert both requests use `method: 'tools/call'`, `params.arguments = {}`, no other MCP method is called, `identityEvidence` contains no raw values, and there is no `INSERT` into `User`/`SilpoConnection` plus no session call.

- [x] **Step 2: Run the focused service tests and confirm the missing probe behavior fails.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-oauth.service.spec.ts
  ```

  Expected: failures identify the absent identity-probe methods or missing allowlisted calls, not a malformed fixture.

- [x] **Step 3: Add the explicit `identity_probe` OAuth state.**

  Extend the state purpose/check constraint with:

  ```sql
  ("purpose" = 'identity_probe'
    AND "telegramUserId" IS NULL
    AND "ownerUserId" IS NULL
    AND "initiatingSessionHash" IS NULL
    AND "browserBindingHash" IS NOT NULL)
  ```

  Store only the SHA-256 state hash, encrypted verifier, exact redirect URI, purpose, and browser-binding hash. Consume with `DELETE ... RETURNING` before token exchange; reject missing, expired, replayed, wrong-purpose, wrong-binding, and redirect-mismatched state before any MCP call.

- [x] **Step 4: Implement the fixed two-call MCP probe.**

  Exchange the code in memory, then call exactly these JSON-RPC payloads sequentially:

  ```ts
  { jsonrpc: '2.0', id: 'cartwise-identity-profile', method: 'tools/call', params: {
    name: 'silpo_get_my_profile', arguments: {}
  }}
  { jsonrpc: '2.0', id: 'cartwise-identity-loyalty', method: 'tools/call', params: {
    name: 'silpo_get_loyalty_info', arguments: {}
  }}
  ```

  Accept only valid JSON-RPC results. Extract the candidate payload from `result.structuredContent` when it is an object; otherwise accept exactly one `result.content` text block only when that text parses to an object. Pass the extracted object directly to the redactor, and update the latest successful `McpProbe.identityEvidence` with the two sanitized entries. On exchange, transport, malformed-result, or bound-redaction failure, write only generic failed evidence if the row can be updated and surface a generic discovery failure; never store raw error details.

- [x] **Step 5: Verify service behavior and no-identity invariants.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-oauth.service.spec.ts
  docker compose --env-file .env exec -T backend npm run typecheck
  ```

  Expected: focused tests pass, including exact allowlisting, empty arguments, redaction, and zero identity/session writes.

## Task 3: Expose the identity-probe browser entry

**Files:**
- Modify: `backend/src/silpo/silpo-oauth.controller.ts`
- Modify: `backend/src/silpo/silpo-oauth.controller.spec.ts`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.test.tsx`

**Consumes:** Identity-probe service methods and the existing public-origin runtime.

**Produces:** One browser/Telegram-neutral button that starts the new probe without claiming authentication.

- [x] **Step 1: Write failing controller/UI tests.**

  Cover:

  ```ts
  it('requires the configured Origin and sets the identity-probe binding cookie', async () => {
    // valid Origin -> URL plus __Host-cartwise_identity_probe;
    // foreign or missing Origin -> reject before service call
  });

  it('shows identity evidence pending without rendering authenticated state', () => {
    // silpo_identity_probe=complete -> redacted evidence message;
    // no User/profile/connected/logout UI
  });
  ```

  Assert callback success/failure always clears the identity-probe cookie and redirects only to the configured origin.

- [x] **Step 2: Run focused controller/frontend tests and confirm they fail.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-oauth.controller.spec.ts
  docker compose --env-file .env exec -T frontend npm test -- App.test.tsx
  ```

  Expected: failures reflect the absent identity-probe route/state UI and no real network calls.

- [x] **Step 3: Implement controller and UI with no credential state.**

  Add `POST /api/auth/silpo/identity-probe/start`; require exact `Origin === APP_ORIGIN`, apply the existing Redis rate limit, generate the binding with `randomBytes(32).toString('base64url')`, and return only the service URL. Use the dedicated HttpOnly cookie and clear it on every identity-probe callback outcome.

  Replace the completed-catalog instruction with `Перевірити Silpo identity`. On `silpo_identity_probe=complete`, render `Identity evidence отримано. Наступний крок — вибір stable subject field.`; on `failed`, render generic retry text. Do not add localStorage, credentials UI, profile display, or authenticated state.

- [x] **Step 4: Verify controller/UI tests and build.**

  Run:

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-oauth.controller.spec.ts silpo-oauth.service.spec.ts
  docker compose --env-file .env exec -T frontend npm test -- App.test.tsx
  docker compose --env-file .env exec -T frontend npm run build
  ```

  Expected: all named suites and the frontend build exit 0.

## Task 4: Controlled live evidence and subject decision gate

**Files:**
- Modify: `docs/superpowers/plans/2026-08-30-silpo-identity-subject-verification.md` (checkboxes and redacted evidence only)

**Consumes:** Passing synthetic checks, public tunnel, and user-operated Silpo login.

**Produces:** Redacted field/type evidence and a recommendation for the next durable-authentication PLAN.

- [x] **Step 1: Check required configuration presence without printing values.**

  Run:

  ```bash
  awk -F= '/^(APP_ORIGIN|TOKEN_ENCRYPTION_KEY|CLOUDFLARE_TUNNEL_TOKEN)=/ { print $1 "=" ($2 == "" ? "[empty]" : "[set]") }' .env
  ```

  Expected: all are `[set]`; do not print secrets.

- [x] **Step 2: Start and verify the public runtime.**

  Run:

  ```bash
  make tunnel-up
  make ps
  ```

  Confirm backend health before asking for login. Do not treat Cloudflare connectivity alone as backend health.

- [x] **Step 3: Ask the user to complete the fresh identity-probe OAuth.**

  The user opens `https://silpo.lysak.pp.ua`, selects `Перевірити Silpo identity`, and completes Silpo login in their own browser. The agent must not request or handle any secret or callback material.

- [x] **Step 4: Read only redacted evidence and counts.**

  Query only `McpProbe.outcome`, `McpProbe.identityEvidence`, and counts of `OAuthState`, `User`, and `SilpoConnection`. Do not select access-token, refresh-token, cookie, authorization-code, or raw response columns.

- [x] **Step 5: Stop without calling any further MCP tool.**

  Report each candidate's exact field paths and JSON types. Choose a stable subject only if the evidence explicitly exposes a documented unique identifier; never choose name, phone, email, loyalty balance, or a display field by heuristic.

  Use one exact outcome:

  ```text
  Stable subject candidate found: next PLAN must approve the exact field path and then implement User/SilpoConnection/token persistence.
  ```

  or:

  ```text
  Stable subject not proven: next PLAN must decide whether Silpo-only login is possible; do not invent an identity heuristic.
  ```

- [x] **Step 6: Run final verification and report unrelated failures separately.**

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

  Report exact pass/fail counts and keep the checkout unchanged beyond this plan's agreed files. End the IMPLEMENT session at the identity decision gate.

## Execution checkpoint (2026-08-30)

- Configuration presence check passed for `APP_ORIGIN`, `TOKEN_ENCRYPTION_KEY`, and `CLOUDFLARE_TUNNEL_TOKEN`; values were not printed.
- Local and public backend health passed after `make tunnel-up`; public `/api/health` returned `200`.
- Redacted DB-only check returned the latest `tools_list_success` probe with no identity evidence yet and counts `OAuthState=0`, `User=0`, `SilpoConnection=0`.
- The in-app browser backend was unavailable at the initial attempt (`browsers.list() = []`); the user subsequently completed the fresh OAuth in their own browser. No further MCP tool was called.
- User completed the fresh identity-probe OAuth in their browser. The latest successful probe contains only redacted evidence:
  - `silpo_get_my_profile`: `success:boolean`, `profile:object`, `profile.id:string`, `profile.firstName:string`, `profile.lastName:string`, `profile.middleName:string`, `profile.phone:string`, `profile.email:string`, `profile.birthday:string`, `profile.gender:string`, `profile.status:string`.
  - `silpo_get_loyalty_info`: `success:boolean`, `loyalty:object`, `loyalty.card:object`, `loyalty.card.barcode:string`, `loyalty.card.typeName:string`, `loyalty.card.memberId:number`, `loyalty.balance:object`, `loyalty.balance.total:number`, `loyalty.balance.currency:string`, `loyalty.balance.accounts[]:array`.
  - Explicit identifier-shaped candidates are `profile.id` and `loyalty.card.memberId`; neither is approved or persisted by this IMPLEMENT session.
  - Stable subject candidate found: next PLAN must approve the exact field path and then implement User/SilpoConnection/token persistence.

## Self-Review

- The plan does not persist access/refresh tokens or raw Silpo responses; it stores only field paths/types.
- The allowlist is explicit and finite: two no-argument read-only tools, called sequentially.
- It preserves the completed catalog-only flow and existing Telegram-owned flow.
- It does not create a local identity until a later approved PLAN selects and verifies a stable subject field.
