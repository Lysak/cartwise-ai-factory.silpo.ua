import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { SilpoConnectionService } from './silpo-connection.service';
import { SilpoOauthService, type SanitizedMcpTool } from './silpo-oauth.service';

const BENEFIT_TOOLS = ['silpo_get_my_coupons', 'silpo_get_my_promos', 'silpo_get_my_favorites'] as const;
const MAX_DEPTH = 4;
const MAX_PATH_LENGTH = 128;
const MAX_FIELDS = 128;
const MAX_KEYS_PER_LEVEL = 32;

export type BenefitDiscoveryField = {
  path: string;
  type: 'array' | 'boolean' | 'null' | 'number' | 'object' | 'string';
};

export type BenefitDiscoveryItem = {
  toolName: (typeof BENEFIT_TOOLS)[number];
  outcome: 'available' | 'unavailable' | 'invalid_response';
  fields: BenefitDiscoveryField[];
};

export type CatalogHint = { name: string; description: string | null; inputSchema: Record<string, unknown> | null };

export type BenefitDiscoveryReport = { tools: BenefitDiscoveryItem[]; catalogHints: CatalogHint[] };

export type PersonalBenefit = {
  active: boolean;
  description: string;
  expiresAt: string | null;
  limitText: string | null;
  rewardText: string | null;
};

export type PersonalBenefitsReport = { outcome: 'available' | 'unavailable'; benefits: PersonalBenefit[] };

// Server-authored API metadata (tool name/description/schema), not user
// data — safe to return in full. Broader net than BENEFIT_TOOLS so a
// category/product-linking tool we don't already know the name of can
// still surface here.
const CATALOG_HINT_PATTERN = /coupon|promo|favorit|product|categor|discount|benefit|reward/i;

@Injectable()
export class SilpoBenefitsDiscoveryService {
  constructor(
    private readonly connections: SilpoConnectionService,
    private readonly oauth: SilpoOauthService
  ) {}

  async discover(userId: string): Promise<BenefitDiscoveryReport> {
    try {
      return await this.connections.withReadAccess(userId, async (accessToken) => {
        let catalog: SanitizedMcpTool[];
        try {
          catalog = await this.oauth.listMcpTools(accessToken);
        } catch (error) {
          if (isUnauthorized(error)) throw error;
          return this.unavailableReport();
        }

        const tools = await Promise.all(BENEFIT_TOOLS.map(async (toolName): Promise<BenefitDiscoveryItem> => {
          const tool = catalog.find((item) => item.name === toolName);
          if (!tool || !acceptsEmptyObject(tool.inputSchema)) {
            return { toolName, outcome: 'unavailable', fields: [] };
          }

          try {
            const payload = await this.oauth.callSilpoTool(accessToken, toolName, {}, `cartwise-benefits-${toolName}`);
            const fields = inspectFields(payload);
            return fields === null
              ? { toolName, outcome: 'invalid_response', fields: [] }
              : { toolName, outcome: 'available', fields };
          } catch (error) {
            if (isUnauthorized(error)) throw error;
            return { toolName, outcome: 'unavailable', fields: [] };
          }
        }));
        return { tools, catalogHints: catalogHints(catalog) };
      });
    } catch {
      return this.unavailableReport();
    }
  }

  async listPersonalBenefits(userId: string): Promise<PersonalBenefitsReport> {
    try {
      return await this.connections.withReadAccess(userId, async (accessToken) => {
        const payload = await this.oauth.callSilpoTool(accessToken, 'silpo_get_my_coupons', {}, 'cartwise-personal-benefits');
        const coupons = Array.isArray(payload.coupons) ? payload.coupons : null;
        if (!coupons) return { outcome: 'unavailable', benefits: [] };
        return { outcome: 'available', benefits: coupons.map(toPersonalBenefit).filter((benefit): benefit is PersonalBenefit => benefit !== null) };
      });
    } catch {
      return { outcome: 'unavailable', benefits: [] };
    }
  }

  private unavailableReport(): BenefitDiscoveryReport {
    return { tools: BENEFIT_TOOLS.map((toolName) => ({ toolName, outcome: 'unavailable', fields: [] })), catalogHints: [] };
  }
}

