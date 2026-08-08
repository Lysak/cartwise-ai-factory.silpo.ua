# idea.md

## Silpo AI Factory — ідея та архітектурний старт

### Посилання

- Хакатон: https://ai-factory.silpo.ua/
- MCP / секція Hackathon: https://ai-factory.silpo.ua/docs/mcp#hackathon

---

## 1. Загальна концепція

Ми створюємо персоналізований веб-сервіс і Telegram Mini App, який працює поверх офіційного MCP «Сільпо» та допомагає користувачу:

1. оцінювати якість продуктів;
2. відстежувати історію цін у конкретному магазині;
3. знаходити найвигідніший спосіб покупки з урахуванням персональних акцій, купонів, балобонусів, сертифікатів та додаткових вигод способів оплати.

Продукт можна розглядати як персоналізоване розширення екосистеми «Сільпо» для конкретного користувача. Кожен користувач авторизується через власний акаунт «Сільпо», а наш backend працює з MCP від його імені.

Основний принцип:

> **Обирай кращий продукт. Купуй у правильний момент. Використовуй максимальну доступну вигоду.**

---

## 2. Формат застосунку

### Пріоритет інтерфейсів

1. **Telegram Mini App — основний сценарій**
2. **Mobile Web — той самий React-застосунок у браузері**
3. **Desktop — адаптивна версія mobile-first UI**

Окремий desktop-дизайн не є пріоритетом. На широкому екрані центральний контейнер може ставати ширшим, але головний UX оптимізується для телефону.

Telegram використовується як контейнер для веб-застосунку, а не обов'язково як основна система автентифікації.

---

## 3. Авторизація

### Основна авторизація

Користувач відкриває Telegram Mini App або веб-версію та підключає свій акаунт «Сільпо» через OAuth MCP.

Очікуваний flow:

```text
Telegram Mini App / Mobile Web
        ↓
React
        ↓
"Увійти / Підключити Сільпо"
        ↓
NestJS запускає OAuth 2.1 + PKCE
        ↓
auth.silpo.ua
        ↓
телефон + OTP / пароль
        ↓
callback у backend
        ↓
отримуємо MCP access token + refresh token
        ↓
створюємо локального user
        ↓
зберігаємо MCP credentials серверно
```

### Локальний користувач

У власній базі зберігаємо мінімальний набір даних:

```text
users
- id
- silpo_external_id / інший стабільний ідентифікатор, якщо він доступний
- created_at
- updated_at
```

Окремо:

```text
silpo_connections
- user_id
- access_token_encrypted
- refresh_token_encrypted
- access_token_expires_at
- refresh_token_expires_at nullable
- status
- updated_at
```

Не дублюємо без потреби ім'я, телефон, email, адресу, історію покупок та інші персональні дані «Сільпо».

### Token lifecycle

Access token і refresh token зберігаються тільки на backend, у зашифрованому вигляді (`access_token_encrypted`, `refresh_token_encrypted`).

#### Шифрування токенів

- Алгоритм: **AES-256-GCM**.
- Ключ шифрування — 32-байтовий secret, зберігається в ENV-змінній backend (наприклад `TOKEN_ENCRYPTION_KEY`), ніколи не потрапляє в репозиторій.
- Для MVP хакатону — без managed KMS; ротація ключа виконується вручну.
- Розшифровка відбувається тільки на backend безпосередньо перед MCP-запитом, розшифрований токен ніколи не повертається в API-відповіді фронтенду.

#### Refresh стратегія

Токени рефрешаться двома механізмами:

1. **Proactive-refresh cron** — окрема періодична задача, яка вибирає `silpo_connections` зі `status = 'active'`, у яких `access_token_expires_at` настане найближчим часом (наприклад, протягом 15 хв), і рефрешить їх заздалегідь. Обробляються тільки активні з'єднання — неактивні (`reauth_required`) пропускаються, щоб не марнувати MCP/OAuth-виклики.
2. **Defensive on-demand refresh** — safety net: якщо під час реального MCP-запиту access token виявився протухлим (proactive cron не встиг або впав), backend рефрешить його негайно перед запитом.

