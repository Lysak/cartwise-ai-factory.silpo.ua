# M1–M3 MCP Spike Findings (2026-08-31)

Live probe of the real `https://mcp.silpo.ua/mcp` through the deployed backend, using a temporary
env-gated read-only `POST /api/silpo/_spike` route (since removed). All calls read-only; no writes.
Branch used: Вінниця, вул. Зодчих, 2 (`branchId 1edb6b53-596c-6d06-b5f0-b5ff7ea46636`).

## 1. Barcode / EAN — NOT supported by MCP

- `silpo_find_products_batch` accepts, per search term: a product **name** (fuzzy) **or** an
  **`externalProductId`** — a 6-digit internal Silpo article code (e.g. `953005`), also present as the
  numeric tail of every `slug` (`...-953005`).
- Real EAN‑13 barcodes return nothing: `5449000000996` (Coca‑Cola) → `totalFound: 0`;
  `7622210449283` (Milka) → `totalFound: 0`. Search by article code `"953005"` → exact match.
- `silpo_get_product_details` `attributes` contain **no barcode / EAN field**.
- **Conclusion:** "scan an EAN → resolve to a Silpo product" is impossible with MCP alone. It needs an
  external resolver (e.g. Open Food Facts: EAN → name/brand → `silpo_find_products_batch` by name) or a
  name-search entry point.

## 2. Product-tool context — trivial, no cart tools required

- `silpo_get_products`, `silpo_find_products_batch`, `silpo_get_product_details` all require
  `branchId` + `deliveryType` + `timeslotStart` + `timeslotEnd`.
- **Confirmed working:** `{ branchId: <any branch from silpo_list_branches>, deliveryType: 'SelfPickup',
  timeslotStart: <≈ now + 1 day, ISO>, timeslotEnd: <+30 min> }`. A **synthetic future timeslot is
  accepted**; a stale (past) timeslot yields empty results / errors.
- The user's cart is **not** needed for reads. `silpo_get_my_shopping_cart` → `{ shoppingCartId }`;
  `silpo_get_shopping_cart_by_id` → full cart (`deliveryType`, `timeslot`, `shipments[].branchId`,
  line items with `price`/`oldPrice`/`stock`, loyalty bonus) — informative but not required here.
  The nil UUID (`00000000-…`) is rejected.
- `silpo_get_categories` needs only `branchId`.
- `silpo_get_time_slots` returned a hard `502` on every attempt — treat as unavailable; use a synthetic slot.

## 3. Price data — already in list & detail records

`silpo_get_products` / `silpo_find_products_batch` product record:
`{ id, name, slug, price, oldPrice, stock, available, image, displayRatio, weighted, step,
specialPrices, companyId, branchId, externalProductId }`.

- `price` = current selling price at that `branchId`; `oldPrice` = pre-discount price or `null`.
- Per-branch (the record carries `branchId`).
- **Conclusion:** price tracking can poll `silpo_find_products_batch` by exact `externalProductId` per
  (product, branch). No dedicated price/history tool exists.

## 4. Product-Score data — only from `silpo_get_product_details` → `product.attributes`

`attributes` is a **free-form Ukrainian key → value map, highly variable and frequently sparse**:

| Product | attribute keys present |
| --- | --- |
| Цукерка шоколадна Єдиноріг | `Склад` (full ingredients, E‑numbers, allergens in CAPS), `Містить алергени`, `Країна`, `Торгова марка`, `Продавець`, `Енергетична цінність (кКал/кДЖ)` `"612/2568"`, `Білки (г)` `6.8`, `Жири (г)` `41.9`, `Вуглеводи (г)` `51.8` |
| Молоко кокосове Ranre органічне | only `Країна`, `Торгова марка`, `Продавець`, **`Органіка/Еко` `"Органічний"`** — no ingredients, no nutrition |
| Напій Coca‑Cola Zero | `Країна`, `Торгова марка`, `Розмір/об'єм`, `Продавець`, `Енергетична цінність` `"0,2/0,9"`, `Білки/Жири/Вуглеводи (г)` `0` — no `Склад`, no organic key |

- Signals we can extract: energy, protein, fat, carbs, ingredient text, allergen list, country, brand,
  sometimes an organic flag (`Органіка/Еко`).
- Not available: sugar / salt / fibre grams, a processing (NOVA) class, a structured additive list
  (must regex `E\d{3}` out of `Склад`).
- Numbers appear both as JSON numbers and as comma-decimal strings (`"0,2"`); energy as `"kcal/kJ"`.
- `silpo_get_product_details` needs a `slug` that must come from a prior search result — never
  constructed. So scoring a product = **2 MCP calls**: search → slug → details.
- **Conclusion:** the Score engine is a tolerant heuristic over sparse free text, not a clean
  Nutri-Score. It must degrade gracefully and publish a `confidence` / data-completeness value.

## Recommendation

- **M1 — product entry + branch context.** Primary entry is **name search** via
  `silpo_find_products_batch`, not barcode. User picks one branch once (from `silpo_list_branches` +
  our `?q=` filter); persist `User.preferredBranchId`. The product-tool context
  (`branchId` + `SelfPickup` + synthetic near-future timeslot) is built server-side. No cart, no writes.
- **M2 — Product Score.** Tolerant `attributes` parser (key aliases, comma decimals, `"x/y"` energy),
  `E\d{3}` additive extraction from `Склад`, organic flag, allergens; deterministic weighted score
  0–100 + `confidence`; cache in a `product_analysis` table keyed by `slug` + `source_hash` +
  `algorithm_version`.
- **M3 — price tracking + notifications.** Poll `silpo_find_products_batch` by `externalProductId` per
  (product, branch) on a Postgres `FOR UPDATE SKIP LOCKED` schedule; append `price_changes` on delta;
  compute min over 7 / 30 / 90 days; notify. `TELEGRAM_BOT_TOKEN` is unset → in-app notifications for
  MVP, Telegram channel optional.
- **Barcode scanning** — separate later slice: Open Food Facts `EAN → name` bridge feeding the M1
  name search. Kept out of M1–M3.
