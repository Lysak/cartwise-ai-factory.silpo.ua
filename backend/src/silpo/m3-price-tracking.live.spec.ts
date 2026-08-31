/**
 * Opt-in read-only M3 preflight through the marked Cartwise tracking connection.
 *
 *   CARTWISE_M3_LIVE_PREFLIGHT=true npm test -- m3-price-tracking.live.spec.ts
 *
 * The test intentionally reports metadata only. It never prints provider rows,
 * identifiers, names, slugs, prices, request payloads, or credentials.
 */
import { SilpoConnectionService } from './silpo-connection.service';
import { SilpoOauthService } from './silpo-oauth.service';

const enabled = process.env.CARTWISE_M3_LIVE_PREFLIGHT === 'true';
const describeLive = enabled ? describe : describe.skip;
const SEARCH_TERM = 'молоко';

type Row = Record<string, unknown>;
type Metadata = {
  status: 'PASS' | 'BLOCKED';
  branchCount: number;
  candidateCount: number;
  exactQueryCount: number;
  batchRequestedCount: number;
  exactMatch: boolean[];
  slugPresent: boolean[];
  branchMatch: boolean[];
  finiteBasePrice: boolean[];
  batchMappingOnce: boolean;
  batchPreservesSlug: boolean[];
  batchPreservesPrice: boolean[];
  success: boolean;
  no429: boolean;
};

describeLive('live: M3 price-tracking preflight', () => {
  jest.setTimeout(60_000);

  it('proves exact article lookup and two-item batch invariants through tracking access', async () => {
    const metadata: Metadata = {
      status: 'BLOCKED',
      branchCount: 0,
      candidateCount: 0,
      exactQueryCount: 0,
      batchRequestedCount: 0,
      exactMatch: [],
      slugPresent: [],
      branchMatch: [],
      finiteBasePrice: [],
      batchMappingOnce: false,
      batchPreservesSlug: [],
      batchPreservesPrice: [],
      success: false,
      no429: true
    };
    let saw429 = false;
    const originalFetch = globalThis.fetch;
    const oauth = new SilpoOauthService({} as never);
    const connections = new SilpoConnectionService(oauth);

    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      if (response.status === 429) saw429 = true;
      return response;
    };

    try {
      const call = (name: string, args: Record<string, unknown>, id: string) =>
        connections.withTrackingReadAccess((token) => oauth.callSilpoTool(token, name, args, id));

      const branchesPayload = await call('silpo_list_branches', { limit: 1, offset: 0 }, 'm3-preflight-branches');
      const branches = records(branchesPayload.branches);
      metadata.branchCount = branches.length;
      const branchId = text(branches[0]?.branchId);
      expect(branches.length).toBeGreaterThan(0);
      expect(typeof branchId).toBe('string');

      const context = futureSelfPickupContext(branchId as string);
      const searchPayload = await call(
        'silpo_find_products_batch',
        { ...context, products: [SEARCH_TERM], limit: 100 },
        'm3-preflight-name-search'
      );
      const candidates = unique(
        productRows(searchPayload)
          .map((row) => text(row.externalProductId))
          .filter((value): value is string => value !== null)
      ).slice(0, 2);
      metadata.candidateCount = candidates.length;
      expect(candidates.length).toBe(2);

      const exactRows = [] as Row[];
      for (const [index, candidate] of candidates.entries()) {
        const payload = await call(
          'silpo_find_products_batch',
          { ...context, products: [candidate], limit: 1 },
          `m3-preflight-exact-${index}`
        );
        const rows = productRows(payload);
        const exact = rows.find((row) => text(row.externalProductId) === candidate);
        exactRows.push(exact ?? {});
      }
      metadata.exactQueryCount = exactRows.length;
      metadata.exactMatch = exactRows.map((row, index) => text(row.externalProductId) === candidates[index]);
      metadata.slugPresent = exactRows.map((row) => text(row.slug) !== null);
      metadata.branchMatch = exactRows.map((row) => text(row.branchId) === branchId);
      metadata.finiteBasePrice = exactRows.map((row) => finiteNumber(row.price) !== null);

      expect(metadata.exactMatch.every(Boolean)).toBe(true);
      expect(metadata.slugPresent.every(Boolean)).toBe(true);
      expect(metadata.branchMatch.every(Boolean)).toBe(true);
      expect(metadata.finiteBasePrice.every(Boolean)).toBe(true);

      const batchPayload = await call(
        'silpo_find_products_batch',
        { ...context, products: candidates, limit: 2 },
        'm3-preflight-two-item-batch'
      );
      metadata.batchRequestedCount = candidates.length;
      const batchRows = productRows(batchPayload);
      const matches = candidates.map((candidate) => batchRows.filter((row) => text(row.externalProductId) === candidate));
      metadata.batchMappingOnce = matches.every((rows) => rows.length === 1);
      metadata.batchPreservesSlug = matches.map((rows, index) => text(rows[0]?.slug) === text(exactRows[index].slug));
      metadata.batchPreservesPrice = matches.map((rows, index) => finiteNumber(rows[0]?.price) === finiteNumber(exactRows[index].price));

      expect(metadata.batchMappingOnce).toBe(true);
      expect(metadata.batchPreservesSlug.every(Boolean)).toBe(true);
      expect(metadata.batchPreservesPrice.every(Boolean)).toBe(true);
      expect(saw429).toBe(false);

      metadata.status = 'PASS';
      metadata.success = true;
      console.log(JSON.stringify({ ...metadata, no429: !saw429 }));
    } catch {
      metadata.no429 = !saw429;
      console.log(JSON.stringify(metadata));
      throw new Error('M3 live preflight blocked');
    } finally {
      globalThis.fetch = originalFetch;
      await closePool((connections as unknown as { pool: { end(): Promise<void> } }).pool);
      await closePool((oauth as unknown as { pool: { end(): Promise<void> } }).pool);
    }
  });
});

const records = (value: unknown): Row[] =>
  Array.isArray(value)
    ? value.filter((row): row is Row => typeof row === 'object' && row !== null && !Array.isArray(row))
    : [];

const productRows = (payload: Record<string, unknown>): Row[] => {
  const direct = records(payload.products);
  if (direct.length > 0) return direct;
  return records(payload.queries).flatMap((query) => records(query.products));
};

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;

const finiteNumber = (value: unknown): number | null => {
  const result = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(result) ? result : null;
};

const unique = (values: string[]): string[] => [...new Set(values)];

const futureSelfPickupContext = (branchId: string): Record<string, unknown> => {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 1);
  start.setUTCHours(12, 0, 0, 0);
  return {
    branchId,
    deliveryType: 'SelfPickup',
    timeslotStart: start.toISOString(),
    timeslotEnd: new Date(start.getTime() + 30 * 60 * 1000).toISOString()
  };
};

const closePool = async (pool: { end(): Promise<void> }): Promise<void> => {
  await pool.end();
};
