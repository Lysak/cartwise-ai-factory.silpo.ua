import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { StoreContextService } from '../catalog/store-context.service';
import type { SilpoProductService } from '../silpo/silpo-product.service';
import { TrackingService } from './tracking.service';

const context = {
  resolveStoreContext: jest.fn().mockResolvedValue({ branchId: 'branch-1' })
};

const product = {
  externalProductId: 'product-1',
  slug: 'milk-1',
  name: 'Молоко'
};

const products = {
  searchProducts: jest.fn().mockResolvedValue({ products: [product] })
};

const client = {
  query: jest.fn(),
  release: jest.fn()
};

const pool = {
  connect: jest.fn().mockResolvedValue(client),
  query: jest.fn()
};

const subject = () => new TrackingService(
  context as unknown as StoreContextService,
  products as unknown as SilpoProductService,
  pool as never
);

beforeEach(() => {
  jest.clearAllMocks();
  client.query.mockResolvedValue({ rows: [] });
  pool.connect.mockResolvedValue(client);
  products.searchProducts.mockResolvedValue({ products: [product] });
});

describe('TrackingService', () => {
  it('finds only the current-branch subscription for the exact external product ID', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'subscription-1' }] });

    await expect((subject() as TrackingService & { findSubscriptionId(userId: string, externalProductId: string): Promise<string | null> })
      .findSubscriptionId('user-1', 'product-1')).resolves.toBe('subscription-1');

    expect(context.resolveStoreContext).toHaveBeenCalledWith('user-1');
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('t."silpoBranchId" = $3'), ['user-1', 'product-1', 'branch-1']);
  });

  it('updates only the caller subscription with a provider detail image', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await expect((subject() as TrackingService & { updateImageUrl(userId: string, subscriptionId: string, imageUrl: string): Promise<void> })
      .updateImageUrl('user-1', 'subscription-1', 'https://img.test/milk.jpg')).resolves.toBeUndefined();

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('s."userId" = $2'), [
      'subscription-1', 'user-1', 'https://img.test/milk.jpg'
    ]);
  });

  it('backfills an own missing price as one initial observation', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'tracker-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    try {
      await expect((subject() as TrackingService & {
        backfillInitialPrice(userId: string, subscriptionId: string, price: number): Promise<void>
      }).backfillInitialPrice('user-1', 'subscription-1', 58.49)).resolves.toBeUndefined();

      expect(client.query).toHaveBeenCalledWith(expect.stringContaining('s."userId" = $2'), [
        'subscription-1', 'user-1', '58.49'
      ]);
      expect(client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO "PriceObservation"'), [
        'tracker-1', '58.49', expect.any(Date)
      ]);
    } finally {
      client.query.mockReset();
    }
  });

  it('lists only own notifications newest first with an allowlisted sanitized payload', async () => {
    const newest = new Date('2026-09-10T12:00:00.000Z');
    const oldest = new Date('2026-09-09T12:00:00.000Z');
    pool.query.mockResolvedValue({ rows: [
      {
        id: 'event-new', type: 'price_drop', name: 'Молоко', slug: 'milk-1', externalProductId: 'product-1',
        payload: { price: '9.50', oldPrice: '10.00', eventTypes: ['price_drop'], secret: 'must-not-return' },
        createdAt: newest, readAt: null
      },
      {
        id: 'event-old', type: 'price_drop', name: 'Молоко', slug: 'milk-1', externalProductId: 'product-1',
        payload: { price: '8.00', oldPrice: null, secret: 'must-not-return' },
        createdAt: oldest, readAt: oldest
      }
    ] });

    await expect(subject().notifications('user-1')).resolves.toEqual({ items: [
      {
        id: 'event-new', type: 'price_drop', product: { name: 'Молоко', slug: 'milk-1', externalProductId: 'product-1' },
        price: '9.50', oldPrice: '10.00', createdAt: newest, readAt: null
      },
      {
        id: 'event-old', type: 'price_drop', product: { name: 'Молоко', slug: 'milk-1', externalProductId: 'product-1' },
        price: '8.00', oldPrice: null, createdAt: oldest, readAt: oldest
      }
    ] });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('"userId" = $1'), ['user-1']);
    expect(pool.query.mock.calls[0][0]).toMatch(/ORDER BY [\s\S]*"createdAt" DESC/);
  });

  it('sanitizes malformed notification payload prices to null without leaking unknown keys', async () => {
    pool.query.mockResolvedValue({ rows: [{
      id: 'event-1', type: 'price_drop', name: 'Молоко', slug: 'milk-1', externalProductId: 'product-1',
      payload: { price: 'not-a-decimal', oldPrice: 10, secret: 'must-not-return' },
      createdAt: new Date('2026-09-10T12:00:00.000Z'), readAt: null
    }] });

    await expect(subject().notifications('user-1')).resolves.toEqual({ items: [{
      id: 'event-1', type: 'price_drop', product: { name: 'Молоко', slug: 'milk-1', externalProductId: 'product-1' },
      price: null, oldPrice: null, createdAt: new Date('2026-09-10T12:00:00.000Z'), readAt: null
    }] });
  });

  it('marks only an own unread notification as read', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'event-1' }] });

    await expect(subject().readNotification('user-1', 'event-1')).resolves.toEqual({ status: 'read' });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('"readAt" IS NULL'), ['event-1', 'user-1']);
  });

  it.each(['event-foreign', 'event-missing'])('returns not found for %s notification', async (id) => {
    pool.query.mockResolvedValue({ rows: [] });

    await expect(subject().readNotification('user-1', id)).rejects.toBeInstanceOf(NotFoundException);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('"userId" = $2'), [id, 'user-1']);
  });

  it('lists only own subscription history oldest first', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ trackerId: 'tracker-1' }] })
      .mockResolvedValueOnce({ rows: [
        { price: '10.00', oldPrice: null, observedAt: new Date('2026-09-08T12:00:00.000Z') },
        { price: '9.50', oldPrice: '10.00', observedAt: new Date('2026-09-09T12:00:00.000Z') }
      ] });

    await expect(subject().history('user-1', 'subscription-1')).resolves.toEqual({ items: [
      { price: '10.00', oldPrice: null, observedAt: new Date('2026-09-08T12:00:00.000Z') },
      { price: '9.50', oldPrice: '10.00', observedAt: new Date('2026-09-09T12:00:00.000Z') }
    ] });
    expect(pool.query.mock.calls[0]).toEqual([
      expect.stringContaining('"userId" = $2'), ['subscription-1', 'user-1']
    ]);
    expect(pool.query.mock.calls[1][0]).toMatch(/ORDER BY [\s\S]*"observedAt" ASC/);
  });

  it('returns not found for another user or missing history subscription', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await expect(subject().history('user-1', 'subscription-foreign')).rejects.toBeInstanceOf(NotFoundException);
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('"userId" = $2'), ['subscription-foreign', 'user-1']);
  });

  it('creates one shared tracker and a private subscription transactionally', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'tracker-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'subscription-1' }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1',
        slug: 'milk-1', name: 'Молоко', branchId: 'branch-1', status: 'active', currentPrice: null
      }] });

    await expect(subject().heart('user-1', product)).resolves.toMatchObject({
      id: 'subscription-1', trackerId: 'tracker-1', branchId: 'branch-1'
    });

    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('ON CONFLICT'))).toBe(true);
  });

  it('persists a verified optional HTTPS product image and returns it in the tracking item', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'tracker-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'subscription-1' }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1',
        slug: 'milk-1', name: 'Молоко', branchId: 'branch-1', status: 'active', currentPrice: null,
        imageUrl: 'https://img.test/milk.jpg'
      }] });

    try {
      await expect(subject().heart('user-1', { ...product, imageUrl: 'https://img.test/milk.jpg' })).resolves.toMatchObject({
        id: 'subscription-1', imageUrl: 'https://img.test/milk.jpg'
      });
    } finally {
      client.query.mockReset();
    }
  });

  it('records the verified search price as the first observation without accepting a client price', async () => {
    products.searchProducts.mockResolvedValueOnce({ products: [{ ...product, price: 58.49 }] });
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'tracker-1', currentPrice: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1',
        slug: 'milk-1', name: 'Молоко', branchId: 'branch-1', status: 'active', currentPrice: '58.49'
      }] });

    try {
      await expect(subject().heart('user-1', product)).resolves.toMatchObject({ currentPrice: '58.49' });

      expect(client.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO "PriceObservation"'), [
        'tracker-1', '58.49', expect.any(Date)
      ]);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('SET "currentPrice" = $2'), [
      'tracker-1', '58.49'
    ]);
    } finally {
      client.query.mockReset();
    }
  });

  it('verifies the submitted identity against the server-side M1 allowlist at the selected branch', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'tracker-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'subscription-1' }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1',
        slug: 'milk-1', name: 'Молоко', branchId: 'branch-1', status: 'active', currentPrice: null
      }] });

    await subject().heart('user-1', product);

    expect(products.searchProducts).toHaveBeenCalledWith('user-1', { q: 'product-1', limit: 100 });
  });

  it('moves the same user tracking the same product to a new branch instead of duplicating the subscription', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // insert/upsert tracker for branch-1
      .mockResolvedValueOnce({ rows: [{ id: 'tracker-1' }] }) // select tracker for branch-1
      .mockResolvedValueOnce({ rows: [] }) // no prior subscription to move
      .mockResolvedValueOnce({ rows: [{ id: 'subscription-1' }] }) // insert subscription
      .mockResolvedValueOnce({ rows: [{
        id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1',
        slug: 'milk-1', name: 'Молоко', branchId: 'branch-1', status: 'active', currentPrice: null
      }] }); // select final row
    await subject().heart('user-1', product);

    context.resolveStoreContext.mockResolvedValueOnce({ branchId: 'branch-2' });
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // insert/upsert tracker for branch-2
      .mockResolvedValueOnce({ rows: [{ id: 'tracker-2' }] }) // select tracker for branch-2
      .mockResolvedValueOnce({ rows: [{ trackerId: 'tracker-1' }] }) // finds the branch-1 subscription to move
      .mockResolvedValueOnce({ rows: [] }) // disables the now-orphaned branch-1 tracker
      .mockResolvedValueOnce({ rows: [{ id: 'subscription-2' }] }) // insert subscription
      .mockResolvedValueOnce({ rows: [{
        id: 'subscription-2', trackerId: 'tracker-2', externalProductId: 'product-1',
        slug: 'milk-1', name: 'Молоко', branchId: 'branch-2', status: 'active', currentPrice: null
      }] }); // select final row

    await expect(subject().heart('user-1', product)).resolves.toMatchObject({
      id: 'subscription-2', trackerId: 'tracker-2', branchId: 'branch-2'
    });

    const moveCall = client.query.mock.calls.find(([sql, values]) =>
      String(sql).includes('DELETE FROM "PriceSubscription"')
      && String(sql).includes('"silpoExternalProductId"')
      && (values as unknown[])?.[2] === 'tracker-2'
    );
    expect(moveCall?.[1]).toEqual(['user-1', 'product-1', 'tracker-2']);

    const disableCall = client.query.mock.calls.find(([sql, values]) =>
      String(sql).includes('UPDATE "PriceTracker"') && String(sql).includes("'disabled'") && (values as unknown[])?.[0] === 'tracker-1'
    );
    expect(disableCall).toBeDefined();
  });

  it('rejects a client identity when M1 returns a different slug or name', async () => {
    products.searchProducts.mockResolvedValueOnce({ products: [{ ...product, slug: 'other-slug' }] });

    await expect(subject().heart('user-1', product)).rejects.toBeInstanceOf(BadRequestException);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('is idempotent and keeps separate subscriptions for two users', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'tracker-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'subscription-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'subscription-1', trackerId: 'tracker-1', branchId: 'branch-1' }] });
    await subject().heart('user-1', product);

    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'tracker-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'subscription-2' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'subscription-2', trackerId: 'tracker-1', branchId: 'branch-1' }] });
    await subject().heart('user-2', product);

    const sql = client.query.mock.calls.map(([query]) => String(query)).join('\n');
    expect(sql).toMatch(/UNIQUE|ON CONFLICT/);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('rejects client prices and history instead of persisting provider data', async () => {
    await expect(subject().heart('user-1', { ...product, price: 42 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(subject().heart('user-1', { ...product, history: [] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(subject().heart('user-1', { product, price: 42 })).rejects.toBeInstanceOf(BadRequestException);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('removes only the caller subscription and disables an unshared tracker', async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ trackerId: 'tracker-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(subject().unheart('user-1', 'subscription-1')).resolves.toEqual({ status: 'untracked' });
    expect(client.query.mock.calls.some(([sql, params]) => String(sql).includes('"userId" = $2') && params?.[1] === 'user-1')).toBe(true);
  });

  it('does not leak another user tracker in the list', async () => {
    pool.query.mockResolvedValue({ rows: [{
      id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1',
      slug: 'milk-1', name: 'Молоко', branchId: 'branch-1', status: 'active', currentPrice: null,
      raw: 'must-not-return'
    }] });

    await expect(subject().list('user-1')).resolves.toEqual({ items: [{
      id: 'subscription-1', trackerId: 'tracker-1', externalProductId: 'product-1',
      slug: 'milk-1', name: 'Молоко', imageUrl: null, branchId: 'branch-1', status: 'active', currentPrice: null
    }] });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('"userId" = $1'), ['user-1']);
  });

  it('requires a selected branch before writing', async () => {
    context.resolveStoreContext.mockRejectedValueOnce(new Error('branch required'));
    await expect(subject().heart('user-1', product)).rejects.toThrow('branch required');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects a malformed M1 identity', async () => {
    await expect(subject().heart('user-1', { slug: 'milk-1' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(subject().heart('user-1', { externalProductId: 'p', slug: 'milk-1', raw: {} })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reports missing subscription without touching another user row', async () => {
    client.query.mockResolvedValueOnce({ rows: [] });
    await expect(subject().unheart('user-1', 'subscription-2')).rejects.toBeInstanceOf(NotFoundException);
  });
});
