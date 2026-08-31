# Independent verification prompts: Tasks 2–7

Run each section in a separate Codex session from the repository root. These are verification-only prompts: do not edit files, run migrations, reset databases, delete data, call real OAuth/MCP endpoints, or create commits. Never print secrets or raw Telegram `initData`.

Every session must read `AGENTS.md`, `project-rules.md`, the corresponding task in `docs/superpowers/plans/2026-08-12-telegram-identity-silpo-connection.md`, and the matching sections of `docs/superpowers/specs/2026-08-12-user-identity-and-silpo-connection-design.md`. Use codebase-memory-mcp first, confirm the project/generation, and check coverage for every cited path. Treat graph gaps or ignored paths as a reason to read source directly. Report evidence, not assumptions.

## Prompt — Task 2

Audit Task 2 (opaque Redis sessions and guards) only. Do not change code.

Verify `SessionService`, `SessionGuard`, `CsrfGuard`, cookie/parser/proxy wiring, and their focused tests against the plan/spec. In particular prove: opaque 256-bit IDs; SHA-256 session Redis keys; 30-day sliding TTL bounded by a 90-day absolute expiry; renewal uses `EXPIRE` and never recreates a missing key; rotation deletes before creating; Redis errors fail closed; production cookie is `__Host-cartwise_session` with secure/path attributes; unsafe requests require exact `APP_ORIGIN` and constant-time CSRF validation; bootstrap text parser is limited to 8kb.

Run:

```bash
docker compose run --rm backend npm test -- session.service.spec.ts session.guard.spec.ts csrf.guard.spec.ts
docker compose run --rm backend npm run typecheck
git diff --check
```

Return PASS/FAIL for every criterion, exact test results, coverage caveats, and blockers. Do not claim the migration or OAuth is tested.

## Prompt — Task 3

Audit Task 3 (strict Telegram validation and auth endpoints) only. Do not change code or call Telegram.

Inspect the validator and controller. Prove that raw `initData` is not logged/stored; duplicate keys, stale/future dates, tampering, malformed users, and wrong-size hashes fail; HMAC uses Telegram’s two-stage scheme and constant-time equal-length comparison; IP rate limiting precedes validation and verified-user limiting follows it; valid same-Telegram sessions do not query PostgreSQL; a mismatched session is destroyed; existing users get a rotated/new local session without OAuth; new verified users create only a first-owner state. Check `/session` and `/logout` guard/CSRF/cookie/state-invalidation behavior.

Run:

```bash
docker compose run --rm backend npm test -- telegram-init-data.service.spec.ts auth.controller.spec.ts
docker compose run --rm backend npm run typecheck
git diff --check
```

Report any status-staleness or production-runtime limitation separately from test results.

## Prompt — Task 4

Audit Task 4 (owned OAuth state and callback) only. Do not call real OAuth or apply migrations.

Verify the absence of public ownerless `/auth/silpo/start` and `/probe`; the first/reauthorization typed entrypoints; SHA-256 state hashing, server-side encrypted verifier, ten-minute expiry, and atomic `DELETE ... RETURNING` consumption before exchange. Verify reauthorization checks the initiating Redis session before exchange and rotates it only after DB commit. Verify the transaction cannot create an unowned connection or duplicate user, and failed exchanges do not create a user. Verify callback URLs/DCR client lookup are exclusively based on non-empty `APP_ORIGIN` and matching stored `redirectUri`.

Run:

```bash
docker compose run --rm backend npm test -- silpo-oauth.service.spec.ts
docker compose run --rm backend npm run typecheck
docker compose run --rm backend npm run build
git diff --check
```

Report whether local `.env` supplies `APP_ORIGIN`; an empty value must be reported as fail-closed runtime configuration, not fixed or bypassed.

## Prompt — Task 5

Audit Task 5 (centralized connection access and refresh boundary) only. Do not call Silpo.

Verify that `withReadAccess` and `withWriteAccess` accept only `userId`, not a connection ID; read operations retry once only after a classified authorization rejection; writes never retry; on-demand refresh selects only that user’s connection; absent rotated refresh token is preserved; only refresh-endpoint 400/401 enters `reauth_required`; temporary/network/429/5xx failures do not. Verify hourly cron selection uses two-hour window and one transaction/lock per connection, with no batch transaction across remote calls. Verify `SILPO_REAUTH_REQUIRED` maps to a non-401 response and preserves the local session.

Run:

```bash
docker compose run --rm backend npm test -- silpo-connection.service.spec.ts silpo-oauth.service.spec.ts
docker compose run --rm backend npm run typecheck
git diff --check
```

Report PASS/FAIL per invariant and any test double limitations.

## Prompt — Task 6

Audit Task 6 (same-origin ingress) only. Do not modify frontend code.

Read `deploy/nginx/cartwise.conf` directly because `deploy/` may be excluded from the graph. Verify `/api/` alone proxies to the private Nest upstream; all other paths serve static Vite assets with SPA fallback; forwarded headers are `Host`, `X-Forwarded-Proto`, and exactly the trusted proxy source address for `X-Forwarded-For`; the production contract exposes no backend, Redis, or PostgreSQL port; compose remains explicitly local-dev oriented. Audit Vite source and generated assets for server secrets, backend credentials, and production CORS rules.

Run:

```bash
docker compose run --rm frontend npm run build
docker run --rm --add-host backend:127.0.0.1 -v "$PWD/deploy/nginx/cartwise.conf:/etc/nginx/conf.d/default.conf:ro" nginx:alpine nginx -t
git diff --check
```

Report that the `--add-host` fixture is only for standalone nginx syntax resolution.

## Prompt — Task 7

Audit Task 7 (verification and operational handoff) only. Do not edit docs or databases.

Check README and plan for required env names only, no secret values, and a fail-closed legacy-cutover instruction. Re-run all quality commands and distinguish failures from task failures. Use only synthetic/unit evidence for stale/tampered bootstrap, existing-user session, logout, and `SILPO_REAUTH_REQUIRED`; do not use personal data or a real OAuth session.

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

Run only this read-only cutover preflight query; do not migrate:

```bash
docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM \"SilpoConnection\";"'
```

The result alone is not operator approval. Report the local migration history and row count as observed, flag any unexplained change, and leave Task 7.3 incomplete unless an operator has explicitly confirmed a fresh target or approved retirement of every legacy credential.
