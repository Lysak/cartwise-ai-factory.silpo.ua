import { HttpException } from '@nestjs/common';
import type { SilpoConnectionService } from '../silpo/silpo-connection.service';
import type { SilpoOauthService } from '../silpo/silpo-oauth.service';
import { TRACKING_INTERVAL_MS, PricePollerService } from './price-poller.service';

type Row = Record<string, unknown>;

const tracker = (overrides: Row = {}): Row => ({
  id: 'tracker-1',
  externalProductId: 'product-1',
  slug: 'milk-1',
  branchId: 'branch-1',
  currentPrice: '10.00',
  failedAttempts: 0,
  ...overrides
});

const client = {
  query: jest.fn(),
  release: jest.fn()
};

const pool = {
  connect: jest.fn().mockResolvedValue(client),
  query: jest.fn()
};

const withTrackingReadAccess = jest.fn(async (operation: (token: string) => Promise<unknown>) => operation('tracking-token'));
const callSilpoTool = jest.fn();

const telegram = { send: jest.fn() };

const subject = () => new PricePollerService(
  { withTrackingReadAccess } as unknown as SilpoConnectionService,
  { callSilpoTool } as unknown as SilpoOauthService,
  pool as never,
  telegram as never
);

const product = (overrides: Row = {}): Row => ({
  externalProductId: 'product-1',
  slug: 'milk-1',
  branchId: 'branch-1',
  price: '9.50',
  ...overrides
});

const claimRows = (...rows: Row[]) => {
  client.query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows })
    .mockResolvedValueOnce({ rows: [] });
};

beforeEach(() => {
  jest.clearAllMocks();
  client.query.mockResolvedValue({ rows: [] });
  pool.connect.mockResolvedValue(client);
  callSilpoTool.mockResolvedValue({ products: [product()] });
});

