/**
 * Opt-in, read-only Product Score v2 evidence through the marked tracking
 * connection.
 *
 *   CARTWISE_PRODUCT_SCORE_V2_PROBE=true \
 *   npm test -- product-score-v2.live.spec.ts
 *
 * The test prints aggregate coverage only. It never prints provider rows,
 * identifiers, names, slugs, attribute values, request bodies, or credentials.
 */
import { SilpoConnectionService } from './silpo-connection.service';
import { SilpoOauthService, type SanitizedMcpTool } from './silpo-oauth.service';

const enabled = process.env.CARTWISE_PRODUCT_SCORE_V2_PROBE === 'true';
const describeLive = enabled ? describe : describe.skip;
const ALLOWED_TOOL_NAMES = new Set([
  'silpo_list_branches',
  'silpo_find_products_batch',
  'silpo_get_product_details'
]);
const SEARCH_TERMS = ['молоко', 'йогурт', 'сир', 'хліб', 'крупа', 'яблуко'];

type Row = Record<string, unknown>;
type BlockCode =
  | 'connection_unavailable'
  | 'authorization_required'
  | 'branch_context_missing'
  | 'target_schema_missing'
  | 'target_schema_invalid'
  | 'insufficient_products'
  | 'malformed_product_detail'
  | 'provider_error';

type Metadata = {
  status: 'PASS' | 'BLOCKED';
  blockCode?: BlockCode;
  detailedProductCount: number;
  attributeKeyCounts: Record<string, number>;
  normalizedCandidateFieldCounts: Record<string, number>;
  valueFormats: {
    commaDecimal: number;
    energySplit: number;
    stablePortionWeight: number;
  };
  presenceEvidence: {
    ingredients: number;
    eCodes: number;
    allergens: number;
    organic: number;
  };
  toolSchemas: {
    search: SchemaView | null;
    details: SchemaView | null;
  };
  barcode: 'confirmed' | 'not_confirmed';
  callCounts: {
    toolsList: number;
    branches: number;
    productSearch: number;
    productDetails: number;
  };
};

type SchemaView = {
  type: string | null;
  required: string[];
  properties: Record<string, SchemaNode>;
};

type SchemaNode = {
  type: string | null;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
};

class ProbeBlocked extends Error {
  constructor(readonly code: BlockCode) {
    super(code);
  }
}

