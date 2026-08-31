/**
 * Opt-in, read-only contract research. Emits aggregate metadata only.
 * CARTWISE_MCP_CONTRACT_RESEARCH=true npm test -- mcp-contract-research.live.spec.ts
 */
import { SilpoConnectionService } from './silpo-connection.service';
import { SilpoOauthService, type SanitizedMcpTool } from './silpo-oauth.service';

const enabled = process.env.CARTWISE_MCP_CONTRACT_RESEARCH === 'true';
const describeLive = enabled ? describe : describe.skip;
const ALLOWED = new Set([
  'silpo_get_my_shopping_cart', 'silpo_get_shopping_cart_by_id', 'silpo_get_time_slots',
  'silpo_list_branches', 'silpo_find_products_batch', 'silpo_get_product_details',
  'silpo_get_my_coupons', 'silpo_get_coupon_details', 'silpo_get_my_promos', 'silpo_get_promo_codes', 'silpo_get_promotions',
  'silpo_get_products', 'silpo_get_categories', 'silpo_get_categories_tree', 'silpo_get_category'
]);
const TERMS = ['печиво', 'цукерки', 'вода', 'сік', 'ковбаса', 'яйця', 'банани', 'помідори', 'картопля', 'масло'];

type Row = Record<string, unknown>;
type Field = { path: string; type: string };
type Outcome = 'available' | 'unavailable' | 'schema_blocked' | 'empty' | 'invalid_response';
type Result = { outcome: Outcome; fields: Field[] };