describe('PricePollerService', () => {
  it('claims at most 20 due trackers with a short FOR UPDATE SKIP LOCKED transaction', async () => {
    claimRows();

    await subject().pollDueTrackers();

    const claim = client.query.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes('FOR UPDATE SKIP LOCKED'));
    expect(claim).toContain('LIMIT 20');
    expect(client.query.mock.calls.findIndex(([sql]) => sql === 'COMMIT')).toBeGreaterThan(
      client.query.mock.calls.findIndex(([sql]) => String(sql).includes('FOR UPDATE SKIP LOCKED'))
    );
  });

  it('reserves claimed trackers until their next four-hour check before committing', async () => {
    claimRows(tracker());

    await subject().pollDueTrackers();

    const claim = client.query.mock.calls.find(([sql]) => String(sql).includes('FOR UPDATE SKIP LOCKED'));
    expect(String(claim?.[0])).toContain('UPDATE "PriceTracker"');
    expect(String(claim?.[0])).toContain('"nextCheckAt"');
    expect(claim?.[1]).toContain(TRACKING_INTERVAL_MS);
  });

  it('releases the claim transaction before calling MCP', async () => {
    claimRows(tracker());
    const order: string[] = [];
    client.query.mockReset();
    client.query.mockImplementation(async (sql: string) => {
      if (sql === 'COMMIT') order.push('commit');
      return { rows: String(sql).includes('FOR UPDATE SKIP LOCKED') ? [tracker()] : [] };
    });
    withTrackingReadAccess.mockImplementationOnce(async (operation: (token: string) => Promise<unknown>) => {
      order.push('mcp');
      return operation('tracking-token');
    });

    await subject().pollDueTrackers();

    expect(order.slice(0, 2)).toEqual(['commit', 'mcp']);
  });

  it('uses the exact externalProductId, slug, branchId and a Decimal price', async () => {
    claimRows(tracker());
    callSilpoTool.mockResolvedValueOnce({ products: [product({ price: '9.50' })] });
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [tracker()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await subject().pollDueTrackers();

    expect(callSilpoTool).toHaveBeenCalledWith(
      'tracking-token',
      'silpo_find_products_batch',
      expect.objectContaining({ branchId: 'branch-1', deliveryType: 'SelfPickup', products: ['product-1'] }),
      expect.any(String)
    );
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO "PriceObservation"'));
    expect(insert?.[1]).toEqual(['tracker-1', '9.5', '10', expect.any(Date)]);
  });

  it('backs off when the exact match or its Decimal price is missing', async () => {
    claimRows(tracker());
    callSilpoTool.mockResolvedValueOnce({ products: [product({ slug: 'other-slug' })] });
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ failedAttempts: 0 }] });

    await subject().pollDueTrackers();

    const update = client.query.mock.calls.find(([sql]) => String(sql).includes('lastError'));
    expect(String(update?.[0])).toContain('lastError');
    expect(update?.[1]?.[3]).toBe('no_match');
  });

  it('backs off when the exact article has no Decimal price', async () => {
    claimRows(tracker());
    callSilpoTool.mockResolvedValueOnce({ products: [product({ price: null })] });
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ failedAttempts: 0 }] });

    await subject().pollDueTrackers();

    const update = client.query.mock.calls.find(([sql]) => String(sql).includes('lastError'));
    expect(update?.[1]?.[3]).toBe('no_price');
  });

  it('uses exponential backoff for a rate-limited MCP call', async () => {
    claimRows(tracker({ failedAttempts: 1 }));
    callSilpoTool.mockRejectedValueOnce(new HttpException('Silpo MCP rate limited', 429));
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ failedAttempts: 1 }] });
    const now = Date.now();

    await subject().pollDueTrackers();

    const update = client.query.mock.calls.find(([sql]) => String(sql).includes('lastError'));
    expect(update?.[1]?.[3]).toBe('rate_limited');
    expect((update?.[1]?.[2] as Date).getTime()).toBeGreaterThanOrEqual(now + TRACKING_INTERVAL_MS * 4);
  });

  it('schedules a successful check four hours later', async () => {
    claimRows(tracker());
    callSilpoTool.mockResolvedValueOnce({ products: [product({ price: '10.00' })] });
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [tracker()] });

    await subject().pollDueTrackers();

    const update = client.query.mock.calls.find(([sql]) => String(sql).includes('lastSuccessAt'));
    expect((update?.[1]?.[2] as Date).getTime()).toBeGreaterThanOrEqual(Date.now() + TRACKING_INTERVAL_MS - 1000);
  });

  it('does not append an observation for an unchanged price', async () => {
    claimRows(tracker());
    callSilpoTool.mockResolvedValueOnce({ products: [product({ price: '10.00' })] });
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [tracker()] });

    await subject().pollDueTrackers();

    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO "PriceObservation"'))).toBe(false);
  });

  it('appends one changed observation and one event per subscription, and sends one Telegram notification per subscriber with a chat id', async () => {
    claimRows(tracker());
    callSilpoTool.mockResolvedValueOnce({ products: [product({ price: '9.50' })] });
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [tracker()] })
      .mockResolvedValueOnce({ rows: [{ price: '10.00', observedAt: new Date('2026-01-01T00:00:00.000Z') }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ userId: 'user-1', telegramUserId: 'chat-1' }, { userId: 'user-2', telegramUserId: null }] })
      .mockResolvedValue({ rows: [] });

    await subject().pollDueTrackers();

    expect(client.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO "PriceObservation"'))).toHaveLength(1);
    expect(client.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO "NotificationEvent"'))).toHaveLength(2);
    expect(telegram.send).toHaveBeenCalledTimes(2);
    expect(telegram.send).toHaveBeenCalledWith('chat-1', expect.objectContaining({
      product: expect.objectContaining({ externalProductId: 'product-1', slug: 'milk-1' }),
      price: '9.5',
      oldPrice: '10'
    }));
    expect(telegram.send).toHaveBeenCalledWith(null, expect.anything());
  });

  it('never calls Telegram send before the tracker transaction commits', async () => {
    claimRows(tracker());
    callSilpoTool.mockResolvedValueOnce({ products: [product({ price: '9.50' })] });
    let committedBeforeSend = false;
    client.query.mockImplementation((sql: string) => {
      if (String(sql) === 'COMMIT') committedBeforeSend = true;
      return Promise.resolve({ rows: [] });
    });
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [tracker()] })
      .mockResolvedValueOnce({ rows: [{ price: '10.00', observedAt: new Date('2026-01-01T00:00:00.000Z') }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ userId: 'user-1', telegramUserId: 'chat-1' }] });
    telegram.send.mockImplementation(async () => {
      expect(committedBeforeSend).toBe(true);
    });

    await subject().pollDueTrackers();

    expect(telegram.send).toHaveBeenCalledTimes(1);
  });
});