```text
Cron: token-refresh (кожні N хв)
        ↓
SELECT active connections
WHERE access_token_expires_at <= NOW() + interval '15 minutes'
        ↓
refresh token
        ↓
атомарно зберігаємо новий token set

---

MCP-запит (будь-який кейс)
        ↓
access token ще валідний?
        ├─ так → використовуємо
        └─ ні (edge case, proactive cron не встиг)
             ↓
        refresh token
             ↓
        зберігаємо новий token set
             ↓
        виконуємо MCP-запит
```

Якщо refresh token більше не працює:

```text
status = reauth_required
```

і користувач повторно проходить авторизацію через «Сільпо».

При refresh треба враховувати можливу ротацію refresh token і атомарно зберігати новий набір токенів.

---

## 4. Основні функції продукту

## 4.1. Product Score — оцінка якості товару

### Ідея

Створюємо власну детерміновану систему оцінювання продукту від 0 до 100.

Під час research можна орієнтуватися на існуючі системи оцінювання продуктів, але:

- не використовуємо їхню назву у продукті;
- не копіюємо бренд;
- будуємо власний scoring engine;
- у runtime не потрібен LLM.

### Дані

Через MCP отримуємо максимально повні дані продукту:

- склад;
- харчову цінність;
- атрибути;
- зображення;
- інші доступні поля product details.

Barcode / EAN треба окремо перевірити через реальний `tools/list`, оскільки публічна документація не гарантує його наявність у product schema.

### Barcode flow

Сканування штрихкоду реалізується у React.

```text
камера телефону
        ↓
EAN / barcode
        ↓
BarcodeResolver
        ↓
наш локальний mapping або MCP lookup
        ↓
Silpo product
        ↓
Product Score
```

`BarcodeResolver` треба зробити окремим модулем, щоб не прив'язувати архітектуру до одного способу пошуку.

### Scoring engine

Приблизна структура:

```text
Product data
   ↓
Normalizer
   ↓
NutritionScorer
AdditivesScorer
ProcessingScorer
PositiveFactorsScorer
   ↓
ProductScoreEngine
   ↓
0–100
```

Score має бути:

- детермінованим;
- відтворюваним;
- пояснюваним;
- versioned.

### Кешування score

Score не треба рахувати при кожному перегляді.

Зберігаємо:

```text
product_analysis
- product_id
- score
- nutrition_score
- additives_score
- processing_score
- other_score
- source_hash
- algorithm_version
- calculated_at
```

`source_hash` рахується з нормалізованих даних продукту, наприклад:

```text
SHA256(
  ingredients +
  nutrition +
  attributes
)
```

Якщо `source_hash` не змінився і `algorithm_version` та сама — повертаємо готовий score з PostgreSQL.

Якщо змінився склад або версія алгоритму — перераховуємо.

### UX

Користувач може встановити мінімальний рейтинг:

```text
Не фільтрувати
40+
60+
70+
80+
```

Наприклад, при threshold `70`:

```text
Recommended
- Product A — 84
- Product B — 79
- Product C — 73

Below your threshold
- Product D — 52
- Product E — 31
```

Товари нижче threshold не обов'язково приховувати повністю — краще показувати їх нижче окремою секцією.

---

## 4.2. Price Tracking — історія цін

### Основна модель

Price tracking працює в контексті:

```text
product + branch
```

Користувач:

1. вибирає конкретний магазин «Сільпо»;
2. знаходить продукт;
3. натискає `Track price`;
4. система починає накопичувати історію ціни для цього product/branch.

### Дані

```text
products
- id
- silpo_product_id
- barcode nullable
- name
- category_id
- image_url
- ...

branches
- id
- silpo_branch_id
- name
- ...

tracked_market_products
- id
- product_id
- branch_id
- status
- current_price
- last_checked_at
- next_check_at
- last_success_at
- failed_attempts
- last_error
- created_at
- updated_at

price_subscriptions
- id
- user_id
- tracked_market_product_id
- notify_on_drop
- target_price nullable
- threshold_percent nullable
- created_at
```

