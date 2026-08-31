import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Pool } from 'pg';
import { StoreContextService } from '../catalog/store-context.service';
import { SilpoProductService } from '../silpo/silpo-product.service';

type QueryResult<T> = { rows: T[] };
type Queryable = { query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<T>> };
type Transaction = Queryable & { release(): void };
type PoolLike = Queryable & { connect(): Promise<Transaction> };

export type TrackingItem = {
  id: string;
  trackerId: string;
  externalProductId: string;
  slug: string;
  name: string;
  imageUrl: string | null;
  branchId: string;
  status: 'active' | 'disabled';
  currentPrice: string | null;
};

export type NotificationItem = {
  id: string;
  type: string;
  product: { name: string; slug: string; externalProductId: string };
  price: string | null;
  oldPrice: string | null;
  createdAt: Date;
  readAt: Date | null;
};

export type HistoryItem = {
  price: string | null;
  oldPrice: string | null;
  observedAt: Date;
};

type ProductIdentity = {
  externalProductId: string;
  slug: string;
  name: string;
  imageUrl: string | null;
};

type TrackingRow = {
  id: string;
  trackerId: string;
  externalProductId: string;
  slug: string;
  name: string;
  imageUrl: string | null;
  branchId: string;
  status: string;
  currentPrice: string | number | null;
};

type NotificationRow = {
  id: string;
  type: string;
  name: string;
  slug: string;
  externalProductId: string;
  payload: unknown;
  createdAt: Date;
  readAt: Date | null;
};

type ObservationRow = {
  price: string | number;
  oldPrice: string | number | null;
  observedAt: Date;
};

@Injectable()
export class TrackingService {
  private readonly pool: PoolLike;

  constructor(
    private readonly context: StoreContextService,
    private readonly products: SilpoProductService,
    @Optional() pool?: PoolLike
  ) {
    this.pool = pool ?? new Pool({ connectionString: process.env.DATABASE_URL });
  }

