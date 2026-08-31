import { Cron, CronExpression } from '@nestjs/schedule';
import { HttpException, Injectable, Optional } from '@nestjs/common';
import { Pool } from 'pg';
import { Prisma } from '../generated/prisma/client';
import { SilpoConnectionService } from '../silpo/silpo-connection.service';
import { SilpoOauthService } from '../silpo/silpo-oauth.service';
import { calculatePriceIntelligence, type PriceObservation } from './price-intelligence';
import { TelegramNotificationService, type TelegramNotificationPayload } from './telegram-notification.service';

export const TRACKING_INTERVAL_MS = 4 * 60 * 60 * 1000;
const MAX_TRACKERS = 20;
const MAX_BACKOFF_EXPONENT = 6;

type QueryResult<T> = { rows: T[] };
type Queryable = { query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<T>> };
type Transaction = Queryable & { release(): void };
type PoolLike = Queryable & { connect(): Promise<Transaction> };

type TrackerRow = {
  id: string;
  externalProductId: string;
  slug: string;
  name: string;
  branchId: string;
  currentPrice: string | number | null;
  failedAttempts: number;
};

type ProductRow = Record<string, unknown>;

class PollerFailure extends Error {
  constructor(readonly reason: 'no_match' | 'no_price' | 'rate_limited' | 'provider_error') {
    super(reason);
  }
}

@Injectable()
export class PricePollerService {
  private readonly pool: PoolLike;

  constructor(
    private readonly connections: SilpoConnectionService,
    private readonly oauth: SilpoOauthService,
    @Optional() pool?: PoolLike,
    @Optional() private readonly telegram: TelegramNotificationService = new TelegramNotificationService()
  ) {
    this.pool = pool ?? new Pool({ connectionString: process.env.DATABASE_URL });
  }

  // ponytail: one in-process scheduler; move to a worker only after multiple replicas or measured job contention.
  @Cron(CronExpression.EVERY_HOUR)
  async pollDueTrackers(): Promise<void> {
    const trackers = await this.claimDueTrackers();
    for (const tracker of trackers) await this.pollTracker(tracker);
  }

  private async claimDueTrackers(): Promise<TrackerRow[]> {
    const database = await this.pool.connect();
    let committed = false;
    try {
      await database.query('BEGIN');
      const result = await database.query<TrackerRow>(
        `WITH due AS (
          SELECT "id"
            FROM "PriceTracker"
           WHERE "status" = 'active'
             AND ("nextCheckAt" IS NULL OR "nextCheckAt" <= NOW())
           ORDER BY "nextCheckAt" NULLS FIRST, "id"
           LIMIT ${MAX_TRACKERS}
           FOR UPDATE SKIP LOCKED
        )
        UPDATE "PriceTracker" AS tracker
           SET "nextCheckAt" = NOW() + ($1 * INTERVAL '1 millisecond'), "updatedAt" = NOW()
          FROM due
         WHERE tracker."id" = due."id"
        RETURNING tracker."id", tracker."silpoExternalProductId" AS "externalProductId", tracker."slug",
                  tracker."name", tracker."silpoBranchId" AS "branchId", tracker."currentPrice", tracker."failedAttempts"`,
        [TRACKING_INTERVAL_MS]
      );
      await database.query('COMMIT');
      committed = true;
      return result.rows;
    } catch (error) {
      if (!committed) await database.query('ROLLBACK');
      throw error;
    } finally {
      database.release();
    }
  }

  private async pollTracker(claimed: TrackerRow): Promise<void> {
    let pendingTelegramSends: { chatId: string | null; payload: TelegramNotificationPayload }[];
    try {
      const payload = await this.lookup(claimed);
      const row = findProduct(payload, claimed);
      if (!row) throw new PollerFailure('no_match');
      const price = decimalPrice(row.price);
      if (!price) throw new PollerFailure('no_price');
      pendingTelegramSends = await this.persistPrice(claimed.id, price);
    } catch (error) {
      await this.persistFailure(claimed.id, failureReason(error));
      return;
    }
    // Deliberately outside the price-poll try/catch above: a Telegram-side
    // problem must never be recorded as a price-poll failure/backoff, and
    // TelegramNotificationService.send() already fails closed internally.
    for (const { chatId, payload: notification } of pendingTelegramSends) await this.telegram.send(chatId, notification);
  }