describeLive('live: Silpo MCP product and benefit contracts', () => {
  jest.setTimeout(180_000);

  it('uses only the documented read-only tools and prints no values', async () => {
    const report: {
      status: 'PASS' | 'BLOCKED'; blockCode?: string; callCounts: Record<string, number>;
      toolSchemas: Record<string, SchemaView | null>; searchResponse: Result | null; searchTotalFound: number[]; couponDetails: { listed: number; accepted: number; idsMatchInput: boolean; fields: Field[] }; categoryResponses: Record<string, Result>; ketchupDetail: Result | null; products: { detailedCount: number; attributeKeyCounts: Record<string, number>; ingredients: number; eCodes: number };
      benefits: Record<string, Result>;
    } = {
      status: 'BLOCKED', callCounts: { toolsList: 0 }, toolSchemas: {}, searchResponse: null, searchTotalFound: [], couponDetails: { listed: 0, accepted: 0, idsMatchInput: false, fields: [] }, categoryResponses: {}, ketchupDetail: null,
      products: { detailedCount: 0, attributeKeyCounts: {}, ingredients: 0, eCodes: 0 }, benefits: {}
    };
    const originalFetch = globalThis.fetch;
    const oauth = new SilpoOauthService({} as never);
    const connections = new SilpoConnectionService(oauth);
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/mcp')) {
        const body = typeof init?.body === 'string' ? json(init.body) : null;
        if (body?.method === 'tools/list') report.callCounts.toolsList += 1;
        else if (body?.method === 'tools/call') {
          const name = row(body.params)?.name;
          if (typeof name !== 'string' || !ALLOWED.has(name)) throw new Error('tool outside research allowlist');
          report.callCounts[name] = (report.callCounts[name] ?? 0) + 1;
        } else throw new Error('method outside research allowlist');
      }
      return originalFetch(input, init);
    };

    try {
      await connections.withTrackingReadAccess(async (token) => {
        const catalog = await oauth.listMcpTools(token);
        for (const name of ALLOWED) report.toolSchemas[name] = schemaView(catalog.find((tool) => tool.name === name));

        const cart = await callEmpty(oauth, token, catalog, 'silpo_get_my_shopping_cart');
        const cartContextValue = await cartContext(oauth, token, catalog, cart);
        if (!cartContextValue) throw new Error('cart_context_unavailable');
        const context = await refreshContext(oauth, token, catalog, cartContextValue);

        const searchTool = catalog.find((tool) => tool.name === 'silpo_find_products_batch');
        const detailsTool = catalog.find((tool) => tool.name === 'silpo_get_product_details');
        if (!searchTool || !detailsTool) throw new Error('product_tool_unavailable');

        const coupons = await callEmpty(oauth, token, catalog, 'silpo_get_my_coupons');
        report.benefits.silpo_get_my_coupons = inventory(coupons);
        report.benefits.silpo_get_my_promos = inventory(await callEmpty(oauth, token, catalog, 'silpo_get_my_promos'));
        report.benefits.silpo_get_promo_codes = inventory(await callEmpty(oauth, token, catalog, 'silpo_get_promo_codes'));
        const couponIds = scalars(coupons, 'id').filter((id): id is number => typeof id === 'number').slice(0, 20);
        const couponDetails = await Promise.all(couponIds.map((id) => couponDetailsById(oauth, token, catalog, id)));
        const acceptedDetails = couponDetails.filter((detail): detail is Row => detail !== null);
        const fields = [...new Map(acceptedDetails.flatMap((detail) => inventory(detail).fields).map((field) => [`${field.path}:${field.type}`, field])).values()];
        report.couponDetails = { listed: couponIds.length, accepted: acceptedDetails.length, idsMatchInput: acceptedDetails.length === couponIds.length && acceptedDetails.every((detail, index) => scalar(detail, 'id') === couponIds[index]), fields };
        report.benefits.silpo_get_coupon_details = acceptedDetails.length ? { outcome: 'available', fields } : { outcome: 'unavailable', fields: [] };
        report.benefits.silpo_get_promotions = inventory(await callContext(oauth, token, catalog, 'silpo_get_promotions', context));

        const categories = await callContext(oauth, token, catalog, 'silpo_get_categories', context);
        report.categoryResponses.silpo_get_categories = inventory(categories);
        report.categoryResponses.silpo_get_categories_tree = inventory(await callContext(oauth, token, catalog, 'silpo_get_categories_tree', context));
        report.categoryResponses.silpo_get_products = inventory(await callContext(oauth, token, catalog, 'silpo_get_products', context));
        report.categoryResponses.silpo_get_category = inventory(await categoryDetail(oauth, token, catalog, context, categories));

        const ketchup = await oauth.callSilpoTool(token, 'silpo_find_products_batch', { ...context, products: ['кетчуп'], limit: 1 }, 'cartwise-contract-ketchup-search');
        const ketchupSlug = text(products(ketchup)[0]?.slug);
        if (ketchupSlug) {
          report.ketchupDetail = inventory(await oauth.callSilpoTool(token, 'silpo_get_product_details', { ...context, slug: ketchupSlug }, 'cartwise-contract-ketchup-detail'));
        }

        const slugs = new Set<string>();
        for (const term of TERMS) {
          const payload = await oauth.callSilpoTool(token, 'silpo_find_products_batch', { ...context, products: [term], limit: 20 }, `cartwise-contract-search-${slugs.size}`);
          report.searchResponse ??= inventory(payload);
          report.searchTotalFound.push(...(Array.isArray(payload.queries) ? payload.queries.map((query) => row(query)?.totalFound).filter((total): total is number => typeof total === 'number' && Number.isFinite(total)) : []));
          for (const product of products(payload)) {
            const slug = text(product.slug);
            if (slug) slugs.add(slug);
            if (slugs.size === 20) break;
          }
          if (slugs.size === 20) break;
        }
        for (const slug of slugs) {
          const payload = await oauth.callSilpoTool(token, 'silpo_get_product_details', { ...context, slug }, `cartwise-contract-detail-${report.products.detailedCount}`);
          const attributes = row(row(payload.product)?.attributes);
          if (!attributes) throw new Error('malformed_product_detail');
          report.products.detailedCount += 1;
          for (const [key, value] of Object.entries(attributes)) {
            report.products.attributeKeyCounts[safeKey(key)] = (report.products.attributeKeyCounts[safeKey(key)] ?? 0) + 1;
            if (key === 'Склад' && text(value)) {
              report.products.ingredients += 1;
              if (/\bE\d{3,4}\b/i.test(text(value)!)) report.products.eCodes += 1;
            }
          }
        }

      });
      report.status = 'PASS';
      expect(report.products.detailedCount).toBeLessThanOrEqual(20);
      expect(report.callCounts.toolsList).toBe(1);
    } catch (error) {
      report.blockCode = error instanceof Error ? error.message : 'provider_error';
      throw error;
    } finally {
      console.log(JSON.stringify(report));
      globalThis.fetch = originalFetch;
      await close((connections as unknown as { pool: { end(): Promise<void> } }).pool);
      await close((oauth as unknown as { pool: { end(): Promise<void> } }).pool);
    }
  });
});

