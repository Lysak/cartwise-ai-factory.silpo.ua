import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { createClient } from 'redis';

const INACTIVITY_TTL_SECONDS = 30 * 24 * 60 * 60;
const ABSOLUTE_TTL_SECONDS = 90 * 24 * 60 * 60;

export type SessionRecord = {
  userId: string;
  telegramUserId: string | null;
  issuedAt: string;
  absoluteExpiresAt: string;
  csrfSecret: string;
};

export type RedisSessionStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  expire(key: string, seconds: number): Promise<number>;
  incr(key: string): Promise<number>;
  del(key: string): Promise<number>;
  connect?(): Promise<unknown>;
  quit?(): Promise<unknown>;
  isOpen?: boolean;
};

type CreateSessionInput = Pick<SessionRecord, 'userId' | 'telegramUserId'>;

export const sessionCookieName = (): string =>
  process.env.SESSION_COOKIE_INSECURE === 'true' ? 'cartwise_session' : '__Host-cartwise_session';

export const sessionCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.SESSION_COOKIE_INSECURE !== 'true',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: INACTIVITY_TTL_SECONDS * 1000
});

@Injectable()
export class SessionService implements OnModuleInit, OnModuleDestroy {
  private readonly redis: RedisSessionStore;

  constructor(@Optional() redis?: RedisSessionStore) {
    this.redis = redis ?? (createClient({ url: process.env.REDIS_URL }) as unknown as RedisSessionStore);
  }

  async onModuleInit(): Promise<void> {
    if (!this.redis.isOpen) await this.redis.connect?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.isOpen) await this.redis.quit?.();
  }

  async create(input: CreateSessionInput): Promise<{ id: string; csrfToken: string }> {
    const id = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const issuedAt = new Date();
    const absoluteExpiresAt = new Date(issuedAt.getTime() + ABSOLUTE_TTL_SECONDS * 1000);
    const record: SessionRecord = {
      ...input,
      issuedAt: issuedAt.toISOString(),
      absoluteExpiresAt: absoluteExpiresAt.toISOString(),
      csrfSecret: csrfToken
    };

    await this.redis.set(this.keyFor(id), JSON.stringify(record), { EX: INACTIVITY_TTL_SECONDS });
    return { id, csrfToken };
  }

  async rotate(previousId: string, input: CreateSessionInput): Promise<{ id: string; csrfToken: string }> {
    await this.destroy(previousId);
    return this.create(input);
  }

  async rotateHash(previousHash: string, input: CreateSessionInput): Promise<{ id: string; csrfToken: string } | null> {
    if (!await this.redis.del(this.keyForHash(previousHash))) return null;
    return this.create(input);
  }

  async resolve(id: string): Promise<SessionRecord | null> {
    return this.resolveKey(this.keyFor(id));
  }

  async resolveHash(hash: string): Promise<SessionRecord | null> {
    return this.resolveKey(this.keyForHash(hash));
  }

  private async resolveKey(key: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;

    let record: SessionRecord;
    try {
      record = JSON.parse(raw) as SessionRecord;
    } catch {
      await this.redis.del(key);
      return null;
    }

    const absoluteExpiresAt = new Date(record.absoluteExpiresAt).getTime();
    const remainingSeconds = Math.ceil((absoluteExpiresAt - Date.now()) / 1000);
    if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) {
      await this.redis.del(key);
      return null;
    }

    if (!await this.redis.expire(key, Math.min(INACTIVITY_TTL_SECONDS, remainingSeconds))) return null;
    return record;
  }

  async destroy(id: string): Promise<void> {
    await this.redis.del(this.keyFor(id));
  }

  async incrementRateLimit(key: string, seconds: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, seconds);
    return count;
  }

  private keyFor(id: string): string {
    return this.keyForHash(createHash('sha256').update(id).digest('base64url'));
  }

  private keyForHash(hash: string): string {
    return `session:${hash}`;
  }
}