function toPersonalBenefit(value: unknown): PersonalBenefit | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const description = text(row.description);
  if (!description) return null;
  return {
    active: row.active === true,
    description,
    expiresAt: text(row.endDateTime) ?? text(row.endDate),
    limitText: text(row.limitText),
    rewardText: text(row.rewardText)
  };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() && value.length <= 500 ? value : null;
}

function catalogHints(catalog: SanitizedMcpTool[]): CatalogHint[] {
  return catalog
    .filter((tool) => CATALOG_HINT_PATTERN.test(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema ?? null
    }));
}

function acceptsEmptyObject(schema: Record<string, unknown> | undefined): boolean {
  if (!schema || schema.type !== 'object') return false;
  // '$schema' is standard JSON Schema meta (present on nearly every tool in
  // this MCP's catalog), never a constraint on the payload itself — ignore it.
  if (Object.keys(schema).some((key) => !['$schema', 'type', 'properties', 'required'].includes(key))) return false;
  if (schema.properties !== undefined
    && (typeof schema.properties !== 'object' || schema.properties === null || Array.isArray(schema.properties)
      || Object.keys(schema.properties as Record<string, unknown>).length > 0)) return false;
  const required = schema.required;
  return required === undefined || (Array.isArray(required) && required.length === 0);
}

// User-approved 2026-09-12: reveal real field KEY NAMES (never values) so a
// P5 contract can be evaluated. SAFE_KEY_PATTERN + MAX_KEY_LENGTH exist
// because a key can itself be dynamic data rather than a schema field name
// (e.g. an object keyed by coupon code); this is a heuristic, not a proof —
// ponytail: revisit if a genuinely dynamic-dictionary-shaped MCP payload is
// ever found, since a short code-like key could still slip through today.
const SAFE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SENSITIVE_FIELD_KEYS = new Set([
  'accesstoken', 'authorization', 'branchid', 'companyid', 'cookie', 'jsonrpc', 'loyalty',
  'password', 'profile', 'refreshtoken', 'session', 'silpoexternalid', 'token'
]);

function safeKeySegment(key: string): string {
  if (!SAFE_KEY_PATTERN.test(key)) return '{}';
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_FIELD_KEYS.has(normalized) ? '{}' : key;
}

function inspectFields(payload: unknown): BenefitDiscoveryField[] | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;

  const fields: BenefitDiscoveryField[] = [];
  let invalid = false;
  const visitEntries = (entries: [string, unknown][], path: string, depth: number): void => {
    if (entries.length > MAX_KEYS_PER_LEVEL) {
      invalid = true;
      return;
    }
    for (const [key, child] of entries) {
      visit(child, `${path}.${safeKeySegment(key)}`, depth + 1);
    }
  };
  const visit = (value: unknown, path: string, depth: number): void => {
    if (invalid || depth > MAX_DEPTH || path.length > MAX_PATH_LENGTH || fields.length >= MAX_FIELDS) {
      invalid = true;
      return;
    }
    if (Array.isArray(value)) {
      const arrayPath = `${path}[]`;
      if (!path || arrayPath.length > MAX_PATH_LENGTH) {
        invalid = true;
        return;
      }
      fields.push({ path: arrayPath, type: 'array' });

      // Peek at the shape of the first element only, so the contract can
      // show what a coupon/promo item looks like (field names, never values).
      const first = value[0];
      if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
        visitEntries(Object.entries(first as Record<string, unknown>), arrayPath, depth);
      }
      return;
    }

    const type = value === null ? 'null' : typeof value;
    if (type !== 'null' && type !== 'boolean' && type !== 'number' && type !== 'string' && type !== 'object') {
      invalid = true;
      return;
    }
    if (path) fields.push({ path, type });
    if (type !== 'object') return;

    visitEntries(Object.entries(value as Record<string, unknown>), path, depth);
  };

  visit(payload, '$', 0);
  return invalid ? null : fields;
}

function isUnauthorized(error: unknown): boolean {
  return error instanceof HttpException && error.getStatus() === HttpStatus.UNAUTHORIZED;
}
