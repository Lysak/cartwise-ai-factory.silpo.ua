# Cartwise MVP Roadmap (M1–M3)

Master tracker. Design: `docs/superpowers/specs/2026-09-01-cartwise-mvp-m1-m3-design.md`.
Research evidence: `docs/superpowers/specs/2026-08-31-m1-m3-mcp-spike-findings.md`.

**Product in one line:** search a product by name → see a deterministic quality score → tap the heart
to track its price at a chosen store → see an in-app feed when the price hits a 7/30/90-day low.

**Depth-first.** Do M1 and M2 well; M3 as far as time allows. Discount Optimizer, barcode scan, and
push notifications are explicitly out (see design §2).

## Milestones

- [ ] **M1 — Search, product, store context** — `plans/2026-09-01-m1-product-search-and-context.md`
  - [ ] Branch cache + `?q=` search on `GET /api/silpo/branches`
  - [ ] `User.preferredSilpoBranchId` + `POST /api/user/branch`
  - [ ] `resolveStoreContext(userId)` (synthetic SelfPickup + future timeslot)
  - [ ] `GET /api/silpo/products?q=` (name search, sanitized list)
  - [ ] `GET /api/silpo/products/:slug` (detail + normalized attribute block)
  - [ ] Frontend: branch picker + product search + product screen

- [ ] **M2 — Product Score** — `plans/2026-09-01-m2-product-score.md`
  - [ ] Tolerant attribute parser → `NormalizedProductData`
  - [ ] Deterministic weighted engine → `{ score, confidence, factors, algorithmVersion }`
  - [ ] `ProductAnalysis` cache (slug + sourceHash + algorithmVersion)
  - [ ] Score on the product screen + confidence badge + factor breakdown
  - [ ] `minScore` filter on the search list

- [ ] **M3 — Price tracking + in-app notifications** — `plans/2026-09-01-m3-price-tracking-and-notifications.md`
  - [ ] Verify `silpo_find_products_batch` by `externalProductId` is branch-stable (spike step)
  - [ ] Prisma: `TrackedProduct`, `PriceSubscription`, `PriceChange`, `NotificationEvent`
  - [ ] Heart endpoints: `POST/DELETE/GET /api/tracking`
  - [ ] Postgres scheduler (`FOR UPDATE SKIP LOCKED`) + adaptive `nextCheckAt`
  - [ ] Price intelligence (min 7/30/90d, all-time, % vs avg)
  - [ ] `GET /api/notifications` + "My products" screen with the event feed

## Shared decisions (locked)

| Topic | Decision |
| --- | --- |
| Product entry | Name search. Barcode scan out of scope (MCP has none). |
| Score | Deterministic index from MCP `attributes` (energy + macros + organic/allergen flags) + `confidence` badge. Honest about the data gap; doubles as feedback to Silpo. |
| Store context | User picks one branch; `SelfPickup` + synthetic next-day timeslot; no cart, no writes. |
| Notifications | In-app feed only. Web Push / Telegram push = later milestones. |
| Provider | Official Silpo MCP only. `sf-ecom-api` (barcode/`searchV2`) documented but unused in the core. |
| Data | Redis = cache + rate-limit only. Scheduling on Postgres. No queues, no microservices. |

## Later (not in this roadmap)

- M4 — Discount Optimizer (coupons / promos / loyalty / certificates → best cart scenario).
- M5 — Push notifications: Web Push (VAPID + service worker + PWA) and/or Telegram bot + Mini App binding.
- M6 — Barcode scanning via `sf-ecom-api ?searchV2=<EAN>` + our own `barcode → slug` cache.
- Demo polish: MCP JSON-RPC trace view.