  async heart(userId: string, raw: unknown): Promise<TrackingItem> {
    const product = parseProductIdentity(raw);
    const store = await this.context.resolveStoreContext(userId);
    const branchId = typeof store.branchId === 'string' && store.branchId ? store.branchId : null;
    if (!branchId) throw new BadRequestException('Selected branch required');
    const verified = await this.products.searchProducts(userId, { q: product.externalProductId, limit: 100 });
    const matchedProduct = verified.products.find((candidate) =>
      candidate.externalProductId === product.externalProductId
      && candidate.slug === product.slug
      && candidate.name === product.name
    );
    if (!matchedProduct) throw new BadRequestException('Invalid product');
    const initialPrice = providerPrice(matchedProduct.price);

    const database = await this.pool.connect();
    try {
      await database.query('BEGIN');
      await database.query(
        `INSERT INTO "PriceTracker"
          ("silpoExternalProductId", "slug", "name", "imageUrl", "silpoBranchId", "status", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 'active', NOW())
         ON CONFLICT ("silpoExternalProductId", "silpoBranchId")
         DO UPDATE SET "status" = 'active', "imageUrl" = COALESCE(EXCLUDED."imageUrl", "PriceTracker"."imageUrl"), "updatedAt" = NOW()`,
        [product.externalProductId, product.slug, product.name, product.imageUrl, branchId]
      );
      const tracker = (await database.query<{ id: string; currentPrice: string | number | null }>(
        `SELECT "id", "currentPrice" FROM "PriceTracker"
          WHERE "silpoExternalProductId" = $1 AND "silpoBranchId" = $2
          FOR UPDATE`,
        [product.externalProductId, branchId]
      )).rows[0];
      if (!tracker) throw new Error('Tracking row unavailable');

      if (initialPrice !== null && tracker.currentPrice === null) {
        const observedAt = new Date();
        await database.query(
          `INSERT INTO "PriceObservation" ("priceTrackerId", "price", "oldPrice", "observedAt")
           VALUES ($1, $2, NULL, $3)`,
          [tracker.id, initialPrice, observedAt]
        );
        await database.query(
          `UPDATE "PriceTracker" SET "currentPrice" = $2, "updatedAt" = NOW()
            WHERE "id" = $1`,
          [tracker.id, initialPrice]
        );
      }

      // A user tracks a product at whichever branch they are currently shopping;
      // switching branches must move their existing subscription, not add a
      // second one, or the same product renders twice in "Відстежувані товари".
      const moved = await database.query<{ trackerId: string }>(
        `DELETE FROM "PriceSubscription" s
          USING "PriceTracker" t
          WHERE s."priceTrackerId" = t."id"
            AND s."userId" = $1
            AND t."silpoExternalProductId" = $2
            AND t."id" != $3
          RETURNING t."id" AS "trackerId"`,
        [userId, product.externalProductId, tracker.id]
      );
      for (const previous of moved.rows) {
        await database.query(
          `UPDATE "PriceTracker" SET "status" = 'disabled', "updatedAt" = NOW()
            WHERE "id" = $1
              AND NOT EXISTS (SELECT 1 FROM "PriceSubscription" WHERE "priceTrackerId" = $1)`,
          [previous.trackerId]
        );
      }

      await database.query(
        `INSERT INTO "PriceSubscription" ("userId", "priceTrackerId")
         VALUES ($1, $2)
         ON CONFLICT ("userId", "priceTrackerId") DO NOTHING`,
        [userId, tracker.id]
      );
      const row = (await database.query<TrackingRow>(
        `SELECT s."id", t."id" AS "trackerId", t."silpoExternalProductId" AS "externalProductId",
                t."slug", t."name", t."imageUrl", t."silpoBranchId" AS "branchId", t."status", t."currentPrice"
           FROM "PriceSubscription" s
           JOIN "PriceTracker" t ON t."id" = s."priceTrackerId"
          WHERE s."userId" = $1 AND s."priceTrackerId" = $2`,
        [userId, tracker.id]
      )).rows[0];
      if (!row) throw new Error('Subscription row unavailable');
      await database.query('COMMIT');
      return sanitize(row);
    } catch (error) {
      await database.query('ROLLBACK');
      throw error;
    } finally {
      database.release();
    }
  }

  async unheart(userId: string, subscriptionId: string): Promise<{ status: 'untracked' }> {
    if (!validId(subscriptionId)) throw new BadRequestException('Invalid tracking id');
    const database = await this.pool.connect();
    try {
      await database.query('BEGIN');
      const deleted = (await database.query<{ trackerId: string }>(
        `DELETE FROM "PriceSubscription"
          WHERE "id" = $1 AND "userId" = $2
          RETURNING "priceTrackerId" AS "trackerId"`,
        [subscriptionId, userId]
      )).rows[0];
      if (!deleted) {
        await database.query('ROLLBACK');
        throw new NotFoundException('Tracking subscription not found');
      }
      await database.query(
        `UPDATE "PriceTracker" SET "status" = 'disabled', "updatedAt" = NOW()
          WHERE "id" = $1
            AND NOT EXISTS (SELECT 1 FROM "PriceSubscription" WHERE "priceTrackerId" = $1)`,
        [deleted.trackerId]
      );
      await database.query('COMMIT');
      return { status: 'untracked' };
    } catch (error) {
      if (!isNotFound(error)) await database.query('ROLLBACK');
      throw error;
    } finally {
      database.release();
    }
  }

  async list(userId: string): Promise<{ items: TrackingItem[] }> {
    const result = await this.pool.query<TrackingRow>(
      `SELECT s."id", t."id" AS "trackerId", t."silpoExternalProductId" AS "externalProductId",
              t."slug", t."name", t."imageUrl", t."silpoBranchId" AS "branchId", t."status", t."currentPrice"
         FROM "PriceSubscription" s
         JOIN "PriceTracker" t ON t."id" = s."priceTrackerId"
        WHERE s."userId" = $1
        ORDER BY s."createdAt" DESC`,
      [userId]
    );
    return { items: result.rows.map(sanitize) };
  }

