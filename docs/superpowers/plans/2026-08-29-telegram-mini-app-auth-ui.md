# Telegram Mini App Auth UI Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in a fresh IMPLEMENT context. Steps use checkbox (`- [ ]`) syntax for tracking. The canonical plan is this file; do not create a second `plan.md`.

**Goal:** Make the existing Telegram identity and Silpo OAuth backend usable from the React Telegram Mini App without adding browser login or product-domain features.

**Architecture:** `App` obtains raw `Telegram.WebApp.initData` only in the Telegram WebView and sends it as a text body to the existing bootstrap route. The backend remains the sole authority for Telegram validation, OAuth state, session cookies, CSRF, and Silpo status. The UI holds only the returned CSRF token in memory, follows an OAuth URL only when the backend explicitly requests it, and never persists or displays credentials.

**Tech Stack:** React 19, TypeScript, Vite 8, Vitest, existing NestJS `/api/auth/*` contract. No new package.

**Spec:** `docs/superpowers/specs/2026-08-12-user-identity-and-silpo-connection-design.md`

## Global Constraints

- Telegram Mini App is the only entry point in this slice. Do not add a browser-login fallback, Passport, JWT, or any new identity method.
- Silpo OAuth remains mandatory: a verified Telegram user without a local owned Silpo connection receives the backend-provided authorization URL.
- Send the raw `initData` only as the `text/plain` bootstrap request body. Do not put it in a URL, local storage, logs, errors, test snapshots, or React state.
- React must never receive or persist Silpo tokens, refresh tokens, OAuth client secrets, session IDs, bot tokens, or `TOKEN_ENCRYPTION_KEY`.
- Requests are same-origin and use `credentials: 'same-origin'`. Unsafe requests send `x-csrf-token` only from in-memory authenticated state.
- Preserve the production backend contract: `POST /api/auth/telegram/bootstrap`, `GET /api/auth/session`, `POST /api/auth/logout`, and `POST /api/auth/silpo/reauthorize`.
- No catalogue, branch selection, Product Score, tracking, notifications, discount logic, MCP tool calls, or backend schema changes belong in this plan.
- Do not run `rlx init` and do not create a repository `plan.md`. The separate Ralphex tooling change is out of scope.
- Never run `git commit`; report a suggested commit message only if requested.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `frontend/src/App.tsx` | Minimal Telegram-only authentication state machine and controls. |
| `frontend/src/App.test.tsx` | UI contract tests with synthetic Telegram `initData` and mocked same-origin responses. |
| `backend/src/security/token-cipher.service.spec.ts` | Existing test lint correction only; no behavior change. |
| `docs/superpowers/plans/2026-08-29-telegram-mini-app-auth-ui.md` | This canonical plan and progress record. |

## HTTP Contract Used by the UI

```ts
type Authenticated = {
  status: 'authenticated';
  csrfToken: string;
  silpoStatus: 'active' | 'reauth_required' | 'missing';
};

type OAuthRequired = {
  status: 'oauth_required';
  authorizationUrl: string;
};
```

- Bootstrap sends `Telegram.WebApp.initData` to `POST /api/auth/telegram/bootstrap` with `content-type: text/plain`.
- `OAuthRequired` navigates the current WebView to `authorizationUrl`.
- `Authenticated` renders the signed-in state. `reauth_required` and `missing` render a reconnect action; `active` does not.
- Reconnect posts to `/api/auth/silpo/reauthorize` with the in-memory CSRF token and follows its `authorizationUrl`.
- Logout posts to `/api/auth/logout` with the in-memory CSRF token, then returns to the Telegram-only entry state.

## Task 1: Restore the frontend quality gate

**Files:**
- Modify: `backend/src/security/token-cipher.service.spec.ts:27`

**Consumes:** Existing token-cipher test behavior.

**Produces:** A backend lint run that is not blocked by the known `no-unexpected-multiline` formatting error.

- [x] **Step 1: Inspect the reported expression without changing its value or assertions.**

  Run:

  ```bash
  docker compose run --rm backend npm run lint
  ```

  Expected: the only reported error is `no-unexpected-multiline` at `src/security/token-cipher.service.spec.ts:27`.

- [x] **Step 2: Put the matcher invocation on one unambiguous expression line.**

  Keep the existing assertion operands and expected value unchanged. The resulting form must be structurally equivalent to:

  ```ts
  expect(cipher.decrypt(cipher.encrypt('value'))).toBe('value');
  ```