const callEmpty = async (oauth: SilpoOauthService, token: string, catalog: SanitizedMcpTool[], name: string): Promise<Row | null> => {
  const tool = catalog.find((item) => item.name === name);
  if (!tool || !acceptsEmpty(tool.inputSchema)) return null;
  try { return await oauth.callSilpoTool(token, name, {}, `cartwise-contract-${name}`); } catch { return null; }
};

const cartContext = async (oauth: SilpoOauthService, token: string, catalog: SanitizedMcpTool[], cart: Row | null): Promise<Row | null> => {
  const cartTool = catalog.find((item) => item.name === 'silpo_get_shopping_cart_by_id');
  const id = find(cart, 'shoppingCartId');
  if (!cartTool || !id || !singleRequiredString(cartTool.inputSchema, 'shoppingCartId')) return null;
  const detail = await oauth.callSilpoTool(token, 'silpo_get_shopping_cart_by_id', { shoppingCartId: id }, 'cartwise-contract-cart-context');
  const branchId = find(detail, 'branchId');
  const deliveryType = find(detail, 'deliveryType');
  const timeslot = findRow(detail, 'timeslot');
  const start = text(timeslot?.start);
  const end = text(timeslot?.end);
  return branchId && deliveryType && start && end ? { branchId, deliveryType, timeslotStart: start, timeslotEnd: end } : null;
};

const couponDetailsById = async (oauth: SilpoOauthService, token: string, catalog: SanitizedMcpTool[], businessCouponId: number): Promise<Row | null> => {
  const tool = catalog.find((item) => item.name === 'silpo_get_coupon_details');
  if (!tool || !singleRequiredNumber(tool.inputSchema, 'businessCouponId')) return null;
  try { return await oauth.callSilpoTool(token, 'silpo_get_coupon_details', { businessCouponId }, 'cartwise-contract-coupon-details'); } catch { return null; }
};

const refreshContext = async (oauth: SilpoOauthService, token: string, catalog: SanitizedMcpTool[], context: Row): Promise<Row> => {
  const tool = catalog.find((item) => item.name === 'silpo_get_time_slots');
  if (!tool || !singleRequiredString(tool.inputSchema, 'branchId')) return context;
  const slots = await oauth.callSilpoTool(token, 'silpo_get_time_slots', { branchId: context.branchId }, 'cartwise-contract-time-slots');
  const start = find(slots, 'start'); const end = find(slots, 'end');
  return start && end ? { ...context, timeslotStart: start, timeslotEnd: end } : context;
};

const callContext = async (oauth: SilpoOauthService, token: string, catalog: SanitizedMcpTool[], name: string, context: Row): Promise<Row | null> => {
  const tool = catalog.find((item) => item.name === name);
  const required = Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : null;
  if (!tool || !required || required.some((key) => typeof key !== 'string' || context[key] === undefined)) return null;
  try { return await oauth.callSilpoTool(token, name, Object.fromEntries(required.map((key) => [key, context[key]])), `cartwise-contract-${name}`); } catch { return null; }
};

const categoryDetail = async (oauth: SilpoOauthService, token: string, catalog: SanitizedMcpTool[], context: Row, categories: Row | null): Promise<Row | null> => {
  const slug = find(categories, 'slug');
  const tool = catalog.find((item) => item.name === 'silpo_get_category');
  if (!slug || !tool || !Array.isArray(tool.inputSchema?.required) || tool.inputSchema.required.some((key) => typeof key !== 'string' || (key !== 'categorySlug' && context[key] === undefined))) return null;
  try { return await oauth.callSilpoTool(token, 'silpo_get_category', { branchId: context.branchId, deliveryType: context.deliveryType, categorySlug: slug }, 'cartwise-contract-category'); } catch { return null; }
};

