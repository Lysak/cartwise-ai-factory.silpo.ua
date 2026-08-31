import { createHash } from 'node:crypto';
import { TelegramLinkService } from './telegram-link.service';

type Row = Record<string, unknown>;

describe('TelegramLinkService', () => {
  const pool = { query: jest.fn() };
  const service = new TelegramLinkService(pool as never);

  beforeEach(() => jest.clearAllMocks());

  describe('createLink', () => {
    it('stores only the sha256 hash of the raw token, never the raw value', async () => {
      pool.query.mockResolvedValue({ rows: [] });

      const raw = await service.createLink('user-1');

      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO "TelegramLinkToken"'),
        [createHash('sha256').update(raw).digest('hex'), 'user-1']
      );
      const insertCall = pool.query.mock.calls.find((call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO "TelegramLinkToken"'));
      expect(insertCall?.[1]).not.toContain(raw);
    });

    it('sets a 10-minute expiry', async () => {
      pool.query.mockResolvedValue({ rows: [] });

      await service.createLink('user-1');

      expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("INTERVAL '10 minutes'"), expect.any(Array));
    });

    it('sweeps expired/consumed tokens before issuing a new one', async () => {
      pool.query.mockResolvedValue({ rows: [] });

      await service.createLink('user-1');

      expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM "TelegramLinkToken" WHERE "expiresAt" <= NOW()'));
    });
  });

  describe('consume', () => {
    it('rejects an unknown token without mutating any user row', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await expect(service.consume('unknown-token', 'chat-1')).resolves.toBe('invalid');

      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it('sets telegramUserId and marks the token consumed on a valid token', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ userId: 'user-1' } as Row] })
        .mockResolvedValueOnce({ rows: [{ id: 'user-1' } as Row] });

      await expect(service.consume('raw-token', 'chat-1')).resolves.toBe('linked');

      expect(pool.query).toHaveBeenNthCalledWith(1, expect.stringContaining('UPDATE "TelegramLinkToken"'), [
        createHash('sha256').update('raw-token').digest('hex')
      ]);
      expect(pool.query).toHaveBeenNthCalledWith(2, expect.stringContaining('UPDATE "User"'), ['chat-1', 'user-1']);
    });

    it('does not throw and still marks the token consumed on a chat id already taken by another user', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ userId: 'user-1' } as Row] })
        .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));

      await expect(service.consume('raw-token', 'chat-1')).resolves.toBe('conflict');
    });

    it('reports a conflict without throwing when the user is already linked to a different Telegram account', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ userId: 'user-1' } as Row] })
        .mockResolvedValueOnce({ rows: [] });

      await expect(service.consume('raw-token', 'chat-1')).resolves.toBe('conflict');
    });

    it('rejects an already-consumed or expired token without a second query', async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await expect(service.consume('stale-token', 'chat-1')).resolves.toBe('invalid');

      expect(pool.query).toHaveBeenCalledTimes(1);
    });
  });
});
