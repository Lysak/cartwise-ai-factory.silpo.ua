# Cartwise MVP — M1–M3 Design (Search → Score → Price Tracking)

**Status:** draft for review (2026-09-01)

Shared design for the three MVP milestones. The master tracker is
`docs/superpowers/plans/2026-09-01-cartwise-mvp-roadmap.md`; each milestone has its own implementation
plan that references this document.

## 1. Product

A user opens the web app (or Telegram Mini App shell), **searches a product by name**, reads a
deterministic **quality score** (Yuka-inspired, adapted to the data we actually have), taps a **heart**
to start **tracking its price at a chosen store**, and sees an **in-app feed** of price events —
including "lowest in the last 7 / 30 / 90 days".

`docs/idea.md` is the product source of truth. This design narrows it to what is buildable on the
official Silpo MCP within the hackathon.

## 2. Scope

**In (M1–M3):**
- Branch pick + search, product search by name, product detail.
- Product Score 0–100, deterministic, versioned, with an explicit **data-confidence** level.
- Minimum-score filter on the search list.
- Price tracking per (product, branch); price history; price intelligence (min 7/30/90d, all-time,
  % vs average).
- In-app notification feed ("My products" screen with price events).

**Out (later milestones / other plans):**
- Barcode / QR scanning. MCP has **no barcode lookup** (verified — see §4). Documented fallback path:
  Silpo storefront `sf-ecom-api ?searchV2=<EAN>` resolves EANs, but it is not the official MCP and is
  kept out of the hackathon core.
- Discount Optimizer (coupons / promos / loyalty / certificates).
- Web Push and Telegram push notifications. In-app feed only for MVP.
- Delivery flows, cart mutations, any MCP write.

## 3. Hard constraints from live MCP research

Full evidence: `docs/superpowers/specs/2026-08-31-m1-m3-mcp-spike-findings.md`. The load-bearing facts:

1. **No barcode.** `silpo_find_products_batch` matches product **name** (fuzzy) or the internal
   6-digit `externalProductId`. 8 real EANs → 0 hits. No barcode field in any MCP response. → entry is
   name search.
2. **Product-tool context is synthetic and cheap.** `silpo_get_products` / `silpo_find_products_batch`
   / `silpo_get_product_details` need `branchId` + `deliveryType` + `timeslotStart` + `timeslotEnd`.
   `{ branchId: <chosen>, deliveryType: 'SelfPickup', timeslotStart: <now + 1 day, ISO>,
   timeslotEnd: <+30 min> }` works. A **past** timeslot fails — always send a future one. No cart, no
   `silpo_get_time_slots` (it 502s).
3. **Price is available.** Product records carry `price` (current, per branch) and `oldPrice`
   (pre-discount or null). No dedicated price/history tool — we build history ourselves.
4. **Score data is thin.** `silpo_get_product_details.product.attributes` is a free-form Ukrainian
   key→value map. Across 13 sampled products: energy + protein + fat + carbs present for most (energy
   sometimes malformed as `"27/"`); `Склад` (ingredient list) present in **1 of 13**; sugar / salt /
   saturated fat / fibre — never; organic flag (`Органіка/Еко`) and allergen list — sometimes.
   The storefront `sf-ecom-api` has the same gap. → the score is a **partial nutritional index**, not a
   full Yuka score, and must publish how confident it is.
5. **Two MCP calls per scored product:** search → `slug` (never constructible) → `silpo_get_product_details`.
6. **`limit` up to 500** on `silpo_list_branches`; product tools cap `limit` at 100.

## 4. Architecture

Layering follows `docs/idea.md` §7. `SilpoOauthService.callSilpoTool` is the only path to
`mcp.silpo.ua`; authenticated reads go through `SilpoConnectionService.withReadAccess`.

```
React (mobile-first, Telegram Mini App shell)
        │  same-origin, opaque session cookie
NestJS
 ├── silpo/        MCP reads: branches, product search, product details   (M1)
 ├── catalog/      branch cache (Redis), synthetic store context          (M1)
 ├── score/        deterministic Product Score engine + product_analysis  (M2)
 ├── tracking/     tracked products, price_changes, Postgres scheduler     (M3)
 └── notifications/ in-app event feed                                     (M3)
        │
PostgreSQL 18 (Prisma)  ·  Redis 8 (cache + rate-limit only)
        │
Official Silpo MCP
```

### M1 — Search, product, store context

- **Store context module (`catalog`)**
  - `GET /api/silpo/branches?q=` — Redis-cached full branch list (TTL ~24 h), in-memory token filter on
    `city + address`. Extends the existing `GET /api/silpo/branches`.
  - `POST /api/user/branch` — persist the chosen branch. Schema: add `User.preferredSilpoBranchId String?`.
  - `resolveStoreContext(userId)` → `{ branchId, deliveryType: 'SelfPickup', timeslotStart, timeslotEnd }`
    with a timeslot computed as the next day at a fixed UTC hour, 30-minute window. Pure, no MCP call.
- **Product search (`silpo`)**
  - `GET /api/silpo/products?q=<text>&minScore=<n?>&limit=<n?>` → `withReadAccess` →
    `silpo_find_products_batch({ ...storeContext, products: [q], limit })`. Returns a sanitized list:
    `{ silpoProductId, slug, externalProductId, name, brandTitle, image, price, oldPrice, stock,
    available, displayRatio }`. `minScore` filters using cached scores (M2); before M2 it is ignored.
  - `GET /api/silpo/products/:slug` → `silpo_get_product_details({ ...storeContext, slug })`. Returns
    the sanitized product plus a **normalized nutrition/attribute block** (see §5).
