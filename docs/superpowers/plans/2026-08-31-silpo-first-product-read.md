# Silpo First Read-Only Product Operation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the first authenticated, read-only Silpo MCP product call from the durable connection — `silpo_list_branches` — and expose it as one sanitized backend endpoint. This proves the stored encrypted access token, the on-demand refresh boundary, and the MCP `tools/call` path end to end, and unblocks the `branchId`/`deliveryType`/`timeslot` context that every other product tool requires. (The UI branch list is descoped to the branch-selection plan — see Task 3.)

**Architecture:** Extract the existing identity-probe MCP `tools/call` + result-unwrap logic into one shared private helper `callSilpoTool(accessToken, name, args, id)` in `silpo-oauth.service.ts`, reused unchanged by the identity probe. Add `SilpoProductService.listBranches(userId, query)` that runs through `SilpoConnectionService.withReadAccess` (decrypt → optional proactive refresh → 401-retry with forced refresh). Add `GET /api/silpo/branches` behind `SessionGuard`, returning only non-personal branch fields. No new persistence, no Redis cache, no provider interface, no MCP write.

**Tech Stack:** NestJS 11, TypeScript 6, PostgreSQL 18 with Prisma 7, Redis 8, React 19/Vite 8, Jest, Vitest, Docker Compose, AES-256-GCM, official `https://mcp.silpo.ua/mcp`.

**Spec:** `docs/idea.md` §§4.2 (branch selection), 7 (MCP abstraction — deferred), 12 must-have #7; `docs/superpowers/plans/2026-08-30-silpo-first-durable-identity.md` (completed durable identity + verified refresh/logout boundaries); stored sanitized catalog in `McpProbe.toolCatalog` (`silpo_list_branches`: no required inputs; optional `hasNP`, `hasPickup` booleans, `limit` 1–500 default 50, `offset` ≥ 0).

## Global Constraints

- The only new MCP action is `tools/call` for `silpo_list_branches`. Do not call `silpo_get_products`, `silpo_find_products_batch`, `silpo_get_product_details`, cart, loyalty, coupons, or any write tool in this plan.
- Read-only: no `branches`/`products` table, no `price_*` tables, no Redis cache layer, no scheduler. Return the live sanitized response only.
- Reuse `SilpoConnectionService.withReadAccess`, `TokenCipherService`, `SessionGuard`, the existing per-user Redis rate-limit counter, and existing exact-origin/session-cookie settings. Do not add Passport, JWT, a `CommerceProvider` interface, queues, new services beyond `SilpoProductService`, or dependencies.
- Never log, persist, or return the access token, refresh token, raw MCP response, JSON-RPC envelope, or any Silpo personal data. Branch data (name, address, city, coordinates, pickup flags) is public store metadata and may be returned.
- `GET /api/silpo/branches` requires a valid opaque session; a Silpo-only session (no Telegram binding) is sufficient. On missing/`reauth_required` connection, return the existing `503` / reauth semantics from `withReadAccess`; do not leak details.
- Existing Telegram-first, catalog-discovery, identity-probe, and durable-connect flows must keep their current contracts and tests. No heuristic account merge, no Telegram linking.
- This is the current checkout on `main`; preserve unrelated dirty files. Do not create a worktree, commit, push, merge, delete, or run `rlx init`.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `backend/src/silpo/silpo-oauth.service.ts` | Extracts `callSilpoTool(accessToken, name, args, id)` from the identity-probe path; identity probe now calls it. |
| `backend/src/silpo/silpo-oauth.service.spec.ts` | Adds direct tests for the extracted helper (structuredContent path, single text-content JSON path, `isError`/rpc-error, non-2xx, malformed). |
| `backend/src/silpo/silpo-product.service.ts` | New: `listBranches(userId, query)` via `withReadAccess`, argument clamping, response sanitization. |
| `backend/src/silpo/silpo-product.service.spec.ts` | New: sanitization, arg clamping, 401→forced-refresh retry (delegated to `withReadAccess`), no-leak assertions. |
| `backend/src/silpo/silpo-product.controller.ts` | New: `GET /api/silpo/branches` with `SessionGuard`, per-user rate-limit, query parsing. |
| `backend/src/silpo/silpo-product.controller.spec.ts` | New: guard rejection without session, rate-limit boundary, sanitized shape, no token/personal fields in body. |
| `backend/src/silpo/silpo-product.live.spec.ts` | New: opt-in live e2e (`SILPO_E2E_SESSION`), skipped by default; asserts the deployed endpoint returns the Вінниця / вул. Зодчих, 2 branch (`externalId 2086`). |
| `backend/src/silpo/silpo.module.ts` | Registers `SilpoProductService` and `SilpoProductController`. |
| `docs/superpowers/specs/2026-08-12-phase-1-production-decisions.md` | Records that authenticated MCP reads go through `withReadAccess` + `callSilpoTool`, and that branch metadata is treated as non-personal. |
| ~~`frontend/src/App.tsx` / `App.test.tsx`~~ | Descoped — see Task 3. |