const acceptsEmpty = (schema: Record<string, unknown> | undefined): boolean => schema?.type === 'object' && (!Array.isArray(schema.required) || schema.required.length === 0);
const singleRequiredString = (schema: Record<string, unknown> | undefined, key: string): boolean => schema?.type === 'object' && Array.isArray(schema.required) && schema.required.length === 1 && schema.required[0] === key && row(schema.properties)?.[key] !== undefined;
const singleRequiredNumber = (schema: Record<string, unknown> | undefined, key: string): boolean => schema?.type === 'object' && Array.isArray(schema.required) && schema.required.length === 1 && schema.required[0] === key && row(row(schema.properties)?.[key])?.type === 'number';
const row = (value: unknown): Row | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Row : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
const json = (value: string): Row | null => { try { return row(JSON.parse(value)); } catch { return null; } };
const find = (value: unknown, key: string, depth = 0): string | null => {
  if (depth > 5) return null;
  if (Array.isArray(value)) return value.map((item) => find(item, key, depth + 1)).find((item): item is string => item !== null) ?? null;
  const current = row(value); if (!current) return null;
  return text(current[key]) ?? Object.values(current).map((item) => find(item, key, depth + 1)).find((item): item is string => item !== null) ?? null;
};
const scalar = (value: unknown, key: string, depth = 0): string | number | null => {
  if (depth > 5) return null;
  if (Array.isArray(value)) return value.map((item) => scalar(item, key, depth + 1)).find((item): item is string | number => item !== null) ?? null;
  const current = row(value); if (!current) return null;
  const direct = current[key];
  if (typeof direct === 'string' && direct.trim()) return direct;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  return Object.values(current).map((item) => scalar(item, key, depth + 1)).find((item): item is string | number => item !== null) ?? null;
};
const scalars = (value: unknown, key: string, depth = 0): (string | number)[] => {
  if (depth > 5) return [];
  if (Array.isArray(value)) return value.flatMap((item) => scalars(item, key, depth + 1));
  const current = row(value); if (!current) return [];
  const direct = current[key];
  const own = typeof direct === 'string' && direct.trim() ? [direct] : typeof direct === 'number' && Number.isFinite(direct) ? [direct] : [];
  return [...own, ...Object.values(current).flatMap((item) => scalars(item, key, depth + 1))];
};
const findRow = (value: unknown, key: string, depth = 0): Row | null => {
  if (depth > 5 || Array.isArray(value)) return null;
  const current = row(value); if (!current) return null;
  return row(current[key]) ?? Object.values(current).map((item) => findRow(item, key, depth + 1)).find((item): item is Row => item !== null) ?? null;
};
const products = (payload: Row): Row[] => Array.isArray(payload.products) ? payload.products.map(row).filter((item): item is Row => item !== null) : (Array.isArray(payload.queries) ? payload.queries.flatMap((query) => Array.isArray(row(query)?.products) ? row(query)!.products as unknown[] : []).map(row).filter((item): item is Row => item !== null) : []);
const safeKey = (key: string): string => /^[А-Яа-яІіЇїЄєA-Za-z0-9 /()'’.-]{1,128}$/.test(key) && !/token|cookie|session|address|phone|email/i.test(key) ? key : '{}';
const inventory = (payload: Row | null): Result => {
  if (!payload) return { outcome: 'unavailable', fields: [] };
  const fields: Field[] = []; const visit = (value: unknown, path: string, depth: number): boolean => {
    if (depth > 4 || fields.length >= 128) return false;
    if (Array.isArray(value)) { fields.push({ path: `${path}[]`, type: 'array' }); return value.length === 0 || visit(value[0], `${path}[]`, depth + 1); }
    const current = row(value); if (!current) { fields.push({ path, type: value === null ? 'null' : typeof value }); return true; }
    fields.push({ path, type: 'object' }); return Object.entries(current).every(([key, item]) => visit(item, `${path}.${safeKey(key)}`, depth + 1));
  };
  return visit(payload, '$', 0) ? { outcome: fields.length === 1 && fields[0].type === 'object' ? 'empty' : 'available', fields } : { outcome: 'invalid_response', fields: [] };
};
const schemaView = (tool: SanitizedMcpTool | undefined): SchemaView | null => tool?.inputSchema ? { type: typeof tool.inputSchema.type === 'string' ? tool.inputSchema.type : null, required: Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required.filter((key): key is string => typeof key === 'string') : [], properties: Object.fromEntries(Object.entries(row(tool.inputSchema.properties) ?? {}).map(([key, value]) => [key, { type: typeof row(value)?.type === 'string' ? row(value)!.type as string : null }])) } : null;
type SchemaView = { type: string | null; required: string[]; properties: Record<string, { type: string | null }> };
const close = async (pool: { end(): Promise<void> }): Promise<void> => { try { await pool.end(); } catch { /* best effort */ } };