Обов'язковий unique constraint:

```text
UNIQUE(product_id, branch_id)
```

Якщо 500 користувачів track'ять той самий товар у тому самому магазині, у нас один `tracked_market_product`, а не 500 однакових MCP-checks.

### Price history

Зберігаємо тільки зміни:

```text
price_changes
- id
- tracked_market_product_id
- price
- observed_at
```

Наприклад:

```text
01.09 → 89.99
05.09 → 69.99
12.09 → 94.99
18.09 → 72.99
```

Якщо MCP повернув ту саму ціну — новий запис не створюємо.

### Scheduler

Scheduler для price-tracking залишається на Postgres (`FOR UPDATE SKIP LOCKED`), без job-queue (BullMQ тощо) та без обов'язкових окремих worker-сервісів. Redis у проєкті є (див. [9. Технологічний стек](#9-технологічний-стек)), але використовується тільки як cache-шар, а не як черга задач.

NestJS scheduler запускається, наприклад, кожні 5–10 хвилин та вибирає тільки прострочені записи:

```text
SELECT *
FROM tracked_market_products
WHERE status = 'active'
  AND next_check_at <= NOW()
ORDER BY next_check_at
LIMIT 20
FOR UPDATE SKIP LOCKED;
```

Після перевірки:

```text
last_checked_at = now
next_check_at = now + tracking_interval
```

Початковий інтервал:

```text
1 година
```

Важливо: scheduler може запускатися раз на 10 хвилин, але один товар перевіряється не частіше, ніж дозволяє `next_check_at`.

### Batch processing

Обробляємо невеликими порціями:

```text
20
→ наступні 20
→ наступні 20
```

Це дозволяє працювати на слабкому сервері та контролювати rate limit.

### Rate limits / retry

Потрібно передбачити:

- `429`;
- exponential backoff;
- retry з обмеженням;
- `last_error`;
- `failed_attempts`;
- адаптивний `next_check_at`.

Не будуємо архітектуру навколо обходу rate limits через IP або багато акаунтів.

Якщо в майбутньому MCP throughput стане bottleneck — provider можна буде замінити або розширити без переписування основної логіки.

### Статуси товару

```text
active
temporarily_unavailable
not_found
disabled
```

Не ставимо `deleted` після першої помилки.

Приклад:

```text
1 помилка → failed_attempts = 1

кілька послідовних not_found
→ temporarily_unavailable
→ перевіряти рідше

довго відсутній
→ перевіряти раз на 24 години

знову доступний
→ active
→ failed_attempts = 0
→ стандартний інтервал
```

### Price intelligence

На основі `price_changes` показуємо:

- поточну ціну;
- мінімум за 7 / 30 / 90 днів;
- середню ціну;
- all-time minimum;
- відсоток відхилення від середньої;
- графік;
- рекомендацію, чи хороший зараз момент купувати.

Приклад:

```text
Current: 69.99 грн
30-day average: 88.40 грн
30-day minimum: 67.99 грн

Good price
Поточна ціна на 21% нижча за середню за 30 днів.
```

### Notifications

Можливі правила:

```text
Notify on any price drop
Notify at 20% below average
Notify at 30-day low
Notify below 70 UAH
```

Telegram можна використовувати як канал нотифікацій.

Для цього пізніше можна опціонально прив'язати Telegram user id до локального user, але Telegram authentication не є обов'язковою основою акаунта.

---

## 4.3. Discount Optimizer — максимальна персональна вигода

### Ідея

Користувач хоче не просто бачити акції, а отримувати відповідь:

> Яким способом мені зараз купити цей товар або цей кошик максимально вигідно?

### Дані через MCP

Потрібно аналізувати доступні конкретному користувачу:

- магазинні promotions;
- персональні coupons;
- coupon details;
- персональні promo;
- promo codes;
- loyalty / балобонуси;
- certificates;
- Premium;
- cart;
- можливі payment-related поля, якщо вони є у schema.

### Орієнтовний flow

```text
Current cart
    ↓
store promotions
    +
personal coupons
    +
personal promos
    +
promo codes
    +
loyalty balance
    +
certificates
    +
Premium
    ↓
DiscountOptimizer
    ↓
найвигідніший допустимий сценарій
```

Приклад:

```text
Кошик: 1 438 грн

Доступно:
- персональний купон: -72 грн
- промо: -48 грн
- балобонуси: -110 грн
- сертифікат: -200 грн

Оптимальний сценарій:
1. Активувати купон X
2. Застосувати промокод Y
3. Списати доступні балобонуси
4. Використати сертифікат

Фінальна ефективна вартість:
1 008 грн
```

Якщо MCP дозволяє виконати відповідну write-операцію, після підтвердження користувача система може застосувати її через MCP.

### Власний Рахунок та Банк Власний Рахунок

Потрібно розділяти:

```text
1. Програма лояльності "Власний Рахунок"
2. Банк Власний Рахунок
```

MCP покриває персональні loyalty-дані, купони, promotions, балобонуси та інші доступні механіки «Сільпо».

Окремі банківські вигоди можуть не мати спеціального MCP tool.

Тому архітектурно:

```text
DiscountOptimizer
├── SilpoMcpDiscountProvider
└── BankVlasnyiRakhunokRulesProvider
```

`BankVlasnyiRakhunokRulesProvider` у майбутньому може працювати з офіційними публічними правилами/акціями банку.

Не робимо припущень типу «зроби X і гарантовано отримаєш купон».

Результати треба розділяти, наприклад:

```text
Available now
Potentially obtainable
Not applicable
```

---

## 5. Персоналізація через MCP

Кожен користувач підключає власний акаунт «Сільпо».

Ми не розраховуємо на окремий глобальний admin/service-account MCP-доступ, доки «Сільпо» явно не надасть такий сценарій.

Через токен конкретного користувача можемо отримувати його персональний контекст:

- favorites;
- cart;
- coupons;
- promos;
- bonuses;
- certificates;
- online orders;
- offline orders;
- profile;
- інші доступні персональні дані.

Наш сервіс додає поверх цього власні дані:

- price history;
- tracked products;
- Product Score;
- preferences;
- notification settings;
- discount calculations.

Таким чином продукт є персоналізованим розширенням «Сільпо», а не незалежною копією їхньої системи.

---

## 6. Deduplication MCP-запитів

Для неперсональних даних, таких як базова ціна товару в конкретному branch, бажано уникати дублювання.

Наприклад:

```text
user A ─┐
user B ─┼─→ Product X @ Branch 123
user C ─┘
              ↓
        один tracking object
```

Якщо ціна `product + branch` підтвердиться як однакова для всіх користувачів, один успішний MCP-check можна використовувати для всіх subscriptions.

Це треба підтвердити експериментально після отримання реального MCP schema та доступу.

Персональні дані завжди отримуємо від імені конкретного користувача.

---

## 7. MCP abstraction

MCP не повинен бути жорстко прошитий у всю бізнес-логіку.

Створюємо provider interface:

```text
interface CommerceProvider {
  getProduct(...): Promise<Product>;
  getPrice(...): Promise<Price>;
  getPromotions(...): Promise<Promotion[]>;
}
```

Поточна реалізація:

```text
SilpoMcpProvider
```

Архітектура:

```text
PriceTracker
ProductService
DiscountOptimizer
        ↓
CommerceProvider
        ↓
SilpoMcpProvider
        ↓
Official Silpo MCP
```

У майбутньому це дозволить додати:

```text
AtbProvider
VarusProvider
NovusProvider
```

без переписування core logic.

Для хакатону реалізуємо тільки офіційний MCP «Сільпо».

---

## 8. Agentic scenario

Основна система максимально deterministic.