## Contracts

```ts
// Field names confirmed against live silpo_list_branches on 2026-08-31 (see Task 4 evidence):
//   payload = { success, summary, branches: BranchRecord[], meta: { limit, offset, total } }
//   BranchRecord = { branchId, companyId, externalId, city, address, latitude, longitude, hasPickup, open }
//   there is NO branch name; latitude/longitude arrive as strings.
type BranchSummary = {
  silpoBranchId: string;          // branchId (uuid)
  externalId: string | null;      // numeric store code, e.g. "1998"
  city: string | null;
  address: string | null;
  latitude: number | null;        // parsed from the provider's string
  longitude: number | null;
  hasPickup: boolean | null;
};

type ListBranchesResponse = {
  branches: BranchSummary[];
  nextOffset: number | null;
};

callSilpoTool(accessToken: string, name: string, args: Record<string, unknown>, id: string): Promise<Record<string, unknown>>;
```

- `GET /api/silpo/branches?limit=&offset=&hasPickup=` — `limit` clamped to `1..500` (the MCP tool's own max; default `25`), `offset` clamped to `>= 0` (default `0`), `hasPickup` accepted only as literal `true`. Returns `ListBranchesResponse`; `nextOffset` is `offset + payload.branches.length` when `< meta.total`, else `null`. `limit=500` returns all 455 branches in one call, avoiding a 10-round-trip walk through the per-user rate limiter.
- The endpoint never returns `silpoExternalId`, tokens, loyalty, profile, `companyId`, or the raw MCP envelope.
- A record without a `branchId` is dropped; missing fields map to `null`, never to an invented value. If `payload.branches` is not an array, return `502` with a generic message.

## Task 1: Extract a shared authenticated MCP tool-call helper

**Files:**
- Modify: `backend/src/silpo/silpo-oauth.service.ts`
- Modify: `backend/src/silpo/silpo-oauth.service.spec.ts`

**Consumes:** The current `fetchMcpResult` body (JSON-RPC `tools/call`, `result.structuredContent` preferred, else exactly one `result.content` text block parsed as JSON, `isError`/rpc-error rejection, non-2xx rejection).

**Produces:** `private async callSilpoTool(accessToken, name, args, id): Promise<Record<string, unknown>>` used by the identity probe and available to `SilpoProductService` via a thin public pass-through or a small injectable — choose the smallest wiring that keeps `SilpoOauthService` the only place that talks to `https://mcp.silpo.ua/mcp`.

- [x] **Step 1: Write failing tests for the extracted helper.**

  Add tests that call the helper directly (or through a minimal public method) with a mocked `fetch` and assert: (a) `structuredContent` object is returned as-is; (b) a single `content: [{ type: 'text', text: '<json>' }]` block is parsed and returned; (c) `result.isError === true` throws a generic error; (d) non-string/multi-block/invalid-JSON content throws; (e) non-2xx throws; (f) the request body has `method === 'tools/call'`, `params.name === name`, `params.arguments === args`, and header `Authorization: Bearer <accessToken>`.

- [x] **Step 2: Run the focused service test and confirm the helper is absent.**

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-oauth.service.spec.ts
  ```

  Expected: new helper tests fail on the missing method; existing identity-probe tests still pass.

- [x] **Step 3: Extract without behavior change.**

  Move the body of `fetchMcpResult` into `callSilpoTool(accessToken, name, args, id)`, generalizing the hard-coded `arguments: {}` to `args` and the `IdentityProbeTool` type to `string`. Re-implement `fetchMcpResult` (or its callers) to call `callSilpoTool(accessToken, name, {}, id)`. Keep all error strings generic and unchanged in spirit.

- [x] **Step 4: Verify no regression.**

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-oauth.service.spec.ts silpo-oauth.controller.spec.ts
  docker compose --env-file .env exec -T backend npm run typecheck
  ```

  Expected: all identity-probe, discovery, and connect tests pass unchanged; new helper tests pass.

## Task 2: Add `SilpoProductService.listBranches` and the sanitized endpoint

**Files:**
- Create: `backend/src/silpo/silpo-product.service.ts`
- Create: `backend/src/silpo/silpo-product.service.spec.ts`
- Create: `backend/src/silpo/silpo-product.controller.ts`
- Create: `backend/src/silpo/silpo-product.controller.spec.ts`
- Modify: `backend/src/silpo/silpo.module.ts`
- Modify: `docs/superpowers/specs/2026-08-12-phase-1-production-decisions.md`

**Consumes:** `callSilpoTool` (Task 1), `SilpoConnectionService.withReadAccess`, `SessionGuard`, the existing per-user Redis rate-limit helper used by discovery/connect.

**Produces:** `GET /api/silpo/branches` returning `ListBranchesResponse`.

- [x] **Step 1: Write failing service tests.**

  Mock `withReadAccess` to invoke its callback with a fake token and mock `callSilpoTool` to return a representative branch payload (both `structuredContent` and text-block shapes). Assert: (a) output contains only `BranchSummary` fields, mapped from the payload, with missing fields `null`; (b) `limit`/`offset` are clamped and forwarded as `params.arguments`; (c) `hasPickup` forwarded only when literally `true`; (d) a non-object / non-array payload throws a `502`-mapped error; (e) no token, no raw envelope, and no non-branch key appears in the result; (f) when the provider signals more results, `nextOffset === offset + branches.length`, else `null`.

- [x] **Step 2: Write failing controller tests.**

  Assert: (a) request without a valid session cookie is rejected by `SessionGuard` (`401`); (b) exceeding the per-user rate-limit window returns `429`; (c) a valid request returns the sanitized shape; (d) the response body, serialized, contains no `accessToken`, `refreshToken`, `silpoExternalId`, `profile`, `loyalty`, or `jsonrpc` substring; (e) `reauth_required` connection surfaces the existing reauth status, not a stack/detail.

- [x] **Step 3: Run focused tests and confirm route/service absent.**

  ```bash
  docker compose --env-file .env exec -T backend npm test -- silpo-product.service.spec.ts silpo-product.controller.spec.ts
  ```

  Expected: failures identify the missing service/controller only.

- [x] **Step 4: Implement the service.**

  `listBranches(userId, { limit, offset, hasPickup })`:
  - Clamp `limit` to `1..50` (default `25`), `offset` to `>= 0` (default `0`); build `args = { limit, offset, ...(hasPickup === true ? { hasPickup: true } : {}) }`.
  - `return this.connections.withReadAccess(userId, (token) => this.oauth.callSilpoTool(token, 'silpo_list_branches', args, 'cartwise-branches'))` then map.
  - Mapping: accept the first array found among `payload.items` / `payload.branches` / `payload.data` / `payload` itself; for each record read `branchId`/`id` → `silpoBranchId` (required non-empty string, else skip the record), plus `name`, `address`, `city`, `latitude`, `longitude`, `hasPickup` with `null` fallback. If no usable array, throw `BadGatewayException('Silpo branches unavailable')`.
  - `nextOffset`: `offset + branches.length` when the raw array length equals the requested `limit` (heuristic for "more may exist"), else `null`. `// ponytail: length-equals-limit heuristic; switch to a real total/hasMore field once the live payload is known`.

- [x] **Step 5: Implement the controller and module wiring.**

  `GET /api/silpo/branches` with `@UseGuards(SessionGuard)`. Resolve `userId` from the session the same way `auth.controller.ts` does. Apply the same per-user rate-limit call used by discovery/connect (`requireRateLimit` pattern). Parse query params defensively (`Number.parseInt`, `NaN` → default; `hasPickup` compared to `'true'`). Register `SilpoProductService` + `SilpoProductController` in `silpo.module.ts`.

- [x] **Step 6: Update the decision record.**

  Add one paragraph: authenticated Silpo MCP reads go through `SilpoConnectionService.withReadAccess` + `SilpoOauthService.callSilpoTool`; `SilpoOauthService` remains the only module that contacts `https://mcp.silpo.ua`; branch metadata is non-personal and may be returned; a `CommerceProvider` interface and MCP response caching are explicitly deferred until a second consumer exists.

- [x] **Step 7: Verify backend.**

  ```bash
  docker compose --env-file .env exec -T backend npm test
  docker compose --env-file .env exec -T backend npm run typecheck
  docker compose --env-file .env exec -T backend npm run prisma:validate
  ```

  Expected: full backend suite passes (126: previous 113 plus 13 new product specs); no test prints a credential; Prisma unchanged.

## Task 3: (descoped) Minimal branch list in the UI

**Descoped 2026-08-31 — moved to the branch-selection plan.** A bare `<ul>` of branch names adds no
user capability yet (no selection, no persistence, no filter) and an unconditional `/api/silpo/branches`
fetch on the authenticated state collides with six existing `App.test.tsx` fetch-count assertions
(`toHaveBeenCalledTimes(1|2)`), forcing edits to unrelated tests for zero product value. The read path is
proven by Task 2's specs plus Task 4's live endpoint check. The UI list will land with branch selection,
where it has a real consumer (chosen `branchId` feeding `silpo_get_products` / price tracking).

## Task 4: Controlled live verification

**Files:**
- Modify: `docs/superpowers/plans/2026-08-31-silpo-first-product-read.md` (checkboxes and redacted evidence only)

- [x] **Step 1: Confirm runtime and connection precondition (redacted).**

  2026-08-31: `https://silpo.lysak.pp.ua/api/health` → `200`; one `SilpoConnection` with `status = active`.

- [x] **Step 2: Exercise the endpoint as the logged-in user.**

  2026-08-31, `GET /api/silpo/branches` with the user's session cookie (run in the user's own shell; a
  short-lived `?debug=shape` gate was added to learn the live field names, then removed — no probe code
  remains). Redacted evidence:
  - `?limit=3&offset=0` → HTTP `200`, `branches.length = 3`, `nextOffset = 3`; each item has a non-empty
    `silpoBranchId` (uuid) and the sanitized shape `{ silpoBranchId, externalId, city, address, latitude,
    longitude, hasPickup }` with `latitude`/`longitude` parsed to numbers and no `companyId`/token/envelope.
  - `?limit=2&offset=453` → HTTP `200`, `branches.length = 2`, `nextOffset = null` (provider `meta.total = 455`).
  - Live payload shape recorded in the Contracts block; mapping and specs updated to the real fields
    (there is no branch `name`; coordinates arrive as strings).

