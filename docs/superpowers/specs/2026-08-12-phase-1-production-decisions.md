# Phase 1 Production Decisions: Telegram Identity and Silpo Connection

## Status

Proposed production decisions based on the Phase 1 review. This is a decision record, not an implementation plan.

## Scope and non-goals

This document covers only Telegram Mini App identity, Silpo OAuth ownership, server-side sessions, and token refresh. It does not add web/desktop login, catalogue, scoring, prices, promotions, or MCP write actions.

## 1. Production cutover from the legacy OAuth bootstrap

The existing unowned `SilpoConnection` records are bootstrap artifacts, not migratable user accounts: there is no verified Telegram identity that can prove their owner.

- Production uses a new identity-aware schema and does not reuse an unowned connection as an authenticated account.
- Never infer an owner from a token, a Silpo response, a username, or a display name.
- A real legacy deployment must use an explicit operator-approved cutover: existing users complete Telegram bootstrap and Silpo OAuth again. The old connection is then retired under an approved credential-retention/deletion procedure; Cartwise does not automatically delete or remotely revoke it.
- A fresh production database has no legacy-data migration problem. A database that contains unowned credentials must not receive a `userId NOT NULL` migration until its operator has approved the cutover.

## 2. Canonical local identity

- `User.id` is UUID v7, generated consistently by PostgreSQL 18 `uuidv7()` (`String @id @default(dbgenerated("uuidv7()"))`).
- `silpoExternalId` from the approved `profile.id` response path is the canonical Silpo account key, nullable and unique. `telegramUserId` is optional nullable unique metadata, created or looked up only after server validation of raw Telegram `initData`.
- Telegram username and display fields are optional product metadata, never authentication evidence.
- A user owns one `SilpoConnection`; reauthorization atomically replaces its token set. Telegram and Silpo identities are not automatically merged or linked, and there is no multi-account linking in Phase 1.

## 3. Telegram bootstrap and existing users

The only Mini App entrypoint is `POST /api/auth/telegram/bootstrap`, with raw `Telegram.WebApp.initData` in the request body.

1. Require the production Mini App origin and validate the Telegram HMAC in constant time. Reject duplicate parameters, malformed `user`, invalid `auth_date`, future timestamps beyond a small clock skew, and `initData` older than five minutes. Do not log or persist raw `initData`.
2. Apply an IP limit before validation; after successful validation apply a Telegram-user-ID limit. The reverse proxy must be explicitly trusted so the IP is not spoofable.
3. If a valid current session has the same Telegram ID, renew it only in Redis, capped by its absolute expiry.
4. If the cookie session has another Telegram ID, delete that session before proceeding.
5. If no valid session exists but a User with the verified Telegram ID exists, create and rotate a new local session. Do not require OAuth again merely because a session expired.
6. Only when no User exists, create an OAuth state with the verified Telegram snapshot and PKCE, and return the authorization URL. No User exists before the callback completes successfully.

This resolves both the 30-day / 90-day lifetime rule and the unique Telegram identity constraint.

## 4. Owned OAuth transaction

The bootstrap endpoint creates the OAuth state directly; the current ownerless `GET /auth/silpo/start` is removed from the production flow.

- A first authorization state stores the verified Telegram fields required to create a User.
- A reauthorization state stores `ownerUserId` and the hash of the initiating local session ID.
- A database constraint requires exactly one owner form: first-authorization Telegram context or authenticated-user context.
- The random state is stored only as a hash; the encrypted PKCE verifier and exact configured redirect URI remain server-side.
- State expires in ten minutes, is atomically consumed before token exchange, and is removed after consumption. Expired rows are cleaned up.
- The callback verifies that an authenticated-owner state still has its initiating session. Logout/revocation invalidates outstanding states for that session. This prevents a callback completed after logout from reconnecting Silpo or issuing a new session.
- The callback atomically creates the User when needed, upserts the owned connection, and then rotates/creates a Redis session. If Redis is unavailable, authentication fails closed; no JWT fallback exists.

## 5. Opaque Redis session

- The browser cookie holds only a 256-bit random opaque session ID. Redis uses a SHA-256-derived key, so a Redis dump does not contain the browser bearer value directly.
- Redis value: `userId`, `telegramUserId`, `issuedAt`, `absoluteExpiresAt`, and a session CSRF secret.
- Inactivity: successful valid use renews Redis expiry to `min(now + 30 days, absoluteExpiresAt)`.
- Absolute lifetime: `issuedAt + 90 days`; it never slides. On expiry, delete the session and require Telegram bootstrap, which may create a fresh session for an existing User.
- Renewal uses Redis `EXPIRE` on the existing key rather than read-modify-write. Logout deletes the key; session rotation deletes the old key then writes a new one.
- Redis unavailability fails authentication closed.