  async findSubscriptionId(userId: string, externalProductId: string): Promise<string | null> {
    const store = await this.context.resolveStoreContext(userId);
    const branchId = typeof store.branchId === 'string' && store.branchId ? store.branchId : null;
    if (!branchId) return null;
    const result = await this.pool.query<{ id: string }>(
      `SELECT s."id"
         FROM "PriceSubscription" s
         JOIN "PriceTracker" t ON t."id" = s."priceTrackerId"
        WHERE s."userId" = $1
          AND t."silpoExternalProductId" = $2
          AND t."silpoBranchId" = $3
          AND t."status" = 'active'
        LIMIT 1`,
      [userId, externalProductId, branchId]
    );
    return result.rows[0]?.id ?? null;
  }

  async updateImageUrl(userId: string, subscriptionId: string, imageUrl: string): Promise<void> {
    const safeImage = sanitizeImageUrl(imageUrl);
    if (!safeImage || !validId(subscriptionId)) return;
    await this.pool.query(
      `UPDATE "PriceTracker" t
          SET "imageUrl" = $3, "updatedAt" = NOW()
         FROM "PriceSubscription" s
        WHERE s."id" = $1
          AND s."userId" = $2
          AND t."id" = s."priceTrackerId"
          AND t."imageUrl" IS DISTINCT FROM $3`,
      [subscriptionId, userId, safeImage]
    );
  }

  async backfillInitialPrice(userId: string, subscriptionId: string, rawPrice: number): Promise<void> {
    const price = providerPrice(rawPrice);
    if (price === null || !validId(subscriptionId)) return;
    const database = await this.pool.connect();
    let committed = false;
    try {
      await database.query('BEGIN');
      const tracker = (await database.query<{ id: string }>(
        `UPDATE "PriceTracker" t
            SET "currentPrice" = $3, "updatedAt" = NOW()
           FROM "PriceSubscription" s
          WHERE s."id" = $1 AND s."userId" = $2
            AND t."id" = s."priceTrackerId" AND t."currentPrice" IS NULL
          RETURNING t."id"`,
        [subscriptionId, userId, price]
      )).rows[0];
      if (tracker) {
        await database.query(
          `INSERT INTO "PriceObservation" ("priceTrackerId", "price", "oldPrice", "observedAt")
           VALUES ($1, $2, NULL, $3)`,
          [tracker.id, price, new Date()]
        );
      }
      await database.query('COMMIT');
      committed = true;
    } catch (error) {
      if (!committed) await database.query('ROLLBACK');
      throw error;
    } finally {
      database.release();
    }
  }

  async notifications(userId: string): Promise<{ items: NotificationItem[] }> {
    const result = await this.pool.query<NotificationRow>(
      `SELECT e."id", e."type", t."name", t."slug",
              t."silpoExternalProductId" AS "externalProductId", e."payload", e."createdAt", e."readAt"
         FROM "NotificationEvent" e
         JOIN "PriceTracker" t ON t."id" = e."priceTrackerId"
        WHERE e."userId" = $1
        ORDER BY e."createdAt" DESC`,
      [userId]
    );
    return { items: result.rows.map(sanitizeNotification) };
  }

  async readNotification(userId: string, notificationId: string): Promise<{ status: 'read' }> {
    const result = await this.pool.query<{ id: string }>(
      `UPDATE "NotificationEvent"
          SET "readAt" = NOW()
        WHERE "id" = $1 AND "userId" = $2 AND "readAt" IS NULL
        RETURNING "id"`,
      [notificationId, userId]
    );
    if (!result.rows[0]) throw new NotFoundException('Notification not found');
    return { status: 'read' };
  }

