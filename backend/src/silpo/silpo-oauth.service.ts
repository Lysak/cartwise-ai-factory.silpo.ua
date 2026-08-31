import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Pool } from 'pg';
import { TokenCipherService } from '../security/token-cipher.service';
import type { VerifiedTelegramUser } from '../auth/telegram-init-data.service';
import { SessionService } from '../auth/session.service';

type ClientRegistration = { client_id: string; client_secret?: string };
export type SilpoTokenSet = { access_token: string; refresh_token?: string; expires_in?: number };
type OAuthPurpose = 'telegram_first' | 'reauthorize' | 'discovery' | 'identity_probe' | 'silpo_connect';
export type BrowserFlowPurpose = 'discovery' | 'identity_probe' | 'silpo_connect';
type OAuthState = {
  purpose?: OAuthPurpose;
  verifierEncrypted: string;
  redirectUri: string;
  ownerUserId: string | null;
  initiatingSessionHash: string | null;
  telegramUserId: string | null;
  telegramUsername: string | null;
  telegramFirstName: string | null;
  telegramLastName: string | null;
  telegramLanguageCode: string | null;
  browserBindingHash: string | null;
};

export type SanitizedMcpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type IdentityProbeTool = 'silpo_get_my_profile' | 'silpo_get_loyalty_info';
export type IdentityField = { path: string; type: string };
export type IdentityProbeEvidence = {
  toolName: IdentityProbeTool;
  outcome: 'success' | 'failed';
  fields: IdentityField[];
};

export function redactIdentityPayload(toolName: IdentityProbeTool, payload: unknown): IdentityProbeEvidence {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { toolName, outcome: 'failed', fields: [] };
  }

  const fields: IdentityField[] = [];
  let invalid = false;
  const visit = (value: unknown, path: string, depth: number): void => {
    if (invalid || depth > 4 || path.length > 128 || fields.length >= 128) {
      invalid = true;
      return;
    }
    if (Array.isArray(value)) {
      if (!path) {
        invalid = true;
        return;
      }
      if (`${path}[]`.length > 128) {
        invalid = true;
        return;
      }
      fields.push({ path: `${path}[]`, type: 'array' });
      return;
    }
    const type = value === null ? 'null' : typeof value === 'object' ? 'object' : typeof value;
    if (path) fields.push({ path, type });
    if (type === 'object') {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        visit(child, path ? `${path}.${key}` : key, depth + 1);
      }
    }
  };

  visit(payload, '', 0);
  return invalid ? { toolName, outcome: 'failed', fields: [] } : { toolName, outcome: 'success', fields };
}

export class SilpoRefreshRejectedError extends Error {}