## 6. Cookie, CSRF, and same-origin transport

Production is one HTTPS origin: the reverse proxy serves the React/Vite build at `/` and proxies `/api` to NestJS.

- Cookie: `__Host-cartwise_session`; `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain`, and `Max-Age` no greater than current Redis TTL.
- Rotate cookie/session ID at first login, reauthorization, Telegram-account mismatch, and any privilege-changing transition.
- `POST /api/auth/logout` deletes the current Redis session, invalidates its outstanding OAuth states, and clears the cookie with identical scope attributes.
- Unsafe cookie-authenticated endpoints require both an exact origin check and a per-session CSRF token in a custom request header. The token is returned only by an authenticated same-origin session/bootstrap response and is rotated with the session.
- OAuth callback is exempt from origin/CSRF checks because it is protected by state + PKCE.
- Production disables CORS. Local development may retain the Vite `/api` proxy, but uses an explicitly separate non-`__Host-` HTTP cookie configuration; it is not a production security mode.
- `APP_ORIGIN` is the only source for the callback URI and post-callback redirect. The dynamic OAuth client registration records the redirect URI, so a client registered for localhost is never reused for production.

## 7. Silpo token lifecycle and reauthorization

- `SilpoConnection` has `userId` as a required unique foreign key, encrypted access/refresh tokens, expiry metadata, and a status (`active` or `reauth_required` in Phase 1).
- One central access method resolves a connection by authenticated `userId`; no client receives a connection ID from the browser.
- Cron runs hourly and selects active connections expiring within two hours. It serializes refresh per connection; it does not hold one transaction across a batch of remote requests.
- On demand, refresh only the relevant connection when the access token is expired or within one centrally defined safety window. The window must be smaller than the observed provider token lifetime.
- A refresh response atomically writes the new access token and a rotated refresh token when supplied. Do not erase the previous refresh token when the provider omits a new one.
- Only confirmed refresh rejection (`400` or `401`) changes the connection to `reauth_required`. Network failures, 429, and 5xx are temporary failures.
- A rejected otherwise-valid MCP call may refresh and repeat exactly once only if the call site has explicitly declared the operation read-only. Never infer read-only from a tool name; never automatically retry a write.
- `reauth_required` does not invalidate Cartwise's local session. Session/status API returns an explicit `SILPO_REAUTH_REQUIRED` domain code so the UI can show reconnect guidance without treating the user as logged out.
- Authenticated MCP reads run through `SilpoConnectionService.withReadAccess(userId, op)` (declares the operation read-only, enabling the single refresh-and-retry) plus `SilpoOauthService.callSilpoTool(accessToken, name, args, id)`. `SilpoOauthService` is the only module that contacts `https://mcp.silpo.ua`. Branch metadata (name, address, city, coordinates, pickup flags) is public store data and may be returned to the client; a `CommerceProvider` interface and MCP response caching are deferred until a second read consumer exists.

## 8. Required schema changes

- Add `User` with UUID v7 ID and approved Telegram fields.
- Add required unique `SilpoConnection.userId` relation and index `status, accessTokenExpiresAt` for the cron query.
- Extend `OAuthState` with exclusive owner context and initiating-session hash where applicable; index expiry for cleanup.
- Extend `OAuthClient` with `redirectUri` and use it to scope registrations to the configured origin.
- Redis sessions remain ephemeral and have no Prisma table.

## 9. Framework and frontend rules

- NestJS stays a modular monolith. Use a session guard and small services; do not introduce Passport, JWT, an identity provider, queues, or microservices for this flow.
- Validate every externally supplied DTO/body. Keep authentication secrets and Silpo credentials out of logs and out of browser responses.
- React owns only UI state and sends same-origin requests with cookies; it never stores a token, a Silpo credential, or raw `initData` after bootstrap.
- Vite variables prefixed `VITE_` are public build-time values. No Telegram bot token, encryption key, OAuth client secret, database URL, or Redis URL may use that prefix.
- Tests cover Telegram validation, OAuth owner/state consumption, existing-user session recreation, absolute/inactivity expiry, rotation/logout, CSRF/origin rejection, and read-only retry versus no write retry. Mock external OAuth/MCP calls; no test needs a real personal Silpo payload.

## Primary sources consulted

- [Telegram Mini App initData validation](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app)
- [OAuth 2.0 Security Best Current Practice (RFC 9700)](https://datatracker.ietf.org/doc/html/rfc9700)
- [NestJS CSRF](https://docs.nestjs.com/security/csrf) and [rate limiting](https://docs.nestjs.com/security/rate-limiting)
- [Prisma UUID v7 schema reference](https://www.prisma.io/docs/orm/reference/prisma-schema-reference)
- [Vite environment-variable security](https://vite.dev/guide/env-and-mode)
