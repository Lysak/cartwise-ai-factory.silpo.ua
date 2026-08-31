import { BadGatewayException } from '@nestjs/common';
import type { StoreContextService } from '../catalog/store-context.service';
import type { SilpoConnectionService } from './silpo-connection.service';
import type { SilpoOauthService } from './silpo-oauth.service';
import { SilpoProductService } from './silpo-product.service';

type Payload = Record<string, unknown>;

function subject(payload: Payload | (() => Promise<Payload>)) {
  const callSilpoTool = jest.fn<Promise<Payload>, [string, string, Record<string, unknown>, string]>(
    async () => (typeof payload === 'function' ? payload() : payload)
  );
  const withReadAccess = jest.fn(async (_userId: string, op: (token: string) => Promise<unknown>) => op('access-token'));
  const service = new SilpoProductService(
    { withReadAccess } as unknown as SilpoConnectionService,
    { callSilpoTool } as unknown as SilpoOauthService
  );
  return { service, callSilpoTool, withReadAccess };
}

function productSubject(payload: Payload, analyses?: { getOrCreate: jest.Mock }) {
  const callSilpoTool = jest.fn<Promise<Payload>, [string, string, Record<string, unknown>, string]>(async () => payload);
  const withReadAccess = jest.fn(async (_userId: string, op: (token: string) => Promise<unknown>) => op('access-token'));
  const context = {
    resolveStoreContext: jest.fn().mockResolvedValue({
      branchId: 'branch-1', deliveryType: 'SelfPickup',
      timeslotStart: '2030-01-02T12:00:00.000Z', timeslotEnd: '2030-01-02T12:30:00.000Z'
    })
  };
  const store = new Map<string, string>();
  const redis = {
    isOpen: true,
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
  };
  const service = new SilpoProductService(
    { withReadAccess } as unknown as SilpoConnectionService,
    { callSilpoTool } as unknown as SilpoOauthService,
    context as unknown as StoreContextService,
    undefined,
    analyses as never,
    redis as never
  );
  return { service, callSilpoTool, withReadAccess, context, redis };
}

// Shape confirmed live 2026-08-31: payload.branches[], record has no name; lat/long are strings; payload.meta.total.
const branchRecord = (over: Payload = {}): Payload => ({
  branchId: '1ed43e73-051b-6842-a111-a5ad042eb496', companyId: 'c-1', externalId: '1998',
  city: 'Київ', address: 'просп. Володимира Івасюка, 46',
  latitude: '50.5202200000000000', longitude: '30.5145200000000000', hasPickup: true, open: true, ...over
});
const page = (records: Payload[], total = records.length): Payload => ({
  success: true, branches: records, meta: { limit: 25, offset: 0, total }
});

