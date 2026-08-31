import { HttpException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { SilpoOauthService } from './silpo-oauth.service';
import { SilpoRefreshRejectedError } from './silpo-oauth.service';
import { SilpoConnectionService, SilpoReauthRequiredException } from './silpo-connection.service';

type Row = Record<string, unknown>;
type QueryResult = { rows: Row[] };

describe('SilpoConnectionService', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('refreshes only the requested user connection on demand', async () => {
    const { service, oauth, pool, tx } = subject();
    const row = connection(service, { userId: 'user-1' });
    pool.query.mockResolvedValue({ rows: [row] });
    tx.query.mockImplementation(locking(row));
    oauth.refreshToken.mockResolvedValue(tokenSet('new-access', 'new-refresh'));

    await expect(service.withReadAccess('user-1', async (token) => token)).resolves.toBe('new-access');

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('WHERE "userId" = $1'), ['user-1']);
    expect(tx.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1 FOR UPDATE'), ['connection-1']);
  });

  it('preserves the old refresh token when no rotated token is returned', async () => {
    const { service, oauth, pool, tx, cipher } = subject();
    const row = connection(service);
    pool.query.mockResolvedValue({ rows: [row] });
    tx.query.mockImplementation(locking(row));
    oauth.refreshToken.mockResolvedValue(tokenSet('new-access'));

    await service.withReadAccess('user-1', async (token) => token);

    const update = tx.query.mock.calls.find(([sql]) => String(sql).startsWith('UPDATE "SilpoConnection" SET "accessTokenEncrypted"'));
    expect(update).toBeDefined();
    expect(String(update![0])).toContain('"refreshTokenEncrypted" = COALESCE($2, "refreshTokenEncrypted")');
    const values = (update as unknown as [string, unknown[]])[1];
    expect(cipher.decrypt(values[0] as string)).toBe('new-access');
    expect(values[1]).toBeNull();
    expect(cipher.decrypt(row.refreshTokenEncrypted as string)).toBe('old-refresh');
  });

  it('sets reauth_required only for a confirmed refresh rejection', async () => {
    const rejected = subject();
    const rejectedRow = connection(rejected.service);
    rejected.pool.query.mockResolvedValue({ rows: [rejectedRow] });
    rejected.tx.query.mockImplementation(locking(rejectedRow));
    rejected.oauth.refreshToken.mockRejectedValue(new SilpoRefreshRejectedError());

    const error = await rejected.service.withReadAccess('user-1', async (token) => token).catch((cause) => cause);

    expect(error).toBeInstanceOf(SilpoReauthRequiredException);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toEqual({ code: 'SILPO_REAUTH_REQUIRED', message: 'Silpo reauthorization required' });
    expect(rejected.tx.query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'reauth_required'"), ['connection-1']);

    const temporary = subject();
    const temporaryRow = connection(temporary.service);
    temporary.pool.query.mockResolvedValue({ rows: [temporaryRow] });
    temporary.tx.query.mockImplementation(locking(temporaryRow));
    temporary.oauth.refreshToken.mockRejectedValue(new ServiceUnavailableException('temporary'));

    await expect(temporary.service.withReadAccess('user-1', async (token) => token)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(temporary.tx.query.mock.calls.some(([sql]) => String(sql).includes("status = 'reauth_required'"))).toBe(false);
  });

  it('retries one explicitly read-only operation once after authorization rejection', async () => {
    const { service, oauth, pool, tx } = subject();
    const row = connection(service, { accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000) });
    pool.query.mockResolvedValue({ rows: [row] });
    tx.query.mockImplementation(locking(row));
    oauth.refreshToken.mockResolvedValue(tokenSet('new-access', 'new-refresh'));
    const operation = jest.fn().mockRejectedValueOnce(new UnauthorizedException()).mockResolvedValueOnce('ok');

    await expect(service.withReadAccess('user-1', operation)).resolves.toBe('ok');

    expect(operation.mock.calls).toEqual([['old-access'], ['new-access']]);
    expect(oauth.refreshToken).toHaveBeenCalledTimes(1);
  });

  it('never retries a write operation automatically', async () => {
    const { service, oauth, pool } = subject();
    pool.query.mockResolvedValue({ rows: [connection(service, { accessTokenExpiresAt: new Date(Date.now() + 60 * 60_000) })] });
    const operation = jest.fn().mockRejectedValue(new UnauthorizedException());

    await expect(service.withWriteAccess('user-1', operation)).rejects.toBeInstanceOf(UnauthorizedException);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(oauth.refreshToken).not.toHaveBeenCalled();
  });

  it('refreshes due connections with one transaction per connection', async () => {
    const { service, oauth, pool } = subject();
    const rows = [
      connection(service, { id: 'connection-1', userId: 'user-1' }),
      connection(service, { id: 'connection-2', userId: 'user-2' })
    ];
    const transactions = rows.map((row) => transaction(row));
    pool.query.mockResolvedValue({ rows: rows.map(({ id }) => ({ id })) });
    pool.connect.mockResolvedValueOnce(transactions[0]).mockResolvedValueOnce(transactions[1]);
    oauth.refreshToken.mockResolvedValue(tokenSet('new-access', 'new-refresh'));

    await service.refreshExpiringConnections();

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("NOW() + INTERVAL '2 hours'"));
    expect(pool.connect).toHaveBeenCalledTimes(2);
    for (const [index, tx] of transactions.entries()) {
      expect(tx.query).toHaveBeenCalledWith(expect.stringContaining('WHERE id = $1 FOR UPDATE'), [rows[index].id]);
      expect(tx.query).toHaveBeenCalledWith('COMMIT');
      expect(tx.release).toHaveBeenCalled();
    }
  });
});

function subject() {
  const oauth = { refreshToken: jest.fn() };
  const service = new SilpoConnectionService(oauth as unknown as SilpoOauthService);
  const tx = transaction();
  const pool = { query: jest.fn(), connect: jest.fn().mockResolvedValue(tx) };
  Object.assign(service as object, { pool });
  const cipher = (service as unknown as { cipher: { encrypt(value: string): string; decrypt(value: string): string } }).cipher;
  return { service, oauth, pool, tx, cipher };
}

function connection(service: SilpoConnectionService, overrides: Row = {}): Row {
  const cipher = (service as unknown as { cipher: { encrypt(value: string): string } }).cipher;
  return {
    id: 'connection-1',
    userId: 'user-1',
    accessTokenEncrypted: cipher.encrypt('old-access'),
    refreshTokenEncrypted: cipher.encrypt('old-refresh'),
    accessTokenExpiresAt: new Date(Date.now() - 60_000),
    status: 'active',
    ...overrides
  };
}

function tokenSet(accessToken: string, refreshToken?: string) {
  return { access_token: accessToken, refresh_token: refreshToken, expires_in: 3600 };
}

function locking(row: Row) {
  return async (sql: string): Promise<QueryResult> => sql.includes('FOR UPDATE') ? { rows: [row] } : { rows: [] };
}

function transaction(row?: Row) {
  return {
    query: jest.fn(row ? locking(row) : async (): Promise<QueryResult> => ({ rows: [] })),
    release: jest.fn()
  };
}