- [x] **Step 3: Confirm the refresh boundary was exercised or is ready.**

  During Step 2 the stored access token was still valid (`accessTokenExpiresAt > NOW()`, `updatedAt`
  unchanged) so `withReadAccess` did not refresh. The forced-refresh-on-401 path stays covered by the
  connection-service unit tests and will trigger naturally at token expiry.

- [x] **Step 4: Final verification without commit/delete.**

  ```bash
  docker compose --env-file .env exec -T backend npm test
  docker compose --env-file .env exec -T backend npm run typecheck
  docker compose --env-file .env exec -T backend npm run prisma:validate
  docker compose --env-file .env exec -T frontend npm test
  docker compose --env-file .env exec -T frontend npm run build
  docker compose --env-file .env --profile tunnel config --quiet
  git diff --check
  ```

  Report exact pass/fail counts, preserve unrelated dirty files, do not commit. Stop for a later plan covering the cart-context chain (`silpo_get_my_shopping_cart_by_id` → `branchId`/`deliveryType`/`timeslot`) and product search + Product Score.

  Evidence (2026-08-31): backend `Test Suites: 13 passed`, `Tests: 126 passed`; `typecheck` 0 errors;
  `prisma:validate` valid; frontend `Test Files 1 passed`, `Tests 21 passed`; frontend build OK;
  `compose config` valid (3 unset-optional-var warnings); `git diff --check` clean; no commit/delete/push.