describeLive('live: MCP Product Score v2 evidence', () => {
  jest.setTimeout(180_000);

  it('collects aggregate score-field coverage using only the read-only MCP allowlist', async () => {
    const metadata = emptyMetadata();
    const originalFetch = globalThis.fetch;
    const oauth = new SilpoOauthService({} as never);
    const connections = new SilpoConnectionService(oauth);

    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/mcp')) {
        const body = typeof init?.body === 'string' ? parseJson(init.body) : null;
        const method = body?.method;
        if (method === 'tools/list') {
          metadata.callCounts.toolsList += 1;
        } else if (method === 'tools/call') {
          const name = record(body?.params)?.name;
          if (typeof name !== 'string' || !ALLOWED_TOOL_NAMES.has(name)) {
            throw new Error('MCP tool outside Product Score v2 allowlist');
          }
          if (name === 'silpo_list_branches') metadata.callCounts.branches += 1;
          if (name === 'silpo_find_products_batch') metadata.callCounts.productSearch += 1;
          if (name === 'silpo_get_product_details') metadata.callCounts.productDetails += 1;
        } else {
          throw new Error('MCP method outside Product Score v2 allowlist');
        }
      }
      return originalFetch(input, init);
    };

    try {
      await connections.withTrackingReadAccess(async (token) => {
        const tools = await oauth.listMcpTools(token);
        const searchTool = tools.find(({ name }) => name === 'silpo_find_products_batch');
        const detailsTool = tools.find(({ name }) => name === 'silpo_get_product_details');
        metadata.toolSchemas.search = schemaView(searchTool);
        metadata.toolSchemas.details = schemaView(detailsTool);
        if (!searchTool || !detailsTool) throw new ProbeBlocked('target_schema_missing');
        if (!hasValidInputSchema(searchTool) || !hasValidInputSchema(detailsTool)) {
          throw new ProbeBlocked('target_schema_invalid');
        }

        const branchesPayload = await oauth.callSilpoTool(
          token,
          'silpo_list_branches',
          { limit: 1, offset: 0 },
          'cartwise-product-score-v2-branch'
        );
        const branchId = text(records(branchesPayload.branches)[0]?.branchId);
        if (!branchId) throw new ProbeBlocked('branch_context_missing');

        const context = futureSelfPickupContext(branchId);
        const slugs = new Set<string>();
        for (const term of SEARCH_TERMS) {
          const payload = await oauth.callSilpoTool(
            token,
            'silpo_find_products_batch',
            { ...context, products: [term], limit: 20 },
            `cartwise-product-score-v2-search-${metadata.callCounts.productSearch}`
          );
          for (const row of productRows(payload)) {
            const slug = text(row.slug);
            if (slug) slugs.add(slug);
            if (slugs.size >= 20) break;
          }
          if (slugs.size >= 20) break;
        }
        if (slugs.size < 10) throw new ProbeBlocked('insufficient_products');

        const selectedSlugs = [...slugs].slice(0, 20);
        let barcodeCandidate: string | null = null;
        for (const slug of selectedSlugs) {
          const payload = await oauth.callSilpoTool(
            token,
            'silpo_get_product_details',
            { ...context, slug },
            `cartwise-product-score-v2-details-${metadata.callCounts.productDetails}`
          );
          const product = record(payload.product);
          if (!product) throw new ProbeBlocked('malformed_product_detail');
          const attributes = record(product.attributes) ?? {};
          metadata.detailedProductCount += 1;
          collectCoverage(metadata, attributes);
          barcodeCandidate ??= findBarcodeCandidate(attributes);
        }

        if (barcodeCandidate && supportsProductExactSearch(searchTool.inputSchema)) {
          const payload = await oauth.callSilpoTool(
            token,
            'silpo_find_products_batch',
            { ...context, products: [barcodeCandidate], limit: 20 },
            `cartwise-product-score-v2-barcode-${metadata.callCounts.productSearch}`
          );
          metadata.barcode = productRows(payload).some((row) => hasMatchingBarcode(row, barcodeCandidate!))
            ? 'confirmed'
            : 'not_confirmed';
        }

        expect(metadata.detailedProductCount).toBeGreaterThanOrEqual(10);
        expect(metadata.detailedProductCount).toBeLessThanOrEqual(20);
        expect(metadata.callCounts.toolsList).toBe(1);
        expect(metadata.callCounts.branches).toBe(1);
        expect(metadata.callCounts.productDetails).toBe(metadata.detailedProductCount);
      });

      metadata.status = 'PASS';
      console.log(JSON.stringify(metadata));
    } catch (error) {
      metadata.status = 'BLOCKED';
      metadata.blockCode = error instanceof ProbeBlocked ? error.code : blockCode(error);
      console.log(JSON.stringify(metadata));
      throw new Error('MCP Product Score v2 live probe blocked', { cause: error });
    } finally {
      globalThis.fetch = originalFetch;
      await closePool((connections as unknown as { pool: { end(): Promise<void> } }).pool);
      await closePool((oauth as unknown as { pool: { end(): Promise<void> } }).pool);
    }
  });
});

const emptyMetadata = (): Metadata => ({
  status: 'BLOCKED',
  detailedProductCount: 0,
  attributeKeyCounts: {},
  normalizedCandidateFieldCounts: {
    energyKcal: 0,
    proteinGrams: 0,
    fatGrams: 0,
    carbohydrateGrams: 0,
    ingredients: 0,
    additiveCodes: 0,
    allergenText: 0,
    isOrganic: 0,
    portionWeight: 0
  },
  valueFormats: { commaDecimal: 0, energySplit: 0, stablePortionWeight: 0 },
  presenceEvidence: { ingredients: 0, eCodes: 0, allergens: 0, organic: 0 },
  toolSchemas: { search: null, details: null },
  barcode: 'not_confirmed',
  callCounts: { toolsList: 0, branches: 0, productSearch: 0, productDetails: 0 }
});

const record = (value: unknown): Row | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Row : null;

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() :
    typeof value === 'number' && Number.isFinite(value) ? String(value) : null;