@Injectable()
export class SilpoOauthService {
  private readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });
  private readonly cipher = new TokenCipherService(process.env.TOKEN_ENCRYPTION_KEY ?? '');

  constructor(private readonly sessions: SessionService) {}

  async createFirstAuthorization(telegram: VerifiedTelegramUser): Promise<string> {
    const redirectUri = this.redirectUri();
    const client = await this.clientRegistration(redirectUri);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await this.pool.query(
      'INSERT INTO "OAuthState" (id, "stateHash", "verifierEncrypted", "redirectUri", "purpose", "telegramUserId", "telegramUsername", "telegramFirstName", "telegramLastName", "telegramLanguageCode", "expiresAt", "createdAt") VALUES (uuidv7(), $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() + INTERVAL \'10 minutes\', NOW())',
      [createHash('sha256').update(state).digest('hex'), this.cipher.encrypt(verifier), redirectUri, 'telegram_first', telegram.telegramUserId, telegram.username, telegram.firstName, telegram.lastName, telegram.languageCode]
    );
    const params = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: 'S256' });
    return `https://mcp.silpo.ua/authorize?${params}`;
  }

  async createReauthorization(owner: { userId: string; sessionId: string }): Promise<string> {
    const session = await this.sessions.resolve(owner.sessionId);
    if (!session || session.userId !== owner.userId) throw new UnauthorizedException();
    const redirectUri = this.redirectUri();
    const client = await this.clientRegistration(redirectUri);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const stateHash = createHash('sha256').update(state).digest('hex');

    await this.pool.query(
      'INSERT INTO "OAuthState" (id, "stateHash", "verifierEncrypted", "redirectUri", "purpose", "ownerUserId", "initiatingSessionHash", "expiresAt", "createdAt") VALUES (uuidv7(), $1, $2, $3, $4, $5, $6, NOW() + INTERVAL \'10 minutes\', NOW())',
      [stateHash, this.cipher.encrypt(verifier), redirectUri, 'reauthorize', owner.userId, createHash('sha256').update(owner.sessionId).digest('base64url')]
    );

    const params = new URLSearchParams({
      response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri,
      state, code_challenge: challenge, code_challenge_method: 'S256'
    });
    return `https://mcp.silpo.ua/authorize?${params}`;
  }

  async createDiscoveryAuthorization(browserBinding: string): Promise<string> {
    return this.createBrowserAuthorization('discovery', browserBinding);
  }

  async createIdentityProbeAuthorization(browserBinding: string): Promise<string> {
    return this.createBrowserAuthorization('identity_probe', browserBinding);
  }

  async createSilpoConnectionAuthorization(browserBinding: string): Promise<string> {
    return this.createBrowserAuthorization('silpo_connect', browserBinding);
  }

  async resolveBrowserFlowPurpose(state: string, browserBinding: string): Promise<BrowserFlowPurpose | null> {
    if (!state || !browserBinding) return null;
    const result = await this.pool.query<{ purpose: string }>(
      'SELECT "purpose" FROM "OAuthState" WHERE "stateHash" = $1 AND "browserBindingHash" = $2 AND "expiresAt" > NOW() LIMIT 1',
      [createHash('sha256').update(state).digest('hex'), createHash('sha256').update(browserBinding).digest('hex')]
    );
    const purpose = result.rows[0]?.purpose;
    return purpose === 'discovery' || purpose === 'identity_probe' || purpose === 'silpo_connect' ? purpose : null;
  }

  async hasBrowserFlowState(state: string): Promise<boolean> {
    if (!state) return false;
    const result = await this.pool.query<{ present: number }>(
      'SELECT 1 AS "present" FROM "OAuthState" WHERE "stateHash" = $1 AND "purpose" IN (\'discovery\', \'identity_probe\', \'silpo_connect\') LIMIT 1',
      [createHash('sha256').update(state).digest('hex')]
    );
    return result.rows.length > 0;
  }

  private async createBrowserAuthorization(purpose: 'discovery' | 'identity_probe' | 'silpo_connect', browserBinding: string): Promise<string> {
    if (!browserBinding) throw new UnauthorizedException();
    const redirectUri = this.redirectUri();
    const client = await this.clientRegistration(redirectUri);
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await this.pool.query(
      'INSERT INTO "OAuthState" (id, "stateHash", "verifierEncrypted", "redirectUri", "purpose", "browserBindingHash", "expiresAt", "createdAt") VALUES (uuidv7(), $1, $2, $3, $4, $5, NOW() + INTERVAL \'10 minutes\', NOW())',
      [createHash('sha256').update(state).digest('hex'), this.cipher.encrypt(verifier), redirectUri, purpose, createHash('sha256').update(browserBinding).digest('hex')]
    );
    const params = new URLSearchParams({
      response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri,
      state, code_challenge: challenge, code_challenge_method: 'S256'
    });
    return `https://mcp.silpo.ua/authorize?${params}`;
  }

  async completeAuthorization(input: { code: string; state: string }): Promise<{ userId: string; sessionId: string }> {
    const row = await this.consumeState(input.state);
    if (!row) throw new UnauthorizedException('Invalid or expired authorization state');
    const purpose = this.statePurpose(row);
    if (purpose === 'discovery') throw new UnauthorizedException('Invalid authorization state');
    const firstAuthorization = purpose === 'telegram_first';
    const reauthorization = purpose === 'reauthorize';
    if (!firstAuthorization && !reauthorization) throw new UnauthorizedException('Invalid authorization owner');
    if (row.redirectUri !== this.redirectUri()) throw new UnauthorizedException('Invalid authorization redirect');

    const initiatingSession = reauthorization ? await this.sessions.resolveHash(row.initiatingSessionHash!) : null;
    if (reauthorization && (!initiatingSession || initiatingSession.userId !== row.ownerUserId)) {
      throw new UnauthorizedException('Authorization session is no longer valid');
    }

    const client = await this.clientRegistration(row.redirectUri);
    const tokens = await this.exchangeCode(input.code, this.cipher.decrypt(row.verifierEncrypted), client, row.redirectUri);
    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
    const database = await this.pool.connect();
    let userId: string;
    let telegramUserId: string;
    try {
      await database.query('BEGIN');
      if (firstAuthorization) {
        const user = await database.query<{ id: string; telegramUserId: string }>(
          'INSERT INTO "User" (id, "telegramUserId", "telegramUsername", "telegramFirstName", "telegramLastName", "telegramLanguageCode", "createdAt", "updatedAt") VALUES (uuidv7(), $1, $2, $3, $4, $5, NOW(), NOW()) ON CONFLICT ("telegramUserId") DO UPDATE SET "telegramUsername" = EXCLUDED."telegramUsername", "telegramFirstName" = EXCLUDED."telegramFirstName", "telegramLastName" = EXCLUDED."telegramLastName", "telegramLanguageCode" = EXCLUDED."telegramLanguageCode", "updatedAt" = NOW() RETURNING id, "telegramUserId"',
          [row.telegramUserId, row.telegramUsername, row.telegramFirstName, row.telegramLastName, row.telegramLanguageCode]
        );
        userId = user.rows[0].id;
        telegramUserId = user.rows[0].telegramUserId;
      } else {
        const user = await database.query<{ telegramUserId: string }>('SELECT "telegramUserId" FROM "User" WHERE id = $1', [row.ownerUserId]);
        if (!user.rows[0]?.telegramUserId) throw new UnauthorizedException('Authorization owner no longer exists');
        userId = row.ownerUserId!;
        telegramUserId = user.rows[0].telegramUserId;
      }
      await database.query(
        'INSERT INTO "SilpoConnection" (id, "userId", "accessTokenEncrypted", "refreshTokenEncrypted", "accessTokenExpiresAt", status, "createdAt", "updatedAt") VALUES (uuidv7(), $1, $2, $3, $4, \'active\', NOW(), NOW()) ON CONFLICT ("userId") DO UPDATE SET "accessTokenEncrypted" = EXCLUDED."accessTokenEncrypted", "refreshTokenEncrypted" = EXCLUDED."refreshTokenEncrypted", "accessTokenExpiresAt" = EXCLUDED."accessTokenExpiresAt", status = \'active\', "updatedAt" = NOW()',
        [userId, this.cipher.encrypt(tokens.access_token), tokens.refresh_token ? this.cipher.encrypt(tokens.refresh_token) : null, expiresAt]
      );
      await database.query('COMMIT');
    } catch (error) {
      await database.query('ROLLBACK');
      throw error;
    } finally {
      database.release();
    }

    try {
      const session = reauthorization
        ? await this.sessions.rotateHash(row.initiatingSessionHash!, { userId, telegramUserId })
        : await this.sessions.create({ userId, telegramUserId });
      if (!session) throw new UnauthorizedException('Authorization session is no longer valid');
      return { userId, sessionId: session.id };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new ServiceUnavailableException('Authentication session unavailable');
    }
  }

  async completeDiscoveryAuthorization(input: { code: string; state: string; browserBinding: string }): Promise<void> {
    const row = await this.consumeState(input.state);
    if (!row || this.statePurpose(row) !== 'discovery' || !this.matchesBrowserBinding(row.browserBindingHash, input.browserBinding)) {
      throw new UnauthorizedException('Invalid discovery authorization state');
    }
    if (row.redirectUri !== this.redirectUri()) throw new UnauthorizedException('Invalid authorization redirect');

    try {
      const client = await this.clientRegistration(row.redirectUri);
      const tokens = await this.exchangeCode(input.code, this.cipher.decrypt(row.verifierEncrypted), client, row.redirectUri);
      const catalog = await this.fetchMcpCatalog(tokens.access_token);
      await this.pool.query(
        'INSERT INTO "McpProbe" (id, outcome, "toolCount", "toolCatalog", "checkedAt") VALUES (uuidv7(), $1, $2, $3, NOW())',
        ['tools_list_success', catalog.length, JSON.stringify(catalog)]
      );
    } catch {
      throw new ServiceUnavailableException('Silpo discovery failed');
    }
  }

  async completeIdentityProbeAuthorization(input: { code: string; state: string; browserBinding: string }): Promise<void> {
    const row = await this.consumeState(input.state);
    if (!row || this.statePurpose(row) !== 'identity_probe' || !this.matchesBrowserBinding(row.browserBindingHash, input.browserBinding)) {
      throw new UnauthorizedException('Invalid identity probe authorization state');
    }
    if (row.redirectUri !== this.redirectUri()) throw new UnauthorizedException('Invalid authorization redirect');

    try {
      const client = await this.clientRegistration(row.redirectUri);
      const tokens = await this.exchangeCode(input.code, this.cipher.decrypt(row.verifierEncrypted), client, row.redirectUri);
      const evidence = [
        await this.fetchMcpIdentity(tokens.access_token, 'silpo_get_my_profile', 'cartwise-identity-profile'),
        await this.fetchMcpIdentity(tokens.access_token, 'silpo_get_loyalty_info', 'cartwise-identity-loyalty')
      ];
      if (evidence.some((item) => item.outcome !== 'success')) throw new Error('Invalid identity evidence');
      await this.updateIdentityEvidence(evidence);
    } catch {
      await this.updateIdentityEvidence([
        { toolName: 'silpo_get_my_profile', outcome: 'failed', fields: [] },
        { toolName: 'silpo_get_loyalty_info', outcome: 'failed', fields: [] }
      ]).catch(() => undefined);
      throw new ServiceUnavailableException('Silpo identity probe failed');
    }
  }

  async completeSilpoConnectionAuthorization(input: { code: string; state: string; browserBinding: string }): Promise<{ userId: string; sessionId: string; csrfToken: string }> {
    const row = await this.consumeState(input.state);
    if (!row || this.statePurpose(row) !== 'silpo_connect' || !this.matchesBrowserBinding(row.browserBindingHash, input.browserBinding)) {
      throw new UnauthorizedException('Invalid Silpo connection authorization state');
    }
    if (row.redirectUri !== this.redirectUri()) throw new UnauthorizedException('Invalid authorization redirect');

    try {
      const client = await this.clientRegistration(row.redirectUri);
      const tokens = await this.exchangeCode(input.code, this.cipher.decrypt(row.verifierEncrypted), client, row.redirectUri);
      if (!tokens.access_token) throw new Error('Missing access token');
      const silpoExternalId = await this.fetchMcpProfileId(tokens.access_token);
      const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
      const database = await this.pool.connect();
      let userId: string;
      let telegramUserId: string | null;
      try {
        await database.query('BEGIN');
        const user = await database.query<{ id: string; telegramUserId: string | null }>(
          'INSERT INTO "User" (id, "silpoExternalId", "createdAt", "updatedAt") VALUES (uuidv7(), $1, NOW(), NOW()) ON CONFLICT ("silpoExternalId") DO UPDATE SET "updatedAt" = NOW() RETURNING id, "telegramUserId"',
          [silpoExternalId]
        );
        if (!user.rows[0]) throw new Error('Silpo user persistence failed');
        userId = user.rows[0].id;
        telegramUserId = user.rows[0].telegramUserId;
        await database.query(
          'INSERT INTO "SilpoConnection" (id, "userId", "accessTokenEncrypted", "refreshTokenEncrypted", "accessTokenExpiresAt", status, "createdAt", "updatedAt") VALUES (uuidv7(), $1, $2, $3, $4, \'active\', NOW(), NOW()) ON CONFLICT ("userId") DO UPDATE SET "accessTokenEncrypted" = EXCLUDED."accessTokenEncrypted", "refreshTokenEncrypted" = COALESCE(EXCLUDED."refreshTokenEncrypted", "SilpoConnection"."refreshTokenEncrypted"), "accessTokenExpiresAt" = EXCLUDED."accessTokenExpiresAt", status = \'active\', "updatedAt" = NOW()',
          [userId, this.cipher.encrypt(tokens.access_token), tokens.refresh_token ? this.cipher.encrypt(tokens.refresh_token) : null, expiresAt]
        );
        await database.query('COMMIT');
      } catch (error) {
        await database.query('ROLLBACK');
        throw error;
      } finally {
        database.release();
      }

      const session = await this.sessions.create({ userId, telegramUserId });
      if (!session) throw new Error('Silpo session unavailable');
      return { userId, sessionId: session.id, csrfToken: session.csrfToken };
    } catch {
      throw new ServiceUnavailableException('Silpo connection failed');
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async deleteExpiredStates(): Promise<void> {
    await this.pool.query('DELETE FROM "OAuthState" WHERE "expiresAt" <= NOW()');
  }

  private async clientRegistration(redirectUri = this.redirectUri()): Promise<ClientRegistration> {
    const existing = await this.pool.query<{ clientId: string; clientSecretEncrypted: string | null }>('SELECT "clientId", "clientSecretEncrypted" FROM "OAuthClient" WHERE "redirectUri" = $1 LIMIT 1', [redirectUri]);
    if (existing.rows[0]) return {
      client_id: existing.rows[0].clientId,
      client_secret: existing.rows[0].clientSecretEncrypted ? this.cipher.decrypt(existing.rows[0].clientSecretEncrypted) : undefined
    };
    const response = await fetch('https://mcp.silpo.ua/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Cartwise', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }) });
    if (!response.ok) throw new ServiceUnavailableException('Silpo client registration failed');
    const registered = await response.json() as ClientRegistration;
    await this.pool.query('INSERT INTO "OAuthClient" (id, "clientId", "clientSecretEncrypted", "redirectUri", "createdAt", "updatedAt") VALUES (uuidv7(), $1, $2, $3, NOW(), NOW())', [registered.client_id, registered.client_secret ? this.cipher.encrypt(registered.client_secret) : null, redirectUri]);
    return registered;
  }

  private async consumeState(state: string): Promise<OAuthState | null> {
    const consumed = await this.pool.query<OAuthState>(
      'DELETE FROM "OAuthState" WHERE "stateHash" = $1 AND "expiresAt" > NOW() RETURNING "verifierEncrypted", "redirectUri", "purpose", "ownerUserId", "initiatingSessionHash", "telegramUserId", "telegramUsername", "telegramFirstName", "telegramLastName", "telegramLanguageCode", "browserBindingHash"',
      [createHash('sha256').update(state).digest('hex')]
    );
    return consumed.rows[0] ?? null;
  }

  private statePurpose(row: OAuthState): OAuthPurpose | null {
    if (row.purpose) return row.purpose;
    if (row.telegramUserId && !row.ownerUserId && !row.initiatingSessionHash) return 'telegram_first';
    if (!row.telegramUserId && row.ownerUserId && row.initiatingSessionHash) return 'reauthorize';
    return null;
  }

  private matchesBrowserBinding(expectedHash: string | null, binding: string): boolean {
    if (!expectedHash || !binding) return false;
    const expected = Buffer.from(expectedHash, 'hex');
    const actual = createHash('sha256').update(binding).digest();
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private async fetchMcpProfileId(accessToken: string): Promise<string> {
    const payload = await this.callSilpoTool(accessToken, 'silpo_get_my_profile', {}, 'cartwise-silpo-connect-profile');
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('Invalid Silpo profile');
    const profile = (payload as { profile?: unknown }).profile;
    if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) throw new Error('Invalid Silpo profile');
    const id = (profile as { id?: unknown }).id;
    if (typeof id !== 'string' || !id.trim()) throw new Error('Invalid Silpo profile');
    return id;
  }

  private async fetchMcpIdentity(accessToken: string, name: IdentityProbeTool, id: string): Promise<IdentityProbeEvidence> {
    const identityPayload = await this.callSilpoTool(accessToken, name, {}, id);
    const evidence = redactIdentityPayload(name, identityPayload);
    if (evidence.outcome !== 'success') throw new Error('Invalid MCP identity evidence');
    return evidence;
  }

  async callSilpoTool(accessToken: string, name: string, args: Record<string, unknown>, id: string): Promise<Record<string, unknown>> {
    const response = await fetch('https://mcp.silpo.ua/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
    });
    if (!response.ok) throw new Error('MCP tool call failed');
    const payload = await response.json() as unknown;
    if (typeof payload !== 'object' || payload === null || typeof (payload as { result?: unknown }).result !== 'object' || (payload as { result?: unknown }).result === null) {
      throw new Error('Invalid MCP tool result');
    }
    const result = (payload as { result: Record<string, unknown> }).result;
    const rpcError = result.error;
    const hasRpcError = typeof rpcError === 'string'
      ? rpcError.length > 0
      : typeof rpcError === 'object' && rpcError !== null
        ? Object.keys(rpcError).length > 0
        : rpcError !== undefined && rpcError !== null;
    if (result.isError === true || hasRpcError) throw new Error('MCP tool call failed');
    let toolPayload: unknown = result.structuredContent;
    if (typeof toolPayload !== 'object' || toolPayload === null || Array.isArray(toolPayload)) {
      const content = result.content;
      if (!Array.isArray(content) || content.length !== 1 || typeof content[0] !== 'object' || content[0] === null || typeof (content[0] as { type?: unknown }).type !== 'string' || (content[0] as { type: string }).type !== 'text' || typeof (content[0] as { text?: unknown }).text !== 'string') {
        throw new Error('Invalid MCP tool result');
      }
      try {
        toolPayload = JSON.parse((content[0] as { text: string }).text);
      } catch {
        throw new Error('Invalid MCP tool result');
      }
    }
    if (typeof toolPayload !== 'object' || toolPayload === null || Array.isArray(toolPayload)) {
      throw new Error('Invalid MCP tool result');
    }
    return toolPayload as Record<string, unknown>;
  }

  private async updateIdentityEvidence(evidence: IdentityProbeEvidence[]): Promise<void> {
    await this.pool.query(
      'UPDATE "McpProbe" SET "identityEvidence" = $1 WHERE id = (SELECT id FROM "McpProbe" WHERE outcome = \'tools_list_success\' ORDER BY "checkedAt" DESC LIMIT 1)',
      [JSON.stringify(evidence)]
    );
  }

  private async fetchMcpCatalog(accessToken: string): Promise<SanitizedMcpTool[]> {
    if (!accessToken) throw new Error('Missing access token');
    const response = await fetch('https://mcp.silpo.ua/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'cartwise-discovery', method: 'tools/list', params: {} })
    });
    if (!response.ok) throw new Error('MCP discovery failed');
    const payload: unknown = await response.json();
    if (typeof payload !== 'object' || payload === null) throw new Error('Invalid MCP catalog');
    const result = (payload as { result?: unknown }).result;
    if (typeof result !== 'object' || result === null || !Array.isArray((result as { tools?: unknown }).tools)) {
      throw new Error('Invalid MCP catalog');
    }
    return (result as { tools: unknown[] }).tools.map((tool): SanitizedMcpTool => {
      if (typeof tool !== 'object' || tool === null || typeof (tool as { name?: unknown }).name !== 'string') {
        throw new Error('Invalid MCP tool');
      }
      const item = tool as { name: string; description?: unknown; inputSchema?: unknown };
      if (item.description !== undefined && typeof item.description !== 'string') throw new Error('Invalid MCP tool');
      if (item.inputSchema !== undefined || item.inputSchema === null) {
        if (typeof item.inputSchema !== 'object' || item.inputSchema === null || Array.isArray(item.inputSchema)) throw new Error('Invalid MCP tool');
      }
      return {
        name: item.name,
        ...(item.description === undefined ? {} : { description: item.description }),
        ...(item.inputSchema === undefined ? {} : { inputSchema: item.inputSchema as Record<string, unknown> })
      };
    });
  }

  private async exchangeCode(code: string, verifier: string, client: ClientRegistration, redirectUri: string): Promise<SilpoTokenSet> {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier });
    if (client.client_secret) body.set('client_secret', client.client_secret);
    const response = await fetch('https://mcp.silpo.ua/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!response.ok) throw new UnauthorizedException('Silpo token exchange failed');
    return response.json() as Promise<SilpoTokenSet>;
  }

  async refreshToken(refreshToken: string): Promise<SilpoTokenSet> {
    const client = await this.clientRegistration();
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.client_id });
    const response = await fetch('https://mcp.silpo.ua/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (response.status === 400 || response.status === 401) throw new SilpoRefreshRejectedError();
    if (!response.ok) throw new ServiceUnavailableException('Silpo token refresh failed');
    return response.json() as Promise<SilpoTokenSet>;
  }

  private redirectUri(): string {
    const origin = process.env.APP_ORIGIN;
    if (!origin) throw new ServiceUnavailableException('APP_ORIGIN is required');
    return `${origin.replace(/\/$/, '')}/api/auth/silpo/callback`;
  }
}
