import { BadGatewayException, BadRequestException, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { createClient } from 'redis';
import { SilpoConnectionService } from './silpo-connection.service';
import { SilpoOauthService } from './silpo-oauth.service';
import { ProductAnalysisService } from '../score/product-analysis.service';
import type { ProductScore } from '../score/product-score.service';
import { scoreProduct } from '../score/product-score.service';
import { normalizeProductAttributes } from '../score/product-attributes';

export type BranchQuery = { limit?: number; offset?: number; hasPickup?: boolean; q?: string };

export type BranchSummary = {
  silpoBranchId: string;
  externalId: string | null;
  city: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  hasPickup: boolean | null;
};

export type ListBranchesResponse = {
  branches: BranchSummary[];
  nextOffset: number | null;
};

export type ProductQuery = { q?: unknown; limit?: number };

export type ProductSummary = {
  silpoProductId: string | null;
  slug: string;
  externalProductId: string | null;
  name: string | null;
  brandTitle: string | null;
  image: string | null;
  price: number | null;
  oldPrice: number | null;
  stock: number | null;
  available: boolean | null;
  displayRatio: number | null;
};

export type ProductSearchResponse = { products: ProductSummary[] };
export type ProductDetailResponse = { product: ProductSummary; attributes: Record<string, string>; analysis: ProductScore };

type StoreContextResolver = {
  resolveStoreContext(userId: string): Promise<Record<string, unknown>>;
};

export type RedisCacheStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  connect?(): Promise<unknown>;
  quit?(): Promise<unknown>;
  isOpen?: boolean;
};

const MCP_RESULT_CACHE_TTL_SECONDS = 5 * 60;

@Injectable()
export class SilpoProductService implements OnModuleDestroy {
  private readonly branchCache = new Map<string, { expiresAt: number; branches: BranchSummary[]; nextOffset: number | null }>();
  private readonly redis: RedisCacheStore;