  async history(userId: string, subscriptionId: string): Promise<{ items: HistoryItem[] }> {
    const subscription = (await this.pool.query<{ trackerId: string }>(
      `SELECT "priceTrackerId" AS "trackerId"
         FROM "PriceSubscription"
        WHERE "id" = $1 AND "userId" = $2`,
      [subscriptionId, userId]
    )).rows[0];
    if (!subscription) throw new NotFoundException('Tracking subscription not found');

    const result = await this.pool.query<ObservationRow>(
      `SELECT "price", "oldPrice", "observedAt"
         FROM "PriceObservation"
        WHERE "priceTrackerId" = $1
        ORDER BY "observedAt" ASC`,
      [subscription.trackerId]
    );
    return { items: result.rows.map((row) => ({
      price: decimalString(row.price),
      oldPrice: decimalString(row.oldPrice),
      observedAt: row.observedAt
    })) };
  }
}

const parseProductIdentity = (raw: unknown): ProductIdentity => {
  if (!isRecord(raw)) throw new BadRequestException('Invalid product');
  if ('product' in raw && Object.keys(raw).some((key) => key !== 'product')) {
    throw new BadRequestException('Invalid product');
  }
  const source = 'product' in raw ? raw.product : raw;
  if (!isRecord(source)) throw new BadRequestException('Invalid product');
  const allowed = new Set(['externalProductId', 'silpoExternalProductId', 'slug', 'name', 'imageUrl']);
  if (Object.keys(source).some((key) => !allowed.has(key))) throw new BadRequestException('Invalid product');

  const externalProductId = source.externalProductId ?? source.silpoExternalProductId;
  if (!validText(externalProductId, 256) || !validText(source.slug, 256) || !validText(source.name, 512)) {
    throw new BadRequestException('Invalid product');
  }
  if (/\s|\//.test(source.slug as string)) throw new BadRequestException('Invalid product');
  return {
    externalProductId: externalProductId as string,
    slug: source.slug as string,
    name: source.name as string,
    imageUrl: validImageUrl(source.imageUrl) ? source.imageUrl : null
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validText = (value: unknown, maxLength: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;

const validImageUrl = (value: unknown): value is string => {
  if (value === undefined || value === null) return false;
  if (!validText(value, 2048)) throw new BadRequestException('Invalid product');
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    throw new BadRequestException('Invalid product');
  }
};

const validId = (value: unknown): value is string => validText(value, 256) && !/[\s/]/.test(value);

const providerPrice = (value: unknown): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const formatted = value.toFixed(2);
  return /^\d+(?:\.\d{2})$/.test(formatted) ? formatted : null;
};

const sanitize = (row: TrackingRow): TrackingItem => ({
  id: row.id,
  trackerId: row.trackerId,
  externalProductId: row.externalProductId,
  slug: row.slug,
  name: row.name,
  imageUrl: sanitizeImageUrl(row.imageUrl),
  branchId: row.branchId,
  status: row.status === 'disabled' ? 'disabled' : 'active',
  currentPrice: row.currentPrice === null ? null : String(row.currentPrice)
});

const sanitizeNotification = (row: NotificationRow): NotificationItem => {
  const payload = isRecord(row.payload) ? row.payload : {};
  return {
    id: row.id,
    type: row.type,
    product: { name: row.name, slug: row.slug, externalProductId: row.externalProductId },
    price: decimalString(payload.price),
    oldPrice: decimalString(payload.oldPrice),
    createdAt: row.createdAt,
    readAt: row.readAt
  };
};

const decimalString = (value: unknown): string | null =>
  typeof value === 'string' && /^\d+(?:\.\d{1,2})?$/.test(value.trim()) ? value.trim() : null;

const sanitizeImageUrl = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
};

const isNotFound = (error: unknown): boolean => error instanceof NotFoundException;