describe('SilpoProductService.listBranches', () => {
  it('filters the cached 500-branch allowlist by every query token in city and address', async () => {
    const { service, callSilpoTool } = subject(page([
      branchRecord({ branchId: 'kyiv-1', city: 'Київ', address: 'Велика Васильківська 1' }),
      branchRecord({ branchId: 'lviv-1', city: 'Львів', address: 'проспект Свободи 2' })
    ]));

    await expect(service.listBranches('user-1', { q: 'Київ Васильківська' })).resolves.toEqual({
      branches: [expect.objectContaining({ silpoBranchId: 'kyiv-1' })],
      nextOffset: null
    });
    expect(callSilpoTool).toHaveBeenCalledTimes(1);
    expect(callSilpoTool.mock.calls[0][2]).toMatchObject({ limit: 500, offset: 0 });
  });

  it('reuses the 500-branch cache for branch validation reads', async () => {
    const { service, callSilpoTool } = subject(page([branchRecord()]));

    await service.listBranches('user-1', { limit: 500, offset: 0 });
    await service.listBranches('user-1', { q: 'Київ' });

    expect(callSilpoTool).toHaveBeenCalledTimes(1);
  });

  it('does not reuse an unfiltered cache for pickup-filtered branch searches', async () => {
    let calls = 0;
    const { service, callSilpoTool } = subject(async () => {
      calls += 1;
      return calls === 1
        ? page([branchRecord({ branchId: 'regular', city: 'Київ', hasPickup: false })])
        : page([branchRecord({ branchId: 'pickup', city: 'Київ', hasPickup: true })]);
    });

    await service.listBranches('user-1', { limit: 500, offset: 0 });
    await expect(service.listBranches('user-1', { q: 'Київ', hasPickup: true })).resolves.toEqual({
      branches: [expect.objectContaining({ silpoBranchId: 'pickup', hasPickup: true })],
      nextOffset: null
    });

    expect(callSilpoTool).toHaveBeenCalledTimes(2);
    expect(callSilpoTool.mock.calls[1][2]).toEqual({ limit: 500, offset: 0, hasPickup: true });
  });

  it('maps only BranchSummary fields and parses string coordinates', async () => {
    const { service } = subject(page([branchRecord()]));

    const result = await service.listBranches('user-1', {});

    expect(result.branches).toEqual([{
      silpoBranchId: '1ed43e73-051b-6842-a111-a5ad042eb496',
      externalId: '1998', city: 'Київ', address: 'просп. Володимира Івасюка, 46',
      latitude: 50.52022, longitude: 30.51452, hasPickup: true
    }]);
  });

  it('falls back to null for missing fields and skips records without a branchId', async () => {
    const { service } = subject(page([
      { branchId: 'b-2' },
      { externalId: '999' }
    ]));

    const result = await service.listBranches('user-1', {});

    expect(result.branches).toEqual([{
      silpoBranchId: 'b-2', externalId: null, city: null, address: null,
      latitude: null, longitude: null, hasPickup: null
    }]);
  });

  it('clamps limit and offset and forwards them as MCP arguments', async () => {
    const { service, callSilpoTool } = subject(page([]));

    await service.listBranches('user-1', { limit: 9999, offset: -5 });

    expect(callSilpoTool).toHaveBeenCalledWith('access-token', 'silpo_list_branches', { limit: 500, offset: 0 }, expect.any(String));
  });

  it('forwards hasPickup only when it is literally true', async () => {
    const yes = subject(page([]));
    await yes.service.listBranches('user-1', { hasPickup: true });
    expect(yes.callSilpoTool.mock.calls[0][2]).toEqual({ limit: 25, offset: 0, hasPickup: true });

    const no = subject(page([]));
    await no.service.listBranches('user-1', { hasPickup: false });
    expect(no.callSilpoTool.mock.calls[0][2]).toEqual({ limit: 25, offset: 0 });
  });

  it('derives nextOffset from meta.total', async () => {
    const more = subject(page([branchRecord({ branchId: 'a' }), branchRecord({ branchId: 'b' })], 455));
    await expect(more.service.listBranches('user-1', { limit: 2, offset: 4 })).resolves.toMatchObject({ nextOffset: 6 });

    const last = subject(page([branchRecord({ branchId: 'a' })], 5));
    await expect(last.service.listBranches('user-1', { limit: 2, offset: 4 })).resolves.toMatchObject({ nextOffset: null });
  });

  it('rejects a payload without a branches array with a 502', async () => {
    const { service } = subject({ success: false, error: 'nope' });
    await expect(service.listBranches('user-1', {})).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('never leaks the access token or raw envelope in the result', async () => {
    const { service } = subject({ ...page([branchRecord()]), jsonrpc: '2.0', accessToken: 'access-token' });

    const serialized = JSON.stringify(await service.listBranches('user-1', {}));

    expect(serialized).not.toContain('access-token');
    expect(serialized).not.toContain('jsonrpc');
    expect(serialized).not.toContain('companyId');
  });
});

describe('SilpoProductService product reads', () => {
  it('trims the search, clamps the limit, and maps only products with a slug', async () => {
    const { service, callSilpoTool, context } = productSubject({
      products: [
        {
          id: 'p-1', slug: 'milk-1', externalProductId: '123456', name: 'Milk', brandTitle: 'Brand',
          image: 'image', price: 42, oldPrice: null, stock: 3, available: true, displayRatio: 1.5,
          companyId: 'company', branchId: 'branch', loyalty: { points: 9 }
        },
        { id: 'p-2', name: 'No slug' }
      ]
    });

    await expect(service.searchProducts('user-1', { q: '  milk  ', limit: 999 })).resolves.toEqual({
      products: [{
        silpoProductId: 'p-1', slug: 'milk-1', externalProductId: '123456', name: 'Milk', brandTitle: 'Brand',
        image: 'image', price: 42, oldPrice: null, stock: 3, available: true, displayRatio: 1.5
      }]
    });
    expect(context.resolveStoreContext).toHaveBeenCalledWith('user-1');
    expect(callSilpoTool).toHaveBeenCalledWith('access-token', 'silpo_find_products_batch', {
      branchId: 'branch-1', deliveryType: 'SelfPickup', timeslotStart: '2030-01-02T12:00:00.000Z',
      timeslotEnd: '2030-01-02T12:30:00.000Z', products: ['milk'], limit: 100
    }, expect.any(String));
  });

  it('reads products from the observed nested query result', async () => {
    const { service } = productSubject({ queries: [{ products: [{ slug: 'milk-1', name: 'Milk' }] }] });

    await expect(service.searchProducts('user-1', { q: 'milk' })).resolves.toEqual({
      products: [{
        silpoProductId: null, slug: 'milk-1', externalProductId: null, name: 'Milk', brandTitle: null,
        image: null, price: null, oldPrice: null, stock: null, available: null, displayRatio: null
      }]
    });
  });

  it('rejects nested query results without a products array', async () => {
    const { service } = productSubject({ queries: [{ products: 'not-an-array' }] });

    await expect(service.searchProducts('user-1', { q: 'milk' })).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('rejects an empty or overlong search query', async () => {
    const { service, callSilpoTool } = productSubject({ products: [] });

    await expect(service.searchProducts('user-1', { q: '   ' })).rejects.toBeInstanceOf(Error);
    await expect(service.searchProducts('user-1', { q: 'x'.repeat(201) })).rejects.toBeInstanceOf(Error);
    expect(callSilpoTool).not.toHaveBeenCalled();
  });

  it('rejects malformed search payloads with a generic 502', async () => {
    const { service } = productSubject({ success: false, error: 'provider detail' });

    await expect(service.searchProducts('user-1', { q: 'milk' })).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('keeps only public attributes while scoring raw allergen and barcode detail internally', async () => {
    const { service, callSilpoTool, context, redis } = productSubject({
      product: {
        id: 'p-1', slug: 'milk-1', externalProductId: '123456', name: 'Milk', brandTitle: 'Brand', image: 'image',
        price: 42, oldPrice: 50, stock: 3, available: true, displayRatio: 1,
        branchId: 'branch', companyId: 'company', jsonrpc: '2.0', profile: { id: 'secret' },
        attributes: {
          'Країна': 'Україна', 'Торгова марка': 'Brand', 'Продавець': 'Silpo', 'Смак': 'Класичний',
          'Енергетична цінність (кКал/кДЖ)': '180/753', 'Білки (г)': 6.8, 'Жири (г)': '3,2',
          'Вуглеводи (г)': '12', 'Органіка/Еко': 'Не органічний', 'Містить алергени': 'Молоко',
          EAN: '4820000000000', nested: { leak: 'no' }, empty: '', loyalty: 'nope', unknown: 'drop'
        }
      }
    });

    await expect(service.getProductDetails('user-1', 'milk-1')).resolves.toEqual({
      product: {
        silpoProductId: 'p-1', slug: 'milk-1', externalProductId: '123456', name: 'Milk', brandTitle: 'Brand',
        image: 'image', price: 42, oldPrice: 50, stock: 3, available: true, displayRatio: 1
      },
      attributes: {
        'Країна': 'Україна', 'Торгова марка': 'Brand', 'Продавець': 'Silpo', 'Смак': 'Класичний',
        'Енергетична цінність (кКал/кДЖ)': '180/753', 'Білки (г)': '6.8', 'Жири (г)': '3,2',
        'Вуглеводи (г)': '12', 'Органіка/Еко': 'Не органічний'
      },
      analysis: expect.objectContaining({
        score: 55, confidence: 'high', algorithmVersion: 'v2', unavailableComponents: ['ingredients'],
        components: expect.arrayContaining([{ key: 'allergens', label: 'Алергени', value: 'Є дані від Сільпо' }])
      })
    });
    expect(context.resolveStoreContext).toHaveBeenCalledWith('user-1');
    expect(callSilpoTool).toHaveBeenCalledWith('access-token', 'silpo_get_product_details', {
      branchId: 'branch-1', deliveryType: 'SelfPickup', timeslotStart: '2030-01-02T12:00:00.000Z',
      timeslotEnd: '2030-01-02T12:30:00.000Z', slug: 'milk-1'
    }, expect.any(String));
    const serialized = JSON.stringify(await service.getProductDetails('user-1', 'milk-1'));
    expect(serialized).not.toMatch(/access-token|companyId|branchId|jsonrpc|profile|loyalty|Молоко|4820000000000|unknown|nested/);
    const cached = await redis.get('silpo:detail:user-1:branch-1:2030-01-02T12:00:00.000Z:milk-1');
    expect(cached).not.toMatch(/Містить алергени|Молоко|EAN|4820000000000|unknown/);
    expect(cached).toContain('Є дані від Сільпо');
  });

  it('passes raw detail attributes to ProductAnalysis before projecting the public response', async () => {
    const analyses = { getOrCreate: jest.fn().mockResolvedValue(null) };
    const { service } = productSubject({ product: {
      slug: 'milk-1', attributes: { 'Країна': 'Україна', 'Містить алергени': 'Молоко', EAN: '4820000000000' }
    } }, analyses);

    const result = await service.getProductDetails('user-1', 'milk-1');

    expect(analyses.getOrCreate).toHaveBeenCalledWith('milk-1', expect.objectContaining({
      'Містить алергени': 'Молоко', EAN: '4820000000000'
    }));
    expect(result.attributes).toEqual({ 'Країна': 'Україна' });
  });

  it('drops sensitive and unknown public attribute keys', async () => {
    const { service } = productSubject({
      product: {
        slug: 'milk-1',
        attributes: {
          'Access Token': 'access-secret',
          'refresh-token': 'refresh-secret',
          silpo_external_id: 'silpo-secret',
          AUTHORIZATION: 'authorization-secret',
          'safe label': 'drop'
        }
      }
    });

    const result = await service.getProductDetails('user-1', 'milk-1');
    expect(result.attributes).toEqual({});
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/access-secret|refresh-secret|silpo-secret|authorization-secret/);
  });

  it('rejects analysis components with additional fields and falls back to safe output', async () => {
    const unsafeAnalysis = {
      score: 53, confidence: 'low', factors: ['+3: енергетична цінність 180 кКал'],
      components: [
        { key: 'energy', label: 'Енергія', value: '180 кКал', raw: 'secret' },
        { key: 'protein', label: 'Білки', value: null },
        { key: 'fat', label: 'Жири', value: null },
        { key: 'carbohydrates', label: 'Вуглеводи', value: null },
        { key: 'ingredients', label: 'Склад / E-добавки', value: null },
        { key: 'organic', label: 'Органічність', value: null },
        { key: 'allergens', label: 'Алергени', value: null },
      ],
      unavailableComponents: ['protein', 'fat', 'carbohydrates', 'ingredients', 'organic', 'allergens'],
      algorithmVersion: 'v2', sourceHash: 'a'.repeat(64),
    };
    const analyses = { getOrCreate: jest.fn().mockResolvedValue(unsafeAnalysis) };
    const { service } = productSubject({ product: { slug: 'milk-1', attributes: { 'Енергетична цінність': '180' } } }, analyses);

    const result = await service.getProductDetails('user-1', 'milk-1');

    expect(result.analysis).toEqual(expect.objectContaining({ score: 53, factors: ['+3: енергетична цінність 180 кКал'] }));
    expect(result.analysis.components[0]).toEqual({ key: 'energy', label: 'Енергія', value: '180 кКал' });
  });

  it('drops unknown attributes before applying the serialized size cap', async () => {
    const attributes = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`attribute-${index}`, `value-${index}`]));
    const { service } = productSubject({ product: { slug: 'milk-1', attributes } });

    const result = await service.getProductDetails('user-1', 'milk-1');
    const serializedAttributes = JSON.stringify(result.attributes);

    expect(Object.keys(result.attributes)).toHaveLength(0);
    expect(Buffer.byteLength(serializedAttributes, 'utf8')).toBeLessThan(16 * 1024);
  });

  it('caps attribute count and serialized output size while stringifying finite numbers', async () => {
    const attributes = {
      object: { leak: 'no' },
      numeric: 42,
      ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`attribute-${index}`, 'x'.repeat(1024)]))
    };
    const { service } = productSubject({ product: { slug: 'milk-1', attributes } });

    const result = await service.getProductDetails('user-1', 'milk-1');
    const serializedAttributes = JSON.stringify(result.attributes);

    expect(Object.keys(result.attributes).length).toBeLessThanOrEqual(32);
    expect(Buffer.byteLength(serializedAttributes, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(result.attributes).not.toHaveProperty('object');
    expect(result.attributes.numeric).toBeUndefined();
    expect(Object.values(result.attributes).every((value) => typeof value === 'string')).toBe(true);
  });

  it('rejects malformed detail payloads with a generic 502', async () => {
    const { service } = productSubject({ product: { name: 'missing slug' } });

    await expect(service.getProductDetails('user-1', 'milk-1')).rejects.toBeInstanceOf(BadGatewayException);
  });
});

describe('SilpoProductService short-lived MCP result cache', () => {
  it('serves a repeated search for the same user/branch/query from cache instead of calling MCP again', async () => {
    const { service, callSilpoTool } = productSubject({ products: [{ slug: 'milk-1', name: 'Milk' }] });

    const first = await service.searchProducts('user-1', { q: 'milk' });
    const second = await service.searchProducts('user-1', { q: 'milk' });

    expect(second).toEqual(first);
    expect(callSilpoTool).toHaveBeenCalledTimes(1);
  });

  it('calls MCP again for a different query from the same user/branch', async () => {
    const { service, callSilpoTool } = productSubject({ products: [{ slug: 'milk-1', name: 'Milk' }] });

    await service.searchProducts('user-1', { q: 'milk' });
    await service.searchProducts('user-1', { q: 'bread' });

    expect(callSilpoTool).toHaveBeenCalledTimes(2);
  });

  it('calls MCP again for the same query from a different user', async () => {
    const { service, callSilpoTool } = productSubject({ products: [{ slug: 'milk-1', name: 'Milk' }] });

    await service.searchProducts('user-1', { q: 'milk' });
    await service.searchProducts('user-2', { q: 'milk' });

    expect(callSilpoTool).toHaveBeenCalledTimes(2);
  });

  it('calls MCP again for the same query with a different limit', async () => {
    const { service, callSilpoTool } = productSubject({ products: [{ slug: 'milk-1', name: 'Milk' }] });

    await service.searchProducts('user-1', { q: 'milk', limit: 10 });
    await service.searchProducts('user-1', { q: 'milk', limit: 20 });

    expect(callSilpoTool).toHaveBeenCalledTimes(2);
  });

  it('calls MCP again once the resolved timeslot rolls over, even within the TTL window', async () => {
    const { service, callSilpoTool, context } = productSubject({ products: [{ slug: 'milk-1', name: 'Milk' }] });

    await service.searchProducts('user-1', { q: 'milk' });
    context.resolveStoreContext.mockResolvedValue({
      branchId: 'branch-1', deliveryType: 'SelfPickup',
      timeslotStart: '2030-01-03T12:00:00.000Z', timeslotEnd: '2030-01-03T12:30:00.000Z'
    });
    await service.searchProducts('user-1', { q: 'milk' });

    expect(callSilpoTool).toHaveBeenCalledTimes(2);
  });

  it('stores search results with a 5-minute TTL', async () => {
    const { service, redis } = productSubject({ products: [{ slug: 'milk-1', name: 'Milk' }] });

    await service.searchProducts('user-1', { q: 'milk' });

    expect(redis.set).toHaveBeenCalledWith(expect.any(String), expect.any(String), { EX: 5 * 60 });
  });

  it('serves a repeated product-detail read for the same user/branch/slug from cache instead of calling MCP again', async () => {
    const { service, callSilpoTool } = productSubject({ product: { slug: 'milk-1', name: 'Milk' } });

    const first = await service.getProductDetails('user-1', 'milk-1');
    const second = await service.getProductDetails('user-1', 'milk-1');

    expect(second).toEqual(first);
    expect(callSilpoTool).toHaveBeenCalledTimes(1);
  });

  it('ignores a cached analysis that contains raw allergen text', async () => {
    const { service, callSilpoTool, redis } = productSubject({ product: { slug: 'milk-1', name: 'Milk' } });
    const cacheKey = 'silpo:detail:user-1:branch-1:2030-01-02T12:00:00.000Z:milk-1';
    await redis.set(cacheKey, JSON.stringify({
      product: { slug: 'milk-1', name: 'Cached secret' },
      attributes: {},
      analysis: {
        score: 53,
        confidence: 'low',
        factors: ['+3: енергетична цінність 180 кКал'],
        components: [
          { key: 'energy', label: 'Енергія', value: '180 кКал' },
          { key: 'protein', label: 'Білки', value: null },
          { key: 'fat', label: 'Жири', value: null },
          { key: 'carbohydrates', label: 'Вуглеводи', value: null },
          { key: 'ingredients', label: 'Склад / E-добавки', value: null },
          { key: 'organic', label: 'Органічність', value: null },
          { key: 'allergens', label: 'Алергени', value: 'Молоко' },
        ],
        unavailableComponents: ['protein', 'fat', 'carbohydrates', 'ingredients', 'organic'],
        algorithmVersion: 'v2',
        sourceHash: 'a'.repeat(64),
      },
    }));

    const result = await service.getProductDetails('user-1', 'milk-1');

    expect(callSilpoTool).toHaveBeenCalledTimes(1);
    expect(result.product.name).toBe('Milk');
    expect(JSON.stringify(result)).not.toContain('Молоко');
  });

  it('falls back to a live MCP call when the cache read fails, instead of throwing', async () => {
    const { service, callSilpoTool, redis } = productSubject({ products: [{ slug: 'milk-1', name: 'Milk' }] });
    redis.get.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.searchProducts('user-1', { q: 'milk' })).resolves.toEqual({
      products: [{
        silpoProductId: null, slug: 'milk-1', externalProductId: null, name: 'Milk', brandTitle: null,
        image: null, price: null, oldPrice: null, stock: null, available: null, displayRatio: null
      }]
    });
    expect(callSilpoTool).toHaveBeenCalledTimes(1);
  });
});