  constructor(
    private readonly connections: SilpoConnectionService,
    private readonly oauth: SilpoOauthService,
    @Optional() private readonly context?: StoreContextResolver,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() private readonly analyses?: ProductAnalysisService,
    @Optional() redis?: RedisCacheStore
  ) {
    this.redis = redis ?? (createClient({ url: process.env.REDIS_URL }) as unknown as RedisCacheStore);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.isOpen) await this.redis.quit?.();
  }

  // Best-effort: a Redis problem must never break a live MCP read, only skip the shortcut.
  private async cacheGet<T>(key: string): Promise<T | null> {
    try {
      if (!this.redis.isOpen) await this.redis.connect?.();
      const raw = await this.redis.get(key);
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }

  private async cacheSet(key: string, value: unknown): Promise<void> {
    try {
      if (!this.redis.isOpen) await this.redis.connect?.();
      await this.redis.set(key, JSON.stringify(value), { EX: MCP_RESULT_CACHE_TTL_SECONDS });
    } catch {
      // best-effort
    }
  }

  async listBranches(userId: string, query: BranchQuery): Promise<ListBranchesResponse> {
    const search = query.q?.trim().toLocaleLowerCase();
    if (search) {
      const { branches } = await this.listBranches(userId, { limit: 500, offset: 0, hasPickup: query.hasPickup });
      const tokens = search.split(/\s+/);
      return {
        branches: branches.filter((branch) => {
          const text = `${branch.city ?? ''} ${branch.address ?? ''}`.toLocaleLowerCase();
          return tokens.every((token) => text.includes(token));
        }),
        nextOffset: null
      };
    }

    const limit = clamp(query.limit, 1, 500, 25);
    const offset = Math.max(0, Number.isFinite(query.offset) ? Math.floor(query.offset as number) : 0);
    const cached = query.hasPickup !== true && limit === 500 && offset === 0 ? this.branchCache.get(userId) : undefined;
    if (cached && cached.expiresAt > Date.now()) return { branches: cached.branches, nextOffset: cached.nextOffset };
    const args: Record<string, unknown> = { limit, offset };
    if (query.hasPickup === true) args.hasPickup = true;

    const payload = await this.connections.withReadAccess(userId, (token) =>
      this.oauth.callSilpoTool(token, 'silpo_list_branches', args, 'cartwise-branches')
    );

    const raw = Array.isArray(payload.branches) ? (payload.branches as unknown[]) : null;
    if (!raw) throw new BadGatewayException('Silpo branches unavailable');

    const branches = raw.map(toBranchSummary).filter((branch): branch is BranchSummary => branch !== null);
    const total = num((payload.meta as Record<string, unknown> | undefined)?.total);
    const nextOffset = total !== null && offset + raw.length < total ? offset + raw.length : null;
    if (query.hasPickup !== true && limit === 500 && offset === 0) {
      this.branchCache.set(userId, { branches, nextOffset, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    }
    return { branches, nextOffset };
  }

  async searchProducts(userId: string, query: ProductQuery): Promise<ProductSearchResponse> {
    const q = typeof query.q === 'string' ? query.q.trim() : '';
    if (!q || q.length > 200) throw new BadRequestException('Invalid product query');
    const limit = clamp(query.limit, 1, 100, 20);
    const storeContext = await this.storeContext().resolveStoreContext(userId);
    const cacheKey = `silpo:search:${userId}:${storeContextCacheKey(storeContext)}:${q.toLocaleLowerCase()}:${limit}`;
    const cached = await this.cacheGet<ProductSearchResponse>(cacheKey);
    if (cached) return cached;
    const payload = await this.connections.withReadAccess(userId, (token) =>
      this.oauth.callSilpoTool(token, 'silpo_find_products_batch', { ...storeContext, products: [q], limit }, 'cartwise-products-search')
    );
    const rawProducts = Array.isArray(payload.products) ? payload.products : productsFromQueries(payload.queries);
    if (!rawProducts) throw new BadGatewayException('Silpo products unavailable');
    const result = { products: rawProducts.map(toProductSummary).filter((product): product is ProductSummary => product !== null) };
    await this.cacheSet(cacheKey, result);
    return result;
  }

  async getProductDetails(userId: string, slug: string): Promise<ProductDetailResponse> {
    const storeContext = await this.storeContext().resolveStoreContext(userId);
    const cacheKey = `silpo:detail:${userId}:${storeContextCacheKey(storeContext)}:${slug}`;
    const cached = await this.cacheGet<unknown>(cacheKey);
    const safeCached = toProductDetailResponse(cached);
    if (safeCached) return safeCached;
    const payload = await this.connections.withReadAccess(userId, (token) =>
      this.oauth.callSilpoTool(token, 'silpo_get_product_details', { ...storeContext, slug }, 'cartwise-product-details')
    );
    if (typeof payload.product !== 'object' || payload.product === null || Array.isArray(payload.product)) {
      throw new BadGatewayException('Silpo product unavailable');
    }
    const product = toProductSummary(payload.product);
    if (!product) throw new BadGatewayException('Silpo product unavailable');
    const rawAttributes = (payload.product as Record<string, unknown>).attributes;
    if (rawAttributes !== undefined && (typeof rawAttributes !== 'object' || rawAttributes === null || Array.isArray(rawAttributes))) {
      throw new BadGatewayException('Silpo product unavailable');
    }
    const detailAttributes = toDetailAttributes(rawAttributes);
    const attributes = toPublicAttributes(detailAttributes);
    const fallbackAnalysis = scoreProduct(normalizeProductAttributes(detailAttributes));
    const providedAnalysis = this.analyses ? await this.analyses.getOrCreate(slug, detailAttributes) : fallbackAnalysis;
    const analysis = isSafeProductAnalysis(providedAnalysis) ? providedAnalysis : fallbackAnalysis;
    const result = { product, attributes, analysis };
    await this.cacheSet(cacheKey, result);
    return result;
  }

  private storeContext(): StoreContextResolver {
    if (this.context) return this.context;
    if (this.moduleRef) return this.moduleRef.get<StoreContextResolver>('STORE_CONTEXT', { strict: false });
    throw new Error('Store context unavailable');
  }
}

// Include every storeContext field that reaches the MCP call, not just
// branchId: timeslotStart/timeslotEnd roll over daily, and a stale cached
// result spanning that rollover would otherwise outlive its real timeslot.
const storeContextCacheKey = (storeContext: Record<string, unknown>): string =>
  `${str(storeContext.branchId) ?? ''}:${str(storeContext.timeslotStart) ?? ''}`;

const clamp = (value: number | undefined, min: number, max: number, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value as number)));
};