const productRows = (payload: Row): Row[] => {
  const direct = records(payload.products);
  if (direct.length) return direct;
  return records(payload.queries).flatMap((query) => records(query.products));
};

const records = (value: unknown): Row[] =>
  Array.isArray(value) ? value.map(record).filter((row): row is Row => row !== null) : [];

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

const collectCoverage = (metadata: Metadata, attributes: Row): void => {
  for (const [key, value] of Object.entries(attributes)) {
    metadata.attributeKeyCounts[key] = (metadata.attributeKeyCounts[key] ?? 0) + 1;
    const valueText = text(value);
    if (!valueText) continue;
    if (/\d+[.,]\d+/.test(valueText) && valueText.includes(',')) metadata.valueFormats.commaDecimal += 1;
    if (isEnergyKey(key) && /^\s*\d+(?:[.,]\d+)?\s*\/\s*\d+(?:[.,]\d+)?\s*$/.test(valueText)) {
      metadata.valueFormats.energySplit += 1;
    }
    const candidate = candidateField(key);
    if (candidate && candidate !== 'additiveCodes' && candidate !== 'isOrganic') {
      metadata.normalizedCandidateFieldCounts[candidate] += 1;
    }
    if (isPortionWeightKey(key) && stablePortionWeight(valueText)) {
      metadata.valueFormats.stablePortionWeight += 1;
    }
  }

  const ingredients = valueFor(attributes, ['Склад']);
  const allergens = valueFor(attributes, ['Містить алергени', 'Алергени']);
  const organic = valueFor(attributes, ['Органіка/Еко']);
  const eCodes = ingredients?.match(/\bE\d{3,4}\b/gi) ?? [];
  if (ingredients) {
    metadata.presenceEvidence.ingredients += 1;
  }
  if (eCodes.length) metadata.presenceEvidence.eCodes += 1;
  if (eCodes.length) metadata.normalizedCandidateFieldCounts.additiveCodes += 1;
  if (allergens) {
    metadata.presenceEvidence.allergens += 1;
  }
  if (organic) {
    metadata.presenceEvidence.organic += 1;
    if (/органічн|неорганічн/i.test(organic)) metadata.normalizedCandidateFieldCounts.isOrganic += 1;
  }
};

const candidateField = (key: string): keyof Metadata['normalizedCandidateFieldCounts'] | null => {
  if (isEnergyKey(key)) return 'energyKcal';
  if (['Білки (г)', 'Білки'].includes(key)) return 'proteinGrams';
  if (['Жири (г)', 'Жири'].includes(key)) return 'fatGrams';
  if (['Вуглеводи (г)', 'Вуглеводи'].includes(key)) return 'carbohydrateGrams';
  if (key === 'Склад') return 'ingredients';
  if (['Містить алергени', 'Алергени'].includes(key)) return 'allergenText';
  if (key === 'Органіка/Еко') return 'isOrganic';
  if (isPortionWeightKey(key)) return 'portionWeight';
  return null;
};

const isEnergyKey = (key: string): boolean =>
  ['Енергетична цінність (кКал/кДЖ)', 'Енергетична цінність'].includes(key);

const isPortionWeightKey = (key: string): boolean =>
  ['Розмір/об\'єм', 'Вага', 'Маса', 'Об\'єм', 'Порція', 'Вага нетто'].includes(key);

const valueFor = (attributes: Row, keys: string[]): string | null => {
  for (const key of keys) {
    const value = text(attributes[key]);
    if (value) return value;
  }
  return null;
};

const stablePortionWeight = (value: string): boolean =>
  /^\s*\d+(?:[.,]\d+)?\s*(?:г|кг|мл|л|g|kg|ml|l)\s*$/i.test(value);

const findBarcodeCandidate = (attributes: Row): string | null => {
  for (const [key, value] of Object.entries(attributes)) {
    if (!/barcode|ean|штрихкод/i.test(key)) continue;
    const candidate = text(value);
    if (candidate && /^(?:\d{8}|\d{13})$/.test(candidate)) return candidate;
  }
  return null;
};

const hasMatchingBarcode = (row: Row, barcode: string): boolean =>
  Object.entries(row).some(([key, value]) => /barcode|ean|штрихкод/i.test(key) && text(value) === barcode);

