import { HttpException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { SessionService } from '../auth/session.service';
import { SilpoOauthService, SilpoRefreshRejectedError, redactIdentityPayload } from './silpo-oauth.service';

type Row = Record<string, unknown>;
type QueryResult = { rows: Row[] };

const telegram = {
  telegramUserId: '123456789012',
  username: 'test_user',
  firstName: 'Test',
  lastName: undefined,
  languageCode: 'uk'
};

const response = (body: Row, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: jest.fn().mockResolvedValue(body)
});

describe('SilpoOauthService owned authorization', () => {
  const originalEnv = { ...process.env };

  it('resolves only the browser flow purpose for a state and binding pair', async () => {
    const { service, pool } = subject();
    pool.query.mockResolvedValue({ rows: [{ purpose: 'identity_probe' }] });

    await expect(service.resolveBrowserFlowPurpose('state-value', 'browser-binding')).resolves.toBe('identity_probe');

    const [sql, values] = pool.query.mock.calls[0];
    expect(String(sql)).toContain('"stateHash"');
    expect(String(sql)).toContain('"browserBindingHash"');
    expect(String(sql)).toContain('"expiresAt" > NOW()');
    expect(String(sql)).not.toContain('verifierEncrypted');
    expect(values).toEqual([expect.any(String), expect.any(String)]);
  });

  it('returns null for an expired browser state', async () => {
    const { service, pool } = subject();
    pool.query.mockResolvedValue({ rows: [] });

    await expect(service.resolveBrowserFlowPurpose('expired-state', 'browser-binding')).resolves.toBeNull();
  });

  beforeEach(() => {
    process.env.APP_ORIGIN = 'https://app.example.com';
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
    global.fetch = jest.fn();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('stores first authorization ownership and scopes DCR to APP_ORIGIN', async () => {
    const { service, pool } = subject();
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> =>
      sql.includes('SELECT "clientId"') ? { rows: [] } : { rows: [] }
    );
    (global.fetch as jest.Mock).mockResolvedValue(response({ client_id: 'client-1' }));

    const url = new URL(await service.createFirstAuthorization(telegram));

    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/auth/silpo/callback');
    expect(url.searchParams.get('state')).toHaveLength(43);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('"telegramUserId"'),
      expect.arrayContaining(['https://app.example.com/api/auth/silpo/callback', telegram.telegramUserId])
    );
    expect(global.fetch).toHaveBeenCalledWith('https://mcp.silpo.ua/register', expect.objectContaining({
      body: expect.stringContaining('https://app.example.com/api/auth/silpo/callback')
    }));
  });

  it('creates reauthorization only for its live initiating session', async () => {
    const sessions = sessionMock();
    sessions.resolve.mockResolvedValue(sessionRecord());
    const { service, pool } = subject(sessions);
    useExistingClient(pool);

    const url = await (service as unknown as {
      createReauthorization(owner: { userId: string; sessionId: string }): Promise<string>;
    }).createReauthorization({ userId: 'user-1', sessionId: 'session-id' });

    expect(url).toContain('https://mcp.silpo.ua/authorize?');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('"initiatingSessionHash"'),
      expect.arrayContaining(['user-1', createHash('sha256').update('session-id').digest('base64url')])
    );
  });

  it('creates a discovery state with a hash of the browser binding and no user identity', async () => {
    const { service, pool } = subject();
    useExistingClient(pool);
    const binding = 'browser-binding';

    const url = await (service as unknown as {
      createDiscoveryAuthorization(browserBinding: string): Promise<string>;
    }).createDiscoveryAuthorization(binding);

    expect(url).toContain('https://mcp.silpo.ua/authorize?');
    const insert = pool.query.mock.calls.find(([sql]) => String(sql).startsWith('INSERT INTO "OAuthState"'));
    expect(insert).toBeDefined();
    expect(insert?.[0]).toEqual(expect.stringContaining('"browserBindingHash"'));
    expect(insert?.[0]).toEqual(expect.stringContaining('"purpose"'));
    expect(insert?.[1]).toEqual(expect.arrayContaining([
      'discovery',
      createHash('sha256').update(binding).digest('hex')
    ]));
  });

  it('rejects a discovery callback whose binding cookie does not match before exchanging the code', async () => {
    const { service, pool } = subject();
    pool.query.mockResolvedValue({ rows: [discoveryState(service)] });

    await expect((service as unknown as {
      completeDiscoveryAuthorization(input: { code: string; state: string; browserBinding: string }): Promise<void>;
    }).completeDiscoveryAuthorization({ code: 'authorization-code', state: 'state-value', browserBinding: 'wrong-binding' }))
      .rejects.toBeInstanceOf(UnauthorizedException);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('calls only MCP tools/list with the in-memory access token and stores a sanitized catalog', async () => {
    const { service, pool } = subject();
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> => {
      if (sql.startsWith('DELETE FROM "OAuthState"')) return { rows: [discoveryState(service)] };
      if (sql.includes('SELECT "clientId"')) return clientRow();
      return { rows: [] };
    });
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(response(tokenSet()))
      .mockResolvedValueOnce(response({
        result: {
          tools: [{
            name: 'get_profile',
            description: 'Profile lookup',
            inputSchema: { type: 'object', properties: { token: { type: 'string' } } },
            access_token: 'must-not-persist'
          }]
        }
      }));

    await expect(completeDiscovery(service)).resolves.toBeUndefined();

    expect(global.fetch).toHaveBeenNthCalledWith(2, 'https://mcp.silpo.ua/mcp', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
      body: expect.stringContaining('tools/list')
    }));
    const probeInsert = pool.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO "McpProbe"'));
    expect(probeInsert).toBeDefined();
    expect(probeInsert?.[1]).toEqual(expect.arrayContaining(['tools_list_success', 1]));
    expect(JSON.parse(String(probeInsert?.[1]?.[2]))).toEqual([{
      name: 'get_profile',
      description: 'Profile lookup',
      inputSchema: { type: 'object', properties: { token: { type: 'string' } } }
    }]);
  });

  it('does not create a User, SilpoConnection, or Session during discovery', async () => {
    const sessions = sessionMock();
    const { service, pool } = subject(sessions);
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> =>
      sql.startsWith('DELETE FROM "OAuthState"') ? { rows: [discoveryState(service)] } : clientRow()
    );
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(response(tokenSet()))
      .mockResolvedValueOnce(response({ result: { tools: [] } }));

    await expect(completeDiscovery(service)).resolves.toBeUndefined();

    expect(pool.connect).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
    expect(sessions.rotateHash).not.toHaveBeenCalled();
    expect(pool.query.mock.calls.map(([sql]) => String(sql)).join('\n')).not.toContain('INSERT INTO "User"');
    expect(pool.query.mock.calls.map(([sql]) => String(sql)).join('\n')).not.toContain('INSERT INTO "SilpoConnection"');
  });

  it('redacts identity response values into bounded field evidence', () => {
    const evidence = redactIdentityPayload('silpo_get_my_profile', {
      id: 'silpo-user-1',
      name: 'Private Name',
      loyalty: { cardId: 'card-1' },
      items: [{ code: 'x' }]
    });

    expect(evidence).toEqual({
      toolName: 'silpo_get_my_profile',
      outcome: 'success',
      fields: expect.arrayContaining([
        { path: 'id', type: 'string' },
        { path: 'name', type: 'string' },
        { path: 'loyalty.cardId', type: 'string' },
        { path: 'items[]', type: 'array' }
      ])
    });
    expect(JSON.stringify(evidence)).not.toContain('Private Name');
    expect(JSON.stringify(evidence)).not.toContain('silpo-user-1');
  });

  it('fails closed when the identity field inventory exceeds 128 paths', () => {
    const payload = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`field${index}`, 'value']));

    expect(redactIdentityPayload('silpo_get_my_profile', payload)).toEqual({
      toolName: 'silpo_get_my_profile', outcome: 'failed', fields: []
    });
  });

  it('calls only the two identity tools with empty arguments and stores no response values', async () => {
    const { service, pool } = subject();
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> => {
      if (sql.startsWith('DELETE FROM "OAuthState"')) return { rows: [identityState(service)] };
      if (sql.includes('SELECT "clientId"')) return clientRow();
      return { rows: [] };
    });
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(response(tokenSet()))
      .mockResolvedValueOnce(response({
        result: { structuredContent: { id: 'silpo-user-1', name: 'Private Name' } }
      }))
      .mockResolvedValueOnce(response({
        result: { structuredContent: { cardId: 'card-1', balance: 10 } }
      }));

    await expect((service as unknown as {
      completeIdentityProbeAuthorization(input: { code: string; state: string; browserBinding: string }): Promise<void>;
    }).completeIdentityProbeAuthorization({ code: 'authorization-code', state: 'state-value', browserBinding: 'browser-binding' }))
      .resolves.toBeUndefined();

    expect(global.fetch).toHaveBeenCalledTimes(3);
    for (const call of [2, 3]) {
      const request = (global.fetch as jest.Mock).mock.calls[call - 1][1] as RequestInit;
      const body = JSON.parse(String(request.body));
      expect(request.method).toBe('POST');
      expect(body.method).toBe('tools/call');
      expect(body.params.arguments).toEqual({});
      expect(request.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer access-token' }));
    }
    expect(JSON.parse(String((global.fetch as jest.Mock).mock.calls[1][1].body)).params.name).toBe('silpo_get_my_profile');
    expect(JSON.parse(String((global.fetch as jest.Mock).mock.calls[2][1].body)).params.name).toBe('silpo_get_loyalty_info');

    const update = pool.query.mock.calls.find(([sql]) => String(sql).includes('identityEvidence'));
    expect(update).toBeDefined();
    expect(JSON.stringify(update?.[1])).not.toContain('Private Name');
    expect(JSON.stringify(update?.[1])).not.toContain('silpo-user-1');
    const sql = pool.query.mock.calls.map(([query]) => String(query)).join('\n');
    expect(sql).not.toContain('INSERT INTO "User"');
    expect(sql).not.toContain('INSERT INTO "SilpoConnection"');
  });

  it('creates a separate silpo_connect state and persists the verified subject atomically', async () => {
    const sessions = sessionMock();
    sessions.create.mockResolvedValue({ id: 'silpo-session', csrfToken: 'silpo-csrf' });
    const { service, pool } = subject(sessions);
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> => {
      if (sql.startsWith('DELETE FROM "OAuthState"')) return { rows: [silpoConnectState(service)] };
      if (sql.includes('SELECT "clientId"')) return clientRow();
      return { rows: [] };
    });
    const tx = silpoTransaction(service);
    pool.connect.mockResolvedValue(tx);
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(response(tokenSet()))
      .mockResolvedValueOnce(response({ result: { structuredContent: { profile: { id: 'silpo-user-1', name: 'Private Name' } } } }));

    const result = await (service as unknown as {
      completeSilpoConnectionAuthorization(input: { code: string; state: string; browserBinding: string }): Promise<unknown>;
    }).completeSilpoConnectionAuthorization({ code: 'authorization-code', state: 'state-value', browserBinding: 'browser-binding' });

    expect(result).toEqual({ userId: 'user-1', sessionId: 'silpo-session', csrfToken: 'silpo-csrf' });
    const profileRequest = (global.fetch as jest.Mock).mock.calls[1][1] as RequestInit;
    const profileBody = JSON.parse(String(profileRequest.body));
    expect(profileBody.method).toBe('tools/call');
    expect(profileBody.params.name).toBe('silpo_get_my_profile');
    expect(profileBody.params.arguments).toEqual({});
    expect(profileRequest.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer access-token' }));
    expect(tx.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO "User"'))).toHaveLength(1);
    expect(tx.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO "SilpoConnection"'))).toHaveLength(1);
    expect(sessions.create).toHaveBeenCalledWith({ userId: 'user-1', telegramUserId: null });
    const connection = tx.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO "SilpoConnection"'));
    const values = (connection as unknown as [string, unknown[]] | undefined)?.[1] ?? [];
    expect(values).toContain('user-1');
    expect(values).not.toContain('access-token');
    expect(values).not.toContain('refresh-token');
    const cipher = (service as unknown as { cipher: { decrypt(value: string): string } }).cipher;
    expect(values.filter((value) => typeof value === 'string').map((value) => {
      try { return cipher.decrypt(value); } catch { return null; }
    })).toEqual(expect.arrayContaining(['access-token', 'refresh-token']));
  });

  it('creates silpo_connect state with only a hashed browser binding', async () => {
    const { service, pool } = subject();
    useExistingClient(pool);

    const url = await service.createSilpoConnectionAuthorization('browser-binding');
    expect(url).toContain('https://mcp.silpo.ua/authorize?');
    const insert = pool.query.mock.calls.find(([sql]) => String(sql).startsWith('INSERT INTO "OAuthState"'));
    expect(insert?.[1]).toEqual(expect.arrayContaining([
      'silpo_connect',
      createHash('sha256').update('browser-binding').digest('hex')
    ]));
    expect(insert?.[1]).not.toContain('browser-binding');
  });

  it('rejects a silpo_connect callback with the wrong browser binding before exchange', async () => {
    const { service, pool } = subject();
    pool.query.mockResolvedValue({ rows: [silpoConnectState(service)] });

    await expect((service as unknown as {
      completeSilpoConnectionAuthorization(input: { code: string; state: string; browserBinding: string }): Promise<unknown>;
    }).completeSilpoConnectionAuthorization({ code: 'authorization-code', state: 'state-value', browserBinding: 'wrong-binding' }))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it.each([{}, { profile: null }, { profile: { id: 42 } }, { profile: { id: '' } }, { id: 'wrong-path' }])(
    'rejects a malformed profile subject without opening a transaction: %j', async (profile) => {
      const { service, pool } = subject();
      pool.query.mockImplementation(async (sql: string): Promise<QueryResult> =>
        sql.startsWith('DELETE FROM "OAuthState"') ? { rows: [silpoConnectState(service)] } : clientRow()
      );
      (global.fetch as jest.Mock)
        .mockResolvedValueOnce(response(tokenSet()))
        .mockResolvedValueOnce(response({ result: { structuredContent: profile } }));

      await expect((service as unknown as {
        completeSilpoConnectionAuthorization(input: { code: string; state: string; browserBinding: string }): Promise<unknown>;
      }).completeSilpoConnectionAuthorization({ code: 'authorization-code', state: 'state-value', browserBinding: 'browser-binding' }))
        .rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(pool.connect).not.toHaveBeenCalled();
    }
  );

  it('does not persist anything when the token exchange fails', async () => {
    const { service, pool } = subject();
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> =>
      sql.startsWith('DELETE FROM "OAuthState"') ? { rows: [silpoConnectState(service)] } : clientRow()
    );
    (global.fetch as jest.Mock).mockResolvedValue(response({}, 401));

    await expect((service as unknown as {
      completeSilpoConnectionAuthorization(input: { code: string; state: string; browserBinding: string }): Promise<unknown>;
    }).completeSilpoConnectionAuthorization({ code: 'authorization-code', state: 'state-value', browserBinding: 'browser-binding' }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('does not open a transaction when the profile MCP call fails', async () => {
    const { service, pool } = subject();
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> =>
      sql.startsWith('DELETE FROM "OAuthState"') ? { rows: [silpoConnectState(service)] } : clientRow()
    );
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(response(tokenSet()))
      .mockResolvedValueOnce(response({}, 500));

    await expect((service as unknown as {
      completeSilpoConnectionAuthorization(input: { code: string; state: string; browserBinding: string }): Promise<unknown>;
    }).completeSilpoConnectionAuthorization({ code: 'authorization-code', state: 'state-value', browserBinding: 'browser-binding' }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it.each([
    { isError: true },
    { error: { code: -32000, message: 'provider failed' } }
  ])('rejects an MCP error result before persistence: %j', async (failure) => {
    const { service, pool } = subject();
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> =>
      sql.startsWith('DELETE FROM "OAuthState"') ? { rows: [silpoConnectState(service)] } : clientRow()
    );
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(response(tokenSet()))
      .mockResolvedValueOnce(response({ result: { ...failure, structuredContent: { profile: { id: 'silpo-user-1' } } } }));

    await expect((service as unknown as {
      completeSilpoConnectionAuthorization(input: { code: string; state: string; browserBinding: string }): Promise<unknown>;
    }).completeSilpoConnectionAuthorization({ code: 'authorization-code', state: 'state-value', browserBinding: 'browser-binding' }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('extracts profile.id from exactly one JSON text content block', async () => {
    const { service, pool } = subject();
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> =>
      sql.startsWith('DELETE FROM "OAuthState"') ? { rows: [silpoConnectState(service)] } : clientRow()
    );
    pool.connect.mockResolvedValue(silpoTransaction(service));
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(response(tokenSet()))
      .mockResolvedValueOnce(response({ result: { content: [{ type: 'text', text: JSON.stringify({ profile: { id: 'silpo-user-1' } }) }] } }));

    await expect((service as unknown as {
      completeSilpoConnectionAuthorization(input: { code: string; state: string; browserBinding: string }): Promise<unknown>;
    }).completeSilpoConnectionAuthorization({ code: 'authorization-code', state: 'state-value', browserBinding: 'browser-binding' }))
      .resolves.toEqual(expect.objectContaining({ userId: 'user-1' }));
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

  it.each([
    { content: [] },
    { content: [{ type: 'text', text: '{not-json}' }] },
    { content: [{ type: 'text', text: '{}' }, { type: 'text', text: '{}' }] },
    { content: [{ type: 'image', data: 'not-used' }] }
  ])('rejects malformed or multiple MCP text content blocks before persistence: %j', async ({ content }) => {
    const { service, pool } = subject();
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> =>
      sql.startsWith('DELETE FROM "OAuthState"') ? { rows: [silpoConnectState(service)] } : clientRow()
    );
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(response(tokenSet()))
      .mockResolvedValueOnce(response({ result: { content } }));

    await expect((service as unknown as {
      completeSilpoConnectionAuthorization(input: { code: string; state: string; browserBinding: string }): Promise<unknown>;
    }).completeSilpoConnectionAuthorization({ code: 'authorization-code', state: 'state-value', browserBinding: 'browser-binding' }))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects a silpo_connect callback with the wrong redirect before token exchange', async () => {
    const { service, pool } = subject();
    pool.query.mockResolvedValue({ rows: [{ ...silpoConnectState(service), redirectUri: 'https://attacker.example/callback' }] });

    await expect((service as unknown as {
      completeSilpoConnectionAuthorization(input: { code: string; state: string; browserBinding: string }): Promise<unknown>;
    }).completeSilpoConnectionAuthorization({ code: 'authorization-code', state: 'state-value', browserBinding: 'browser-binding' }))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects a replayed silpo_connect state before a second provider call', async () => {
    const { service, pool } = subject();
    let available = true;
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> => {
      if (sql.startsWith('DELETE FROM "OAuthState"')) {
        if (!available) return { rows: [] };
        available = false;
        return { rows: [silpoConnectState(service)] };
      }
      return clientRow();
    });
    pool.connect.mockResolvedValue(silpoTransaction(service));
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(response(tokenSet()))
      .mockResolvedValueOnce(response({ result: { structuredContent: { profile: { id: 'silpo-user-1' } } } }));

    type ConnectInput = { code: string; state: string; browserBinding: string };
    const input: ConnectInput = { code: 'authorization-code', state: 'state-value', browserBinding: 'browser-binding' };
    await expect((service as unknown as { completeSilpoConnectionAuthorization(input: ConnectInput): Promise<unknown> }).completeSilpoConnectionAuthorization(input))
      .resolves.toEqual(expect.objectContaining({ userId: 'user-1' }));
    await expect((service as unknown as { completeSilpoConnectionAuthorization(input: ConnectInput): Promise<unknown> }).completeSilpoConnectionAuthorization(input))
      .rejects.toBeInstanceOf(UnauthorizedException);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('maps concurrent callbacks for the same profile.id to the database upsert', async () => {
    const { service, pool } = subject();
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> =>
      sql.startsWith('DELETE FROM "OAuthState"') ? { rows: [silpoConnectState(service)] } : clientRow()
    );
    pool.connect.mockImplementation(async () => silpoTransaction(service));
    (global.fetch as jest.Mock).mockImplementation(async (url: string) =>
      url.endsWith('/token')
        ? response(tokenSet())
        : response({ result: { structuredContent: { profile: { id: 'silpo-user-1' } } } })
    );

    const complete = (state: string) => (service as unknown as {
      completeSilpoConnectionAuthorization(input: { code: string; state: string; browserBinding: string }): Promise<{ userId: string }>;
    }).completeSilpoConnectionAuthorization({ code: 'authorization-code', state, browserBinding: 'browser-binding' });
    await expect(Promise.all([complete('state-1'), complete('state-2')])).resolves.toEqual([
      expect.objectContaining({ userId: 'user-1' }), expect.objectContaining({ userId: 'user-1' })
    ]);
    expect(pool.connect).toHaveBeenCalledTimes(2);
    for (const result of pool.connect.mock.results) {
      const tx = await result.value;
      expect(tx.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT ("silpoExternalId") DO UPDATE'), ['silpo-user-1']);
    }
  });

  it('models unique-index serialization and returns one User identity for concurrent callbacks', async () => {
    const { service, pool } = subject();
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> =>
      sql.startsWith('DELETE FROM "OAuthState"') ? { rows: [silpoConnectState(service)] } : clientRow()
    );
    let releaseFirstInsert!: () => void;
    const firstInsert = new Promise<void>((resolve) => { releaseFirstInsert = resolve; });
    let userInsertStarted = false;
    let userInsertAttempts = 0;
    const userInsertOutcomes: string[] = [];
    const serializedDatabase = () => ({
      query: jest.fn(async (sql: string): Promise<QueryResult> => {
        if (sql.includes('INSERT INTO "User"')) {
          userInsertAttempts += 1;
          if (!userInsertStarted) {
            userInsertStarted = true;
            userInsertOutcomes.push('insert-won');
            await firstInsert;
          } else {
            await firstInsert;
            userInsertOutcomes.push('on-conflict-existing');
          }
          return { rows: [{ id: 'user-1', telegramUserId: null }] };
        }
        return { rows: [] };
      }),
      release: jest.fn()
    });
    pool.connect.mockImplementation(async () => serializedDatabase());
    (global.fetch as jest.Mock).mockImplementation(async (url: string) =>
      url.endsWith('/token')
        ? response(tokenSet())
        : response({ result: { structuredContent: { profile: { id: 'silpo-user-1' } } } })
    );

    const complete = (state: string) => (service as unknown as {
      completeSilpoConnectionAuthorization(input: { code: string; state: string; browserBinding: string }): Promise<{ userId: string }>;
    }).completeSilpoConnectionAuthorization({ code: 'authorization-code', state, browserBinding: 'browser-binding' });
    const completed = Promise.all([complete('state-1'), complete('state-2')]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseFirstInsert();
    const completedResults = await completed;
    expect(completedResults).toEqual([
      expect.objectContaining({ userId: 'user-1' }), expect.objectContaining({ userId: 'user-1' })
    ]);
    expect(userInsertAttempts).toBe(2);
    expect(userInsertOutcomes).toEqual(['insert-won', 'on-conflict-existing']);
    expect(completedResults.map(({ userId }) => userId)).toEqual(['user-1', 'user-1']);
    expect(pool.connect).toHaveBeenCalledTimes(2);
  });

  it('keeps an existing refresh token when the provider omits one', async () => {
    const { service, pool } = subject();
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> =>
      sql.startsWith('DELETE FROM "OAuthState"') ? { rows: [silpoConnectState(service)] } : clientRow()
    );
    const tx = silpoTransaction(service);
    pool.connect.mockResolvedValue(tx);
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(response({ access_token: 'new-access', expires_in: 3600 }))
      .mockResolvedValueOnce(response({ result: { structuredContent: { profile: { id: 'silpo-user-1' } } } }));

    await expect((service as unknown as {
      completeSilpoConnectionAuthorization(input: { code: string; state: string; browserBinding: string }): Promise<unknown>;
    }).completeSilpoConnectionAuthorization({ code: 'authorization-code', state: 'state-value', browserBinding: 'browser-binding' }))
      .resolves.toEqual(expect.objectContaining({ userId: 'user-1' }));
    const connection = tx.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO "SilpoConnection"'));
    expect(String(connection?.[0])).toContain('COALESCE(EXCLUDED."refreshTokenEncrypted", "SilpoConnection"."refreshTokenEncrypted")');
    expect((connection as unknown as [string, unknown[]])[1][2]).toBeNull();
  });

  it('atomically consumes state once so a replay fails before exchange', async () => {
    const { service, pool } = subject();
    const state = firstState(service);
    let available = true;
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> => {
      if (sql.startsWith('DELETE FROM "OAuthState"')) {
        if (!available) return { rows: [] };
        available = false;
        return { rows: [state] };
      }
      if (sql.includes('SELECT "clientId"')) return clientRow();
      return { rows: [] };
    });
    pool.connect.mockResolvedValue(transaction());
    (global.fetch as jest.Mock).mockResolvedValue(response(tokenSet()));

    await expect(complete(service, 'state-value')).resolves.toEqual(expect.objectContaining({ userId: 'user-1' }));
    await expect(complete(service, 'state-value')).rejects.toBeInstanceOf(UnauthorizedException);

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an expired state before exchange', async () => {
    const { service, pool } = subject();
    pool.query.mockResolvedValue({ rows: [] });

    await expect(complete(service, 'expired-state')).rejects.toBeInstanceOf(UnauthorizedException);

    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('"expiresAt" > NOW()'), expect.any(Array));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects logout-invalidated reauthorization before exchange', async () => {
    const sessions = sessionMock();
    sessions.resolveHash.mockResolvedValue(null);
    const { service, pool } = subject(sessions);
    pool.query.mockResolvedValue({ rows: [reauthorizationState(service)] });

    await expect(complete(service)).rejects.toBeInstanceOf(UnauthorizedException);

    expect(sessions.resolveHash).toHaveBeenCalledWith('session-hash');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('replaces an existing user connection and rotates the initiating session', async () => {
    const sessions = sessionMock();
    sessions.resolveHash.mockResolvedValue(sessionRecord());
    sessions.rotateHash.mockResolvedValue({ id: 'rotated-session', csrfToken: 'csrf' });
    const { service, pool } = subject(sessions);
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> =>
      sql.startsWith('DELETE FROM "OAuthState"') ? { rows: [reauthorizationState(service)] } : clientRow()
    );
    const tx = transaction('user-1');
    pool.connect.mockResolvedValue(tx);
    (global.fetch as jest.Mock).mockResolvedValue(response(tokenSet()));

    await expect(complete(service)).resolves.toEqual({ userId: 'user-1', sessionId: 'rotated-session' });

    expect(tx.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT ("userId") DO UPDATE'), expect.arrayContaining(['user-1']));
    expect(sessions.rotateHash).toHaveBeenCalledWith('session-hash', { userId: 'user-1', telegramUserId: telegram.telegramUserId });
  });

  it('creates exactly one owned User, connection, and session on first callback', async () => {
    const sessions = sessionMock();
    sessions.create.mockResolvedValue({ id: 'new-session', csrfToken: 'csrf' });
    const { service, pool } = subject(sessions);
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> =>
      sql.startsWith('DELETE FROM "OAuthState"') ? { rows: [firstState(service)] } : clientRow()
    );
    const tx = transaction();
    pool.connect.mockResolvedValue(tx);
    (global.fetch as jest.Mock).mockResolvedValue(response(tokenSet()));

    await expect(complete(service)).resolves.toEqual({ userId: 'user-1', sessionId: 'new-session' });

    expect(tx.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO "User"'))).toHaveLength(1);
    expect(tx.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO "SilpoConnection"'))).toHaveLength(1);
    expect(sessions.create).toHaveBeenCalledTimes(1);
    expect(sessions.create).toHaveBeenCalledWith({ userId: 'user-1', telegramUserId: telegram.telegramUserId });
  });

  it('resolves concurrent first callbacks to one User identity', async () => {
    const sessions = sessionMock();
    const { service, pool } = subject(sessions);
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> =>
      sql.startsWith('DELETE FROM "OAuthState"') ? { rows: [firstState(service)] } : clientRow()
    );
    pool.connect.mockImplementation(async () => transaction());
    (global.fetch as jest.Mock).mockResolvedValue(response(tokenSet()));

    const completed = await Promise.all([complete(service, 'state-1'), complete(service, 'state-2')]);

    expect(completed.map(({ userId }) => userId)).toEqual(['user-1', 'user-1']);
    for (const client of pool.connect.mock.results) {
      const tx = await client.value;
      expect(tx.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT ("telegramUserId") DO UPDATE'), expect.any(Array));
    }
  });

  it('creates no User when token exchange fails', async () => {
    const { service, pool } = subject();
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> =>
      sql.startsWith('DELETE FROM "OAuthState"') ? { rows: [firstState(service)] } : clientRow()
    );
    (global.fetch as jest.Mock).mockResolvedValue(response({}, 401));

    await expect(complete(service)).rejects.toBeInstanceOf(UnauthorizedException);

    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('fails closed when Redis cannot create the post-commit session', async () => {
    const sessions = sessionMock();
    sessions.create.mockRejectedValue(new Error('redis unavailable'));
    const { service, pool } = subject(sessions);
    pool.query.mockImplementation(async (sql: string): Promise<QueryResult> =>
      sql.startsWith('DELETE FROM "OAuthState"') ? { rows: [firstState(service)] } : clientRow()
    );
    pool.connect.mockResolvedValue(transaction());
    (global.fetch as jest.Mock).mockResolvedValue(response(tokenSet()));

    await expect(complete(service)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it.each([400, 401])('classifies token endpoint status %i as a refresh rejection', async (status) => {
    const { service, pool } = subject();
    useExistingClient(pool);
    (global.fetch as jest.Mock).mockResolvedValue(response({}, status));

    await expect(service.refreshToken('refresh-token')).rejects.toBeInstanceOf(SilpoRefreshRejectedError);
  });

  it.each([429, 500])('keeps token endpoint status %i temporary', async (status) => {
    const { service, pool } = subject();
    useExistingClient(pool);
    (global.fetch as jest.Mock).mockResolvedValue(response({}, status));

    await expect(service.refreshToken('refresh-token')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  describe('callSilpoTool', () => {
    it('normalizes an HTTP 401 into an UnauthorizedException', async () => {
      const { service } = subject();
      (global.fetch as jest.Mock).mockResolvedValue(response({}, 401));

      const error = await service.callSilpoTool('access-token', 'silpo_list_branches', {}, 'id').catch((cause) => cause);

      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(error.getStatus()).toBe(401);
    });

    it('preserves an HTTP 429 as a detectable status for polling backoff', async () => {
      const { service } = subject();
      (global.fetch as jest.Mock).mockResolvedValue(response({}, 429));

      const error = await service.callSilpoTool('access-token', 'silpo_list_branches', {}, 'id').catch((cause) => cause);

      expect(error).toBeInstanceOf(HttpException);
      expect(error.getStatus()).toBe(429);
    });

    it('sends an authenticated tools/call and returns structuredContent as-is', async () => {
      const { service } = subject();
      (global.fetch as jest.Mock).mockResolvedValue(
        response({ result: { structuredContent: { items: [{ branchId: 'b-1' }] } } })
      );

      const result = await service.callSilpoTool('access-token', 'silpo_list_branches', { limit: 10 }, 'cartwise-branches');

      expect(result).toEqual({ items: [{ branchId: 'b-1' }] });
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toBe('https://mcp.silpo.ua/mcp');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-token');
      const body = JSON.parse(String(init.body));
      expect(body.method).toBe('tools/call');
      expect(body.params.name).toBe('silpo_list_branches');
      expect(body.params.arguments).toEqual({ limit: 10 });
      expect(body.id).toBe('cartwise-branches');
    });

    it('parses a single JSON text content block when structuredContent is absent', async () => {
      const { service } = subject();
      (global.fetch as jest.Mock).mockResolvedValue(
        response({ result: { content: [{ type: 'text', text: JSON.stringify({ branches: [] }) }] } })
      );

      await expect(
        service.callSilpoTool('access-token', 'silpo_list_branches', {}, 'id')
      ).resolves.toEqual({ branches: [] });
    });

    it('rejects a tool error result', async () => {
      const { service } = subject();
      (global.fetch as jest.Mock).mockResolvedValue(
        response({ result: { isError: true, structuredContent: { items: [] } } })
      );

      await expect(service.callSilpoTool('access-token', 'silpo_list_branches', {}, 'id')).rejects.toThrow();
    });

    it('rejects malformed content and a non-2xx response', async () => {
      const { service } = subject();
      (global.fetch as jest.Mock).mockResolvedValueOnce(
        response({ result: { content: [{ type: 'text', text: 'not-json' }] } })
      );
      await expect(service.callSilpoTool('access-token', 'silpo_list_branches', {}, 'id')).rejects.toThrow();

      (global.fetch as jest.Mock).mockResolvedValueOnce(response({}, 502));
      await expect(service.callSilpoTool('access-token', 'silpo_list_branches', {}, 'id')).rejects.toThrow();
    });
  });

  it('normalizes a catalog HTTP 401 into an UnauthorizedException', async () => {
    const { service } = subject();
    (global.fetch as jest.Mock).mockResolvedValue(response({}, 401));

    const error = await service.listMcpTools('access-token').catch((cause) => cause);

    expect(error).toBeInstanceOf(UnauthorizedException);
    expect(error.getStatus()).toBe(401);
  });
});

function subject(sessions = sessionMock()) {
  const service = new SilpoOauthService(sessions as unknown as SessionService);
  const pool = { query: jest.fn(), connect: jest.fn() };
  Object.assign(service as object, { pool, sessions });
  return { service, pool };
}

function sessionMock() {
  return {
    resolve: jest.fn(),
    resolveHash: jest.fn(),
    create: jest.fn().mockResolvedValue({ id: 'new-session', csrfToken: 'csrf' }),
    rotateHash: jest.fn().mockResolvedValue({ id: 'rotated-session', csrfToken: 'csrf' })
  } as unknown as jest.Mocked<Pick<SessionService, 'resolve' | 'create'>> & {
    resolveHash: jest.Mock;
    rotateHash: jest.Mock;
  };
}

function sessionRecord() {
  return {
    userId: 'user-1', telegramUserId: telegram.telegramUserId, issuedAt: new Date().toISOString(),
    absoluteExpiresAt: new Date(Date.now() + 60_000).toISOString(), csrfSecret: 'csrf'
  };
}

function useExistingClient(pool: { query: jest.Mock }) {
  pool.query.mockImplementation(async (sql: string): Promise<QueryResult> =>
    sql.includes('SELECT "clientId"') ? clientRow() : { rows: [] }
  );
}

function clientRow(): QueryResult {
  return { rows: [{ clientId: 'client-1', clientSecretEncrypted: null }] };
}

function tokenSet(): Row {
  return { access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 3600 };
}

function firstState(service: SilpoOauthService): Row {
  const cipher = (service as unknown as { cipher: { encrypt(value: string): string } }).cipher;
  return {
    verifierEncrypted: cipher.encrypt('verifier'),
    redirectUri: 'https://app.example.com/api/auth/silpo/callback',
    ownerUserId: null,
    initiatingSessionHash: null,
    telegramUserId: telegram.telegramUserId,
    telegramUsername: telegram.username,
    telegramFirstName: telegram.firstName,
    telegramLastName: telegram.lastName,
    telegramLanguageCode: telegram.languageCode
  };
}

function reauthorizationState(service: SilpoOauthService): Row {
  return { ...firstState(service), ownerUserId: 'user-1', initiatingSessionHash: 'session-hash', telegramUserId: null };
}

function discoveryState(service: SilpoOauthService, browserBinding = 'browser-binding'): Row {
  const cipher = (service as unknown as { cipher: { encrypt(value: string): string } }).cipher;
  return {
    verifierEncrypted: cipher.encrypt('verifier'),
    redirectUri: 'https://app.example.com/api/auth/silpo/callback',
    purpose: 'discovery',
    ownerUserId: null,
    initiatingSessionHash: null,
    telegramUserId: null,
    browserBindingHash: createHash('sha256').update(browserBinding).digest('hex')
  };
}

function identityState(service: SilpoOauthService, browserBinding = 'browser-binding'): Row {
  return { ...discoveryState(service, browserBinding), purpose: 'identity_probe' };
}

function silpoConnectState(service: SilpoOauthService, browserBinding = 'browser-binding'): Row {
  return { ...discoveryState(service, browserBinding), purpose: 'silpo_connect' };
}

function transaction(userId = 'user-1') {
  return {
    query: jest.fn(async (sql: string): Promise<QueryResult> => {
      if (sql.includes('INSERT INTO "User"')) return { rows: [{ id: userId, telegramUserId: telegram.telegramUserId }] };
      if (sql.includes('SELECT "telegramUserId"')) return { rows: [{ telegramUserId: telegram.telegramUserId }] };
      return { rows: [] };
    }),
    release: jest.fn()
  };
}

function silpoTransaction(service: SilpoOauthService) {
  const cipher = (service as unknown as { cipher: { encrypt(value: string): string } }).cipher;
  return {
    query: jest.fn(async (sql: string): Promise<QueryResult> => {
      if (sql.includes('INSERT INTO "User"')) return { rows: [{ id: 'user-1', telegramUserId: null }] };
      return { rows: [] };
    }),
    release: jest.fn(),
    cipher
  };
}

function complete(service: SilpoOauthService, state = 'state-value') {
  return (service as unknown as {
    completeAuthorization(input: { code: string; state: string }): Promise<{ userId: string; sessionId: string }>;
  }).completeAuthorization({ code: 'authorization-code', state });
}

function completeDiscovery(service: SilpoOauthService) {
  return (service as unknown as {
    completeDiscoveryAuthorization(input: { code: string; state: string; browserBinding: string }): Promise<void>;
  }).completeDiscoveryAuthorization({ code: 'authorization-code', state: 'state-value', browserBinding: 'browser-binding' });
}