const toBranchSummary = (record: unknown): BranchSummary | null => {
  if (typeof record !== 'object' || record === null) return null;
  const row = record as Record<string, unknown>;
  const silpoBranchId = str(row.branchId);
  if (!silpoBranchId) return null;
  return {
    silpoBranchId,
    externalId: str(row.externalId),
    city: str(row.city),
    address: str(row.address),
    latitude: num(row.latitude),
    longitude: num(row.longitude),
    hasPickup: typeof row.hasPickup === 'boolean' ? row.hasPickup : null
  };
};

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

const num = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const productsFromQueries = (queries: unknown): unknown[] | null => {
  if (!Array.isArray(queries) || queries.length === 0) return null;
  const products: unknown[] = [];
  for (const query of queries) {
    if (typeof query !== 'object' || query === null || Array.isArray(query)) return null;
    const rows = (query as Record<string, unknown>).products;
    if (!Array.isArray(rows)) return null;
    products.push(...rows);
  }
  return products;
};

const toProductSummary = (record: unknown): ProductSummary | null => {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return null;
  const row = record as Record<string, unknown>;
  const slug = str(row.slug);
  if (!slug) return null;
  return {
    silpoProductId: productId(row.id ?? row.silpoProductId),
    slug,
    externalProductId: productId(row.externalProductId),
    name: str(row.name),
    brandTitle: str(row.brandTitle),
    image: str(row.image),
    price: num(row.price),
    oldPrice: num(row.oldPrice),
    stock: num(row.stock),
    available: typeof row.available === 'boolean' ? row.available : null,
    displayRatio: num(row.displayRatio)
  };
};

const productId = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
};

const MAX_ATTRIBUTE_ENTRIES = 32;
const MAX_ATTRIBUTE_OUTPUT_BYTES = 16 * 1024;
const SENSITIVE_ATTRIBUTE_KEYS = new Set([
  'accesstoken', 'authorization', 'branchid', 'companyid', 'jsonrpc', 'loyalty', 'profile',
  'refreshtoken', 'silpoexternalid', 'token'
]);

const PUBLIC_ATTRIBUTE_KEYS = new Set([
  'Країна', 'Торгова марка', 'Продавець', 'Смак',
  'Енергетична цінність (кКал/кДЖ)', 'Енергетична цінність',
  'Білки (г)', 'Жири (г)', 'Вуглеводи (г)', 'Органіка/Еко'
]);

const toDetailAttributes = (value: unknown): Record<string, string> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const attributes: Record<string, string> = {};
  let outputBytes = 2;
  for (const [key, raw] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (SENSITIVE_ATTRIBUTE_KEYS.has(normalized)) continue;
    const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
    if (typeof text !== 'string' || !text.trim() || key.length > 128 || text.length > 4096) continue;
    if (Object.keys(attributes).length >= MAX_ATTRIBUTE_ENTRIES) break;
    const entryBytes = Buffer.byteLength(JSON.stringify(key), 'utf8') + Buffer.byteLength(JSON.stringify(text), 'utf8') + 2;
    if (outputBytes + entryBytes > MAX_ATTRIBUTE_OUTPUT_BYTES) break;
    attributes[key] = text;
    outputBytes += entryBytes;
  }
  return attributes;
};

const toPublicAttributes = (attributes: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(attributes).filter(([key]) => PUBLIC_ATTRIBUTE_KEYS.has(key)));