  private lookup(tracker: TrackerRow): Promise<Record<string, unknown>> {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 1);
    start.setUTCHours(12, 0, 0, 0);
    const context = {
      branchId: tracker.branchId,
      deliveryType: 'SelfPickup',
      timeslotStart: start.toISOString(),
      timeslotEnd: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
      products: [tracker.externalProductId],
      limit: 1
    };
    return this.connections.withTrackingReadAccess((token) =>
      this.oauth.callSilpoTool(token, 'silpo_find_products_batch', context, `cartwise-price-tracking-${tracker.id}`)
    );
  }

  private async persistPrice(
    trackerId: string,
    price: Prisma.Decimal
  ): Promise<{ chatId: string | null; payload: TelegramNotificationPayload }[]> {
    const database = await this.pool.connect();
    let committed = false;
    try {
      await database.query('BEGIN');
      const current = (await database.query<TrackerRow>(
        `SELECT "id", "silpoExternalProductId" AS "externalProductId", "slug", "name",
                "silpoBranchId" AS "branchId", "currentPrice", "failedAttempts"
           FROM "PriceTracker" WHERE "id" = $1 AND "status" = 'active' FOR UPDATE`,
        [trackerId]
      )).rows[0];
      if (!current) {
        await database.query('COMMIT');
        committed = true;
        return [];
      }

      const oldPrice = decimalPrice(current.currentPrice);
      const now = new Date();
      const nextCheckAt = new Date(now.getTime() + TRACKING_INTERVAL_MS);
      if (oldPrice?.eq(price)) {
        await database.query(
          `UPDATE "PriceTracker"
              SET "lastCheckedAt" = $2, "nextCheckAt" = $3, "lastSuccessAt" = $2,
                  "failedAttempts" = 0, "lastError" = NULL, "updatedAt" = NOW()
            WHERE "id" = $1 AND "status" = 'active'`,
          [trackerId, now, nextCheckAt]
        );
        await database.query('COMMIT');
        committed = true;
        return [];
      }

      const history = (await database.query<{ price: string | number; observedAt: Date }>(
        `SELECT "price", "observedAt" FROM "PriceObservation"
          WHERE "priceTrackerId" = $1 ORDER BY "observedAt"`,
        [trackerId]
      )).rows
        .map((observation): PriceObservation | null => {
          const observationPrice = decimalPrice(observation.price);
          return observationPrice ? { price: observationPrice, observedAt: new Date(observation.observedAt) } : null;
        })
        .filter((observation): observation is PriceObservation => observation !== null);
      const intelligence = calculatePriceIntelligence([...history, { price, observedAt: now }], now);

      await database.query(
        `INSERT INTO "PriceObservation" ("priceTrackerId", "price", "oldPrice", "observedAt")
         VALUES ($1, $2, $3, $4)`,
        [trackerId, price.toString(), oldPrice?.toString() ?? null, now]
      );
      await database.query(
        `UPDATE "PriceTracker"
            SET "currentPrice" = $2, "lastCheckedAt" = $3, "nextCheckAt" = $4,
                "lastSuccessAt" = $3, "failedAttempts" = 0, "lastError" = NULL, "updatedAt" = NOW()
          WHERE "id" = $1 AND "status" = 'active'`,
        [trackerId, price.toString(), now, nextCheckAt]
      );

      const eventTypes = intelligence.eventTypes.length > 0
        ? intelligence.eventTypes
        : oldPrice && price.lt(oldPrice)
          ? ['price_drop' as const]
          : [];
      const pendingTelegramSends: { chatId: string | null; payload: TelegramNotificationPayload }[] = [];
      if (oldPrice && eventTypes.length > 0) {
        const subscriptions = (await database.query<{ userId: string; telegramUserId: string | null }>(
          `SELECT s."userId", u."telegramUserId"
             FROM "PriceSubscription" s
             JOIN "User" u ON u."id" = s."userId"
            WHERE s."priceTrackerId" = $1`,
          [trackerId]
        )).rows;
        const messagePayload: TelegramNotificationPayload = {
          type: eventTypes[0],
          product: { name: current.name, slug: current.slug, externalProductId: current.externalProductId },
          price: price.toString(),
          oldPrice: oldPrice.toString()
        };
        for (const subscription of subscriptions) {
          await database.query(
            `INSERT INTO "NotificationEvent" ("userId", "priceTrackerId", "type", "payload")
             VALUES ($1, $2, $3, $4)`,
            [subscription.userId, trackerId, eventTypes[0], JSON.stringify({ price: price.toString(), oldPrice: oldPrice.toString(), eventTypes })]
          );
          pendingTelegramSends.push({ chatId: subscription.telegramUserId, payload: messagePayload });
        }
      }
      await database.query('COMMIT');
      committed = true;
      return pendingTelegramSends;
    } catch (error) {
      if (!committed) await database.query('ROLLBACK');
      throw error;
    } finally {
      database.release();
    }
  }

  private async persistFailure(trackerId: string, reason: PollerFailure['reason']): Promise<void> {
    const database = await this.pool.connect();
    let committed = false;
    try {
      await database.query('BEGIN');
      const current = (await database.query<{ failedAttempts: number }>(
        `SELECT "failedAttempts" FROM "PriceTracker"
          WHERE "id" = $1 AND "status" = 'active' FOR UPDATE`,
        [trackerId]
      )).rows[0];
      if (!current) {
        await database.query('COMMIT');
        committed = true;
        return;
      }
      const now = new Date();
      const exponent = Math.min(current.failedAttempts + 1, MAX_BACKOFF_EXPONENT);
      const nextCheckAt = new Date(now.getTime() + TRACKING_INTERVAL_MS * 2 ** exponent);
      await database.query(
        `UPDATE "PriceTracker"
            SET "lastCheckedAt" = $2, "nextCheckAt" = $3,
                "failedAttempts" = "failedAttempts" + 1, "lastError" = $4, "updatedAt" = NOW()
          WHERE "id" = $1 AND "status" = 'active'`,
        [trackerId, now, nextCheckAt, reason]
      );
      await database.query('COMMIT');
      committed = true;
    } catch (error) {
      if (!committed) await database.query('ROLLBACK');
      throw error;
    } finally {
      database.release();
    }
  }
}

