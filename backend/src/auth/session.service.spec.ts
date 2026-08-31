import { sessionCookieName, sessionCookieOptions, SessionService, type RedisSessionStore } from './session.service';

class RedisDouble implements RedisSessionStore {
  readonly commands: string[] = [];
  private readonly values = new Map<string, string>();
  expireResult = 1;

  async get(key: string): Promise<string | null> {
    this.commands.push(`GET ${key}`);
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.commands.push(`SET ${key}`);
    this.values.set(key, value);
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.commands.push(`EXPIRE ${key} ${seconds}`);
    return this.expireResult;
  }

  async del(key: string): Promise<number> {
    this.commands.push(`DEL ${key}`);
    return this.values.delete(key) ? 1 : 0;
  }

  async incr(key: string): Promise<number> {
    const value = Number(this.values.get(key) ?? '0') + 1;
    this.values.set(key, String(value));
    this.commands.push(`INCR ${key}`);
    return value;
  }
}

describe('SessionService', () => {
  let redis: RedisDouble;
  let service: SessionService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-12T12:00:00.000Z'));
    redis = new RedisDouble();
    service = new SessionService(redis);
  });

  afterEach(() => jest.useRealTimers());

  it('uses a host-only secure cookie outside explicit local insecure mode', () => {
    delete process.env.SESSION_COOKIE_INSECURE;

    expect(sessionCookieName()).toBe('__Host-cartwise_session');
    expect(sessionCookieOptions()).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });
  });

  it('stores nullable Telegram metadata in the opaque session record', async () => {
    const created = await service.create({ userId: 'user-1', telegramUserId: null });
    const key = redis.commands[0].slice('SET '.length);
    const raw = await redis.get(key);

    expect(JSON.parse(raw!)).toMatchObject({ userId: 'user-1', telegramUserId: null });
    expect(created.id).toEqual(expect.any(String));
  });

  it('renews to thirty days but never beyond absolute expiry', async () => {
    const created = await service.create({ userId: 'user-1', telegramUserId: '123' });
    jest.setSystemTime(new Date('2026-11-09T12:00:00.000Z'));

    await expect(service.resolve(created.id)).resolves.toMatchObject({ userId: 'user-1' });

    expect(redis.commands.at(-1)).toMatch(/^EXPIRE .+ 86400$/);
  });

  it('does not recreate a deleted key when renewing', async () => {
    const created = await service.create({ userId: 'user-1', telegramUserId: '123' });
    redis.expireResult = 0;
    redis.commands.length = 0;

    await expect(service.resolve(created.id)).resolves.toBeNull();

    expect(redis.commands).toEqual([
      expect.stringMatching(/^GET /),
      expect.stringMatching(/^EXPIRE /)
    ]);
  });

  it('rotates by deleting the old hash key before writing the new key', async () => {
    const created = await service.create({ userId: 'user-1', telegramUserId: '123' });
    redis.commands.length = 0;

    const rotated = await service.rotate(created.id, { userId: 'user-1', telegramUserId: '123' });

    expect(redis.commands[0]).toMatch(/^DEL /);
    await expect(service.resolve(created.id)).resolves.toBeNull();
    await expect(service.resolve(rotated.id)).resolves.toMatchObject({ userId: 'user-1' });
  });

  it('resolves a stored session hash without hashing it again', async () => {
    const created = await service.create({ userId: 'user-1', telegramUserId: '123' });
    const hash = redis.commands[0].slice('SET session:'.length);
    redis.commands.length = 0;

    await expect((service as unknown as { resolveHash(hash: string): Promise<unknown> }).resolveHash(hash))
      .resolves.toMatchObject({ userId: 'user-1' });

    expect(redis.commands[0]).toBe(`GET session:${hash}`);
    expect(created.id).not.toBe(hash);
  });

  it('rotates only the session identified by its stored hash', async () => {
    await service.create({ userId: 'user-1', telegramUserId: '123' });
    const hash = redis.commands[0].slice('SET session:'.length);
    redis.commands.length = 0;

    await expect((service as unknown as {
      rotateHash(hash: string, input: { userId: string; telegramUserId: string }): Promise<{ id: string }>;
    }).rotateHash(hash, { userId: 'user-1', telegramUserId: '123' })).resolves.toMatchObject({ id: expect.any(String) });

    expect(redis.commands[0]).toBe(`DEL session:${hash}`);
    expect(redis.commands[1]).toMatch(/^SET session:/);
  });

  it('does not rotate a session revoked after validation', async () => {
    await service.create({ userId: 'user-1', telegramUserId: '123' });
    const key = redis.commands[0].slice('SET '.length);
    await redis.del(key);
    redis.commands.length = 0;

    await expect(service.rotateHash(key.slice('session:'.length), { userId: 'user-1', telegramUserId: '123' }))
      .resolves.toBeNull();

    expect(redis.commands).toEqual([`DEL ${key}`]);
  });

  it('expires a rate-limit counter only when it is first incremented', async () => {
    await expect(service.incrementRateLimit('telegram:ip:test', 60)).resolves.toBe(1);
    await expect(service.incrementRateLimit('telegram:ip:test', 60)).resolves.toBe(2);

    expect(redis.commands.filter((command) => command.startsWith('EXPIRE telegram:ip:test'))).toEqual([
      'EXPIRE telegram:ip:test 60'
    ]);
  });
});