const productComponentKeys: ProductScore['components'][number]['key'][] = ['energy', 'protein', 'fat', 'carbohydrates', 'ingredients', 'organic', 'allergens'];
const productComponentLabels: Record<ProductScore['components'][number]['key'], string> = {
  energy: 'Енергія', protein: 'Білки', fat: 'Жири', carbohydrates: 'Вуглеводи',
  ingredients: 'Склад / E-добавки', organic: 'Органічність', allergens: 'Алергени'
};
const productComponentValuePatterns: Record<Exclude<ProductScore['components'][number]['key'], 'allergens'>, RegExp> = {
  energy: /^\d+(?:\.\d+)? кКал$/,
  protein: /^\d+(?:\.\d+)? г$/,
  fat: /^\d+(?:\.\d+)? г$/,
  carbohydrates: /^\d+(?:\.\d+)? г$/,
  ingredients: /^(?:Склад є, E-добавок не знайдено|\d+ E-добавок)$/,
  organic: /^(?:Органічний|Не органічний)$/
};
const safeFactor = /^[+-]\d+: (?:енергетична цінність \d+(?:\.\d+)? кКал|білки \d+(?:\.\d+)? г|жири \d+(?:\.\d+)? г|вуглеводи \d+(?:\.\d+)? г|\d+ E-добавок у складі|підтверджено органічний товар)$/;

const isSafeProductAnalysis = (value: unknown): value is ProductScore => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join() !== 'algorithmVersion,components,confidence,factors,score,sourceHash,unavailableComponents'
    || row.algorithmVersion !== 'v2'
    || typeof row.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.sourceHash)
    || (row.score === null) !== (row.confidence === null)
    || (row.score !== null && (typeof row.score !== 'number' || !Number.isInteger(row.score) || row.score < 0 || row.score > 100))
    || !(row.confidence === null || row.confidence === 'low' || row.confidence === 'medium' || row.confidence === 'high')
    || !Array.isArray(row.factors) || !row.factors.every((item) => typeof item === 'string' && safeFactor.test(item))
    || !Array.isArray(row.components) || row.components.length !== productComponentKeys.length
    || !Array.isArray(row.unavailableComponents) || row.unavailableComponents.length > productComponentKeys.length
    || !row.unavailableComponents.every((key) => typeof key === 'string' && productComponentKeys.includes(key as ProductScore['components'][number]['key']))) return false;

  const components = row.components as Record<string, unknown>[];
  if (!components.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item))) return false;
  const keys = components.map((item) => item.key);
  if (!keys.every((key) => typeof key === 'string' && productComponentKeys.includes(key as ProductScore['components'][number]['key']))
    || new Set(keys).size !== productComponentKeys.length
    || !productComponentKeys.every((key) => keys.includes(key))
    || new Set(row.unavailableComponents).size !== row.unavailableComponents.length
    || JSON.stringify(row.unavailableComponents) !== JSON.stringify(components.filter((item) => item.value === null).map((item) => item.key))) return false;
  const available = productComponentKeys.length - row.unavailableComponents.length;
  const expectedConfidence = available === 0 ? null : available <= 2 ? 'low' : available <= 4 ? 'medium' : 'high';
  if (row.confidence !== expectedConfidence || (row.score === null) !== (available === 0)) return false;
  return components.every((item) => {
    const key = item.key as ProductScore['components'][number]['key'];
    if (Object.keys(item).sort().join() !== 'key,label,value' || item.label !== productComponentLabels[key]) return false;
    if (item.value === null) return true;
    if (typeof item.value !== 'string') return false;
    return key === 'allergens' ? item.value === 'Є дані від Сільпо' : productComponentValuePatterns[key].test(item.value);
  });
};

const toProductDetailResponse = (value: unknown): ProductDetailResponse | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const product = toProductSummary(row.product);
  if (!product || !isSafeProductAnalysis(row.analysis)) return null;
  return { product, attributes: toPublicAttributes(toDetailAttributes(row.attributes)), analysis: row.analysis };
};