const findProduct = (payload: Record<string, unknown>, tracker: TrackerRow): ProductRow | null => {
  const direct = records(payload.products);
  const queried = records(payload.queries).flatMap((query) => records(query.products));
  const products = direct.length > 0 ? direct : queried;
  return products.find((product) =>
    text(product.externalProductId ?? product.silpoExternalProductId) === tracker.externalProductId
    && text(product.slug) === tracker.slug
    && text(product.branchId ?? product.silpoBranchId) === tracker.branchId
  ) ?? null;
};

const records = (value: unknown): ProductRow[] =>
  Array.isArray(value)
    ? value.filter((row): row is ProductRow => typeof row === 'object' && row !== null && !Array.isArray(row))
    : [];

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;

const decimalPrice = (value: unknown): Prisma.Decimal | null => {
  const source = typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
  if (!source || !/^\d+(?:\.\d{1,2})?$/.test(source)) return null;
  try {
    const decimal = new Prisma.Decimal(source);
    return decimal.isFinite() && !decimal.isNegative() ? decimal : null;
  } catch {
    return null;
  }
};

const failureReason = (error: unknown): PollerFailure['reason'] => {
  if (error instanceof PollerFailure) return error.reason;
  if (isRateLimited(error)) return 'rate_limited';
  return 'provider_error';
};

const isRateLimited = (error: unknown): boolean => {
  if (error instanceof HttpException && error.getStatus() === 429) return true;
  if (typeof error !== 'object' || error === null) return false;
  const row = error as { status?: unknown; response?: { status?: unknown } };
  return row.status === 429 || row.response?.status === 429 || (error instanceof Error && /429|rate.?limit/i.test(error.message));
};