const supportsProductExactSearch = (schema: Record<string, unknown> | undefined): boolean => {
  const root = record(schema);
  const properties = record(root?.properties);
  const required = root?.required;
  if (root?.type !== 'object' || !properties || !Array.isArray(required) || !required.includes('products')) return false;
  if (!required.every((key) => typeof key === 'string' && Object.hasOwn(properties, key))) return false;
  if (!required.every((key) => ['branchId', 'deliveryType', 'timeslotStart', 'timeslotEnd', 'products', 'limit'].includes(String(key)))) return false;
  if (Object.keys(root).some((key) => !['$schema', 'type', 'properties', 'required'].includes(key))) return false;
  return Object.entries(properties).every(([key, value]) => key === 'products'
    ? isUnconstrainedStringArray(value)
    : isUnconstrainedScalar(value));
};

describe('supportsProductExactSearch', () => {
  it('rejects a required key that has no property definition', () => {
    const schema = {
      type: 'object',
      properties: {
        products: { type: 'array', items: { type: 'string' } },
      },
      required: ['products', 'branchId'],
    };

    expect(supportsProductExactSearch(schema)).toBe(false);
  });
});

const isUnconstrainedStringArray = (value: unknown): boolean => {
  const schema = record(value);
  if (!schema || schema.type !== 'array' || Object.keys(schema).some((key) => !['type', 'items'].includes(key))) return false;
  return isExactStringSchema(schema.items);
};

const isExactStringSchema = (value: unknown): boolean => {
  const schema = record(value);
  return schema?.type === 'string' && Object.keys(schema).length === 1;
};

const isUnconstrainedScalar = (value: unknown): boolean => {
  const schema = record(value);
  return schema !== null
    && typeof schema.type === 'string'
    && ['string', 'integer', 'number', 'boolean'].includes(schema.type)
    && Object.keys(schema).length === 1;
};

const hasValidInputSchema = (tool: SanitizedMcpTool): boolean => {
  const schema = record(tool.inputSchema);
  const properties = record(schema?.properties);
  const required = schema?.required;
  return schema?.type === 'object'
    && properties !== null
    && Object.keys(properties).length > 0
    && (required === undefined || (Array.isArray(required)
      && required.every((key) => typeof key === 'string' && Object.hasOwn(properties, key))))
    && Object.values(properties).every((property) => isValidSchemaNode(property));
};

const isValidSchemaNode = (value: unknown, depth = 0): boolean => {
  const schema = record(value);
  if (!schema || depth > 6 || typeof schema.type !== 'string') return false;
  if (!['object', 'array', 'string', 'integer', 'number', 'boolean'].includes(schema.type)) return false;
  if (schema.type === 'array') return schema.items !== undefined && isValidSchemaNode(schema.items, depth + 1);
  if (schema.type === 'object') {
    const properties = record(schema.properties);
    return properties !== null && Object.values(properties).every((property) => isValidSchemaNode(property, depth + 1));
  }
  return true;
};

const schemaView = (tool: SanitizedMcpTool | undefined): SchemaView | null => {
  const schema = record(tool?.inputSchema);
  if (!schema) return null;
  const properties = record(schema.properties) ?? {};
  return {
    type: typeof schema.type === 'string' ? schema.type : null,
    required: Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === 'string') : [],
    properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, schemaNode(value)]))
  };
};

const schemaNode = (value: unknown, depth = 0): SchemaNode => {
  const schema = record(value);
  if (!schema || depth > 3) return { type: null };
  const node: SchemaNode = { type: typeof schema.type === 'string' ? schema.type : null };
  const properties = record(schema.properties);
  if (properties) node.properties = Object.fromEntries(Object.entries(properties).map(([key, child]) => [key, schemaNode(child, depth + 1)]));
  if (schema.items !== undefined) node.items = schemaNode(schema.items, depth + 1);
  return node;
};

const parseJson = (value: string): Row | null => {
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
};

const blockCode = (error: unknown): BlockCode => {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('tracking connection unavailable')) return 'connection_unavailable';
  if (message.includes('authorization required')) return 'authorization_required';
  return 'provider_error';
};

const closePool = async (pool: { end(): Promise<void> }): Promise<void> => {
  await pool.end();
};