Не використовуємо LLM там, де звичайний алгоритм дає точний, передбачуваний та відтворюваний результат.

### Без LLM:

- Product Score;
- price tracking;
- price history;
- notifications;
- discount calculation;
- barcode resolution;
- filtering.

Agentic scenario можна трактувати як:

```text
goal
→ context
→ tools
→ decisions
→ multiple actions
→ result
```

Наприклад:

```text
Goal:
"Знайти максимально вигідний сценарій для поточного кошика"

        ↓
отримати cart через MCP
        ↓
отримати coupons
        ↓
отримати promos
        ↓
отримати loyalty
        ↓
отримати certificates
        ↓
наш DiscountOptimizer
        ↓
показати найкращу комбінацію
        ↓
за підтвердженням виконати MCP write action
```

Це робочий багатокроковий MCP-сценарій.

LLM у runtime не є основою проєкту.

За потреби можна додати мінімальний AI-layer для інтерпретації natural-language intent, але core business logic залишається deterministic.

AI переважно використовується під час research та розробки алгоритмів.

---

## 9. Технологічний стек

### Frontend

```text
React 19 (Vite SPA)
TypeScript
Mobile-first responsive UI
Telegram Mini App support
Vitest — тестування frontend
```

React-застосунок використовується і в Telegram Mini App, і як звичайний mobile web. Next.js свідомо не використовується: SSR/SEO не потрібні для авторизованого mini app, а окрема NestJS-структура (модулі, DI, guards, scheduler) вже продумана під backend і не переноситься в Next.js API routes.

### Backend

```text
NestJS
TypeScript
Node.js 24 LTS
Jest — тестування backend (NestJS default)
```

Архітектура:

```text
modular monolith
```

Не використовуємо microservices для MVP.

Орієнтовна структура:

```text
src/
├── auth/
├── users/
├── silpo/
│   ├── silpo.module.ts
│   ├── silpo.service.ts
│   └── providers/
│       └── silpo-mcp.provider.ts
├── products/
├── barcode/
├── product-score/
├── price-tracking/
├── discounts/
├── favorites/
├── notifications/
├── agent/
└── database/
```

### Database

```text
PostgreSQL 18 — локально, у Docker (розробка)
Aiven PostgreSQL 18 — production
Prisma ORM
```

MongoDB не потрібна.

PostgreSQL добре підходить для:

- реляційної моделі;
- price history;
- агрегатів;
- filtering;
- scheduler queue через `FOR UPDATE SKIP LOCKED`;
- невеликого server instance.

Prisma використовується як основний ORM/schema-migration інструмент. Для scheduler-запиту з `FOR UPDATE SKIP LOCKED` (Prisma не підтримує це нативно в query builder) використовується `$queryRaw`.

### Cache

```text
Redis 8
```

Redis використовується виключно як cache-шар:

- кешування MCP-відповідей (product details, каталог) з TTL — знижує навантаження на Silpo MCP та ризик rate limit;
- rate-limit лічильники per-user для MCP-запитів.

Redis **не** використовується як job queue (без BullMQ) і не замінює Postgres-based scheduler.

### Infrastructure

Для MVP:

```text
React
   ↓
NestJS
   ↓
Aiven PostgreSQL 18 + Redis 8 (cache)
   ↓
Silpo MCP
```

Без BullMQ.

Без Kafka.

Без microservices.

Система повинна запускатися на маленькому instance.

### Local development

Повна контейнеризація через Docker Compose — усі сервіси піднімаються локально однією командою:

```text
docker-compose.yml
├── postgres   (PostgreSQL 18)
├── redis      (Redis 8)
├── backend    (NestJS, hot-reload через volume)
└── frontend   (React/Vite, hot-reload через volume)
```

`Makefile` — обгортка над `docker compose` для типових команд розробки (підняти/зупинити оточення, дивитись логи, застосувати Prisma-міграції, засіяти тестові дані, прогнати тести). Точний список цілей `Makefile` фіксується під час bootstrap-етапу проєкту.