- [x] **Step 3: Verify the focused cipher test and backend lint.**

  Run:

  ```bash
  docker compose run --rm backend npm test -- token-cipher.service.spec.ts
  docker compose run --rm backend npm run lint
  ```

  Expected: cipher tests pass and ESLint exits 0.

## Task 2: Test the Telegram entry and OAuth handoff

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.test.tsx`

**Consumes:** The bootstrap HTTP union above and the global `Telegram.WebApp.initData` supplied by the Telegram WebView.

**Produces:** A safe initial UI that either starts backend-controlled OAuth or explains that the app must be opened from Telegram.

- [x] **Step 1: Replace the obsolete authorization-link test with failing entry-flow tests.**

  Add synthetic-only test setup for the minimal WebApp shape:

  ```ts
  type TelegramWindow = Window & {
    Telegram?: { WebApp?: { initData?: string } };
  };
  ```

  Cover these behaviors:

  ```ts
  it('does not call the API outside Telegram', () => {
    // no Telegram initData; renders the Telegram-only instruction
  });

  it('posts initData as text and follows only the OAuth URL returned by bootstrap', async () => {
    // mock fetch -> { status: 'oauth_required', authorizationUrl: 'https://example.test/oauth' }
    // assert POST URL, text/plain body, same-origin credentials, then navigation
  });
  ```

- [x] **Step 2: Run the frontend test to prove the obsolete link cannot satisfy the new contract.**

  Run:

  ```bash
  docker compose run --rm frontend npm test -- App.test.tsx
  ```

  Expected: FAIL because `App` still links to `/api/auth/silpo/start` and has no Telegram bootstrap behavior.

- [x] **Step 3: Implement the smallest Telegram entry state.**

  In `App.tsx`, read `window.Telegram?.WebApp?.initData` only at bootstrap time. If it is absent, render a non-actionable instruction to open Cartwise from Telegram and do not call an API. If present, issue exactly:

  ```ts
  await fetch('/api/auth/telegram/bootstrap', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'text/plain' },
    body: initData,
  });
  ```

  Parse only the HTTP union above. On `oauth_required`, use the supplied URL for top-level navigation. On an unexpected response or non-OK status, render a generic retry message; never render the raw response or init data.

- [x] **Step 4: Verify the entry-flow tests pass.**

  Run:

  ```bash
  docker compose run --rm frontend npm test -- App.test.tsx
  ```

  Expected: synthetic no-Telegram and OAuth-handoff tests pass.

## Task 3: Add authenticated, reconnect, and logout states

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/App.test.tsx`

**Consumes:** `Authenticated` from bootstrap and the existing CSRF-protected reauthorize/logout routes.

**Produces:** An in-memory authenticated UI that supports reconnect and logout without exposing credentials.

- [x] **Step 1: Add failing tests for authenticated actions.**

  Add these synthetic response tests:

  ```ts
  it('shows connected status without a reconnect control when Silpo is active', async () => {
    // bootstrap -> { status: 'authenticated', csrfToken: 'test-csrf', silpoStatus: 'active' }
  });

  it('starts reauthorization for reauth_required and sends the CSRF header', async () => {
    // bootstrap -> reauth_required; click reconnect
    // reauthorize response -> { authorizationUrl: 'https://example.test/oauth' }
  });

  it('logs out with the CSRF header and returns to the Telegram entry state', async () => {
    // bootstrap -> authenticated; click logout; logout -> { status: 'logged_out' }
  });
  ```

- [x] **Step 2: Run the tests to verify they fail before the state controls exist.**

  Run:

  ```bash
  docker compose run --rm frontend npm test -- App.test.tsx
  ```

  Expected: FAIL because authenticated/reconnect/logout controls do not yet exist.

- [x] **Step 3: Implement the three authenticated states without persistent client storage.**

  Keep only `{ csrfToken, silpoStatus }` in component memory. Render:

  ```text
  active          -> “Сільпо підключено” + Logout
  reauth_required -> reconnect explanation + Reconnect + Logout
  missing         -> reconnect explanation + Reconnect + Logout
  ```

  For reconnect and logout, call the existing endpoints with:

  ```ts
  {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'x-csrf-token': csrfToken },
  }
  ```

  Follow a reconnect `authorizationUrl` only after an OK response. After successful logout, discard the in-memory CSRF token and return to the Telegram entry state. Do not call `GET /api/auth/session` in this slice: bootstrap already renews or creates the current session and is the entry contract.