- No new persistence beyond `User.preferredSilpoBranchId`.

### M2 — Product Score

- **`score` module**, deterministic and versioned. Input: the normalized attribute block from M1.
- Factors (weights tuned in the plan, documented in the engine):
  - nutritional density from energy + protein + fat + carbs per 100 g (the only always-present signals);
  - additive penalty from `E\d{3}` tokens in `Склад` **when present**;
  - organic bonus when `Органіка/Еко` is set;
  - (allergens are surfaced but not scored).
- Output: `{ score: 0..100, confidence: 'low' | 'medium' | 'high', factors: [...], algorithmVersion }`.
  `confidence` is `low` when only macros are available (the common case), higher as `Склад` / organic /
  full nutrition appear. The UI always shows the confidence badge; the demo narrative is "the score
  improves automatically when Silpo MCP exposes ingredients and sugar/salt".
- **Cache:** `ProductAnalysis` table keyed by `slug` + `sourceHash` (SHA-256 of the normalized input) +
  `algorithmVersion`. Recompute only when the hash or version changes.
- `GET /api/silpo/products/:slug` and the search list include the score (compute-on-read, then cached).

### M3 — Price tracking + in-app notifications

- **Schema (Prisma):**
  - `TrackedProduct` — `id, silpoExternalProductId, slug, name, silpoBranchId, status,
    currentPrice, lastCheckedAt, nextCheckAt, lastSuccessAt, failedAttempts, lastError`.
    `UNIQUE(silpoExternalProductId, silpoBranchId)` — one tracker per product+branch, shared across users.
  - `PriceSubscription` — `id, userId, trackedProductId, createdAt`. `UNIQUE(userId, trackedProductId)`.
  - `PriceChange` — `id, trackedProductId, price, oldPrice, observedAt`. Append only on a real delta.
  - `NotificationEvent` — `id, userId, trackedProductId, type, payload, createdAt, readAt`.
- **Endpoints:** `POST /api/tracking` (heart — creates/*links* a `TrackedProduct` + `PriceSubscription`
  for the user's current branch), `DELETE /api/tracking/:id`, `GET /api/tracking` (the "My products"
  screen: each item with price intelligence), `GET /api/notifications`, `POST /api/notifications/:id/read`.
- **Scheduler:** NestJS cron every ~10 min → `SELECT ... FROM "TrackedProduct" WHERE status = 'active'
  AND "nextCheckAt" <= NOW() ORDER BY "nextCheckAt" LIMIT 20 FOR UPDATE SKIP LOCKED` (via `$queryRaw`).
  For each: pick any subscriber, `withReadAccess` → `silpo_find_products_batch` by `externalProductId`
  at that branch → compare price → on change: insert `PriceChange`, update `currentPrice`, fan out a
  `NotificationEvent` to every subscriber. Adaptive `nextCheckAt` (1 h base; back off on
  `not_found` / errors; `429` → exponential backoff).
- **Price intelligence** (computed from `PriceChange`): current, min/avg over 7/30/90 d, all-time min,
  % vs 30-day average, "is this a good price" flag, spark data.
- **Notification types:** `price_drop`, `lowest_30d`, `lowest_90d`, `all_time_low`. Delivered only to
  the in-app feed for MVP.

## 5. Normalized attribute block (M1 output, M2 input)

Tolerant parser over the raw `attributes` map:

```ts
type NormalizedProductData = {
  energyKcal: number | null;       // parse "612/2568" | "27/" | "0,2/0,9"  → first number
  proteins: number | null;         // number | "2,8"
  fats: number | null;
  carbs: number | null;
  ingredientsText: string | null;  // attributes["Склад"] | attributes["Інгредієнти"]
  additives: string[];             // /E\s?\d{3,4}/gi from ingredientsText
  allergens: string[];             // split attributes["Містить алергени"]
  isOrganic: boolean;              // attributes["Органіка/Еко"] non-empty
  country: string | null;
  brand: string | null;
};
```

Rules: accept comma or dot decimals; `"x/y"` → `x`; missing key → `null`; never invent a value.

## 6. Cross-cutting

- **Sanitization:** every endpoint returns an allowlisted shape. Never expose `companyId`, tokens, raw
  MCP envelopes, `silpoExternalId`, or personal Silpo data.
- **Rate limiting:** reuse the per-user Redis counter for every new MCP-backed endpoint.
- **Determinism:** Score, price math, and notification rules are pure functions with unit tests. No
  runtime LLM.
- **Auth:** all new endpoints behind `SessionGuard`; a Silpo-only session is sufficient.
- **No new dependencies** beyond what the milestones' plans justify (e.g. a small fuzzy-match helper if
  needed — evaluated against a hand-rolled one first).

## 7. Open questions (resolve during the milestone plans)

- Score weightings and the `confidence` thresholds — decide in the M2 plan against a labeled sample.
- Whether `silpo_find_products_batch` by `externalProductId` reliably returns the same product at an
  arbitrary branch (M3 scheduler depends on it) — verify live in the M3 plan's first step.
- Branch-search relevance: plain token match vs a light fuzzy score — start with token match.