---

## 10. Базова архітектура

```text
Telegram Mini App / Mobile Web
              │
              ▼
            React
              │
              ▼
            NestJS
              │
     ┌────────┼───────────────┐
     │        │               │
     ▼        ▼               ▼
Product    Price           Discount
Score      Tracker         Optimizer
     │        │               │
     └────────┼───────────────┘
              │
              ▼
       CommerceProvider
              │
              ▼
       SilpoMcpProvider ◄──► Redis 8 (cache MCP-відповідей, rate-limit)
              │
              ▼
        Official Silpo MCP

              │
              ▼
      Aiven PostgreSQL 18
```

---

## 11. Що треба перевірити одразу після отримання MCP-доступу

### 1. Product schema

Через `tools/list` перевірити:

- чи є EAN/barcode у product;
- точний product id;
- price fields;
- promotion price;
- availability;
- stock;
- category;
- branch-specific fields;
- ingredients;
- nutrition;
- attributes.

### 2. Barcode lookup

Перевірити, чи можна:

```text
EAN → product
```

напряму через MCP.

Якщо ні — реалізувати власний mapping / resolver.

### 3. Price behavior

Перевірити:

- чи однакова базова ціна для двох користувачів у тому самому branch;
- чи є персональні ціни;
- як promotion впливає на product price;
- як часто змінюються ціни;
- чи можна batch-fetch кілька tracked products.

### 4. Rate limits

Експериментально визначити:

- реальний per-user rate limit;
- допустиму частоту polling;
- batch limit;
- поведінку `429`;
- retry/backoff.

### 5. OAuth

Перевірити:

- access token lifetime;
- refresh token behavior;
- refresh token rotation;
- чи повертається refresh token expiry;
- поведінку після revoke/invalid token.

### 6. Discount MCP tools

Перевірити точні schema для:

- coupons;
- coupon details;
- promos;
- promo codes;
- loyalty;
- certificates;
- Premium;
- cart;
- write actions.

### 7. Банківські вигоди

Окремо перевірити, чи MCP повертає щось про:

```text
Банк Власний Рахунок
```

Якщо ні — додати окремий provider пізніше.

---

## 12. MVP для хакатону

### Must have

1. Silpo OAuth login.
2. Telegram Mini App / mobile web.
3. Product search.
4. Product details через MCP.
5. Product Score 0–100.
6. Мінімальний rating filter.
7. Вибір branch.
8. `Track price`.
9. Price history.
10. Price-drop notification.
11. Discount Optimizer.
12. Мінімум один реальний multi-step MCP workflow.
13. Demo, де видно MCP tool calls / JSON-RPC traces.
14. Tokens тільки server-side.

### Nice to have

- barcode scanner;
- price chart;
- natural-language shopping query;
- Telegram notifications;
- bank benefits;
- purchase-frequency recommendations;
- рекомендація кількості товару при історично низькій ціні.

---

## 13. Можливе майбутнє після хакатону

Після MVP сервіс можна розширити до повноцінного Shopping Optimizer:

```text
Silpo
ATB
VARUS
NOVUS
...
```

Тоді система зможе:

- порівнювати один SKU між мережами;
- матчити товари через barcode/EAN;
- оптимізувати весь shopping list;
- враховувати маршрут;
- порівнювати економію з додатковим часом/відстанню;
- рекомендувати, де купити кожну частину кошика;
- відстежувати ціни між мережами.

Для хакатону цей scope не реалізовуємо — архітектуру лише не блокуємо для такого розвитку.

---

## 14. Короткий pitch

> Веб-сервіс і Telegram Mini App, який через персональний MCP-доступ до акаунта «Сільпо» допомагає користувачу обирати кращі товари та купувати їх у найвигідніший момент. Сервіс формує власний рейтинг якості продуктів, накопичує історію цін у вибраному магазині та аналізує персональні акції, купони, балобонуси й додаткові вигоди способів оплати, щоб показати максимально вигідний сценарій покупки.
