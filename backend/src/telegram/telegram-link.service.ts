import { Injectable, Optional } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';

export type ConsumeResult = 'linked' | 'conflict' | 'invalid';

type Queryable = { query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> };

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505';

@Injectable()
export class TelegramLinkService {
  private readonly pool: Queryable;

  constructor(@Optional() pool?: Queryable) {
    this.pool = pool ?? new Pool({ connectionString: process.env.DATABASE_URL });
  }

  async createLink(userId: string): Promise<string> {
    // Mirrors OAuthState's sweep-on-issuance convention (silpo-oauth.service.ts)
    // so expired/consumed rows don't accumulate forever.
    await this.pool.query('DELETE FROM "TelegramLinkToken" WHERE "expiresAt" <= NOW()');
    const raw = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    await this.pool.query(
      'INSERT INTO "TelegramLinkToken" (id, "tokenHash", "userId", "expiresAt", "createdAt") VALUES (uuidv7(), $1, $2, NOW() + INTERVAL \'10 minutes\', NOW())',
      [tokenHash, userId]
    );
    return raw;
  }

  // Single-use: the UPDATE below marks the token consumed the moment it is
  // matched, whether or not the User update that follows succeeds — so a
  // chat-id conflict (caught below) never leaves the token replayable.
  async consume(rawToken: string, telegramUserId: string): Promise<ConsumeResult> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const consumed = await this.pool.query<{ userId: string }>(
      'UPDATE "TelegramLinkToken" SET "consumedAt" = NOW() WHERE "tokenHash" = $1 AND "consumedAt" IS NULL AND "expiresAt" > NOW() RETURNING "userId"',
      [tokenHash]
    );
    const userId = consumed.rows[0]?.userId;
    if (!userId) return 'invalid';

    try {
      // `AND "telegramUserId" IS NULL` closes the same "already connected"
      // window that TelegramLinkController.start guards at issuance time: two
      // tokens issued before either is consumed must not let a second,
      // different Telegram account silently overwrite the first link.
      const updated = await this.pool.query<{ id: string }>(
        'UPDATE "User" SET "telegramUserId" = $1, "updatedAt" = NOW() WHERE id = $2 AND "telegramUserId" IS NULL RETURNING id',
        [telegramUserId, userId]
      );
      return updated.rows.length > 0 ? 'linked' : 'conflict';
    } catch (error) {
      if (isUniqueViolation(error)) return 'conflict';
      throw error;
    }
  }
}
