import { BadGatewayException, Injectable } from '@nestjs/common';
import { SilpoConnectionService } from './silpo-connection.service';
import { SilpoOauthService } from './silpo-oauth.service';

export type BranchQuery = { limit?: number; offset?: number; hasPickup?: boolean };

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

@Injectable()
export class SilpoProductService {
  constructor(
    private readonly connections: SilpoConnectionService,
    private readonly oauth: SilpoOauthService
  ) {}

  async listBranches(userId: string, query: BranchQuery): Promise<ListBranchesResponse> {
    const limit = clamp(query.limit, 1, 500, 25);
    const offset = Math.max(0, Number.isFinite(query.offset) ? Math.floor(query.offset as number) : 0);
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
    return { branches, nextOffset };
  }
}

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