- [x] **Step 4: Verify all auth UI behaviors.**

  Run:

  ```bash
  docker compose run --rm frontend npm test -- App.test.tsx
  docker compose run --rm frontend npm run lint
  docker compose run --rm frontend npm run build
  ```

  Expected: tests, lint, and production build exit 0.

## Task 4: Final validation and handoff

**Files:**
- Modify: `docs/superpowers/plans/2026-08-29-telegram-mini-app-auth-ui.md` only to check completed items and record fresh command outcomes.

**Consumes:** Tasks 1–3.

**Produces:** Evidence for an independent REVIEW context, without live OAuth, personal data, or secrets.

- [x] **Step 1: Run the repository checks.**

  Run:

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

  Expected: every command exits 0. Do not use real Telegram `initData`, Silpo OAuth, MCP calls, or credentials for validation.

- [x] **Step 2: Record results and create a narrow IMPLEMENT handoff.**

  In the plan, mark only verified steps as complete and record command names plus pass/fail counts. The handoff must include only: `AGENTS.md`, `project-rules.md`, this plan, the Phase 1 identity spec, the listed source files, exact commands, and the no-commit/no-`rlx init` constraints.

### Fresh validation record (2026-08-29, Europe/Kyiv)

| Command | Exit | Result |
| --- | ---: | --- |
| `docker compose run --rm backend npm run lint` | 0 | PASS; 0 ESLint errors, 0 warnings |
| `docker compose run --rm backend npm run typecheck` | 0 | PASS; 0 TypeScript errors |
| `docker compose run --rm backend npm test` | 0 | PASS; 9/9 suites, 57/57 tests, 0 snapshots |
| `docker compose run --rm backend npm run prisma:validate` | 0 | PASS; schema valid |
| `docker compose run --rm frontend npm run lint` | 0 | PASS; 0 ESLint errors, 0 warnings |
| `docker compose run --rm frontend npm test` | 0 | PASS; 1/1 file, 11/11 tests |
| `docker compose run --rm frontend npm run build` | 0 | PASS; TypeScript/Vite build, 15 modules transformed |
| `git diff --check` | 0 | PASS; 0 whitespace errors |

The existing Docker warning that `APP_ORIGIN` is not set was non-blocking. No real Telegram `initData`, Silpo OAuth, MCP call, personal data, credential, or secret was used.

- [x] **Step 3: Run a fresh independent REVIEW context.**

  Reviewer scope: inspect the diff against this plan; verify no browser fallback or credential persistence was introduced; verify raw `initData` is absent from UI/error output; verify bootstrap/reauthorize/logout request shapes and navigation are backend-controlled; rerun the Task 4 commands. The reviewer changes no files. Address only confirmed findings in a subsequent IMPLEMENT context.

This step is complete: the independent REVIEW context found a confirmed contract gap, and the user authorized this narrow follow-up correction. The handoff report records the finding, TDD RED/GREEN evidence, and final validation.

Independent REVIEW result and authorized ruling (2026-08-29): all eight Task 4 commands exited 0 before the follow-up, but review found a contract gap in `backend/src/auth/auth.controller.ts`: a matching Telegram session returned `silpoStatus: 'active'` without checking the current connection. Because this plan forbids the frontend from calling `GET /api/auth/session`, an existing session could hide `reauth_required` or `missing`. The user authorized the narrow backend correction; matching-session bootstrap now reuses `silpoStatus(session.userId)`, with no frontend, route, schema, storage, or refactor changes.

## Plan Self-Review

- Scope coverage: Tasks 2–3 complete only the missing frontend side of the approved Telegram identity and Silpo OAuth flow; Task 1 restores the currently known quality gate; Task 4 creates validation and independent review evidence.
- Explicit exclusions: product catalogue, provider abstraction, branch context, Product Score, price tracking, notifications, discount optimization, real OAuth validation, and Ralphex tooling changes are not hidden in this plan.
- Type consistency: all UI states use the existing bootstrap union and existing reauthorize/logout route contracts; no new backend API is introduced.