**Plan status: complete** (Task 3 descoped). `silpo_list_branches` read path verified end to end against
the live MCP through the durable encrypted connection.

Follow-up (2026-08-31): `limit` clamp raised `50 → 500` (the MCP tool's declared max) so the whole 455-branch
list comes back in one request. Added `silpo-product.live.spec.ts` — an opt-in e2e (`SILPO_E2E_SESSION=<cookie>`,
`describe.skip` otherwise) asserting the deployed endpoint grants access to the Вінниця / вул. Зодчих, 2
store (`externalId 2086`, `silpoBranchId 1edb6b53-596c-6d06-b5f0-b5ff7ea46636`, `hasPickup true`). Passing;
`npm test` stays 126 passed / 1 skipped offline.

## Self-Review

- Only `silpo_list_branches` is called; no product-detail, cart, loyalty, or write tool is touched.
- No new tables, no Redis cache, no provider interface, no UI — the change is one helper extraction, one service, one endpoint.
- The authenticated read reuses the already-verified decrypt + refresh + 401-retry path rather than adding a second token codepath.
- Sanitization is allowlist-based (`BranchSummary` only); tests assert the serialized body carries no credential or personal substring.
- Deferred items (`CommerceProvider`, MCP response cache, pagination UI, branch persistence, live token rotation) are named with `ponytail:` markers and carried to the next plan, not silently dropped.
