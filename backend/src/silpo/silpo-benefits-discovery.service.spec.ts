import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SilpoConnectionService } from './silpo-connection.service';
import type { SanitizedMcpTool } from './silpo-oauth.service';
import { SilpoOauthService } from './silpo-oauth.service';
import { SilpoBenefitsDiscoveryService } from './silpo-benefits-discovery.service';

type Payload = Record<string, unknown>;

function subject() {
  const listMcpTools = jest.fn<Promise<SanitizedMcpTool[]>, [string]>();
  const callSilpoTool = jest.fn<Promise<Payload>, [string, string, Record<string, unknown>, string]>();
  const withReadAccess = jest.fn(async (_userId: string, operation: (token: string) => Promise<unknown>) => operation('access-token'));
  const service = new SilpoBenefitsDiscoveryService(
    { withReadAccess } as unknown as SilpoConnectionService,
    { listMcpTools, callSilpoTool } as unknown as SilpoOauthService
  );
  return { service, listMcpTools, callSilpoTool, withReadAccess };
}

describe('SilpoBenefitsDiscoveryService', () => {
  it('maps only safe coupon display fields and never provider IDs', async () => {
    const { service, callSilpoTool } = subject();
    callSilpoTool.mockResolvedValue({ coupons: [{
      id: 7, promoId: 9, active: true, description: 'Персональна вигода',
      endDateTime: '2026-09-13T10:00:00Z', limitText: 'Лише один раз', rewardText: '5%'
    }] });

    await expect(service.listPersonalBenefits('user-1')).resolves.toEqual({
      outcome: 'available',
      benefits: [{ active: true, description: 'Персональна вигода', expiresAt: '2026-09-13T10:00:00Z', limitText: 'Лише один раз', rewardText: '5%' }]
    });
    expect(JSON.stringify(await service.listPersonalBenefits('user-1'))).not.toContain('promoId');
    expect(callSilpoTool).toHaveBeenCalledWith('access-token', 'silpo_get_my_coupons', {}, expect.any(String));
  });
  it('compiles with Nest dependency tokens', async () => {
    const module = await Test.createTestingModule({
      providers: [
        SilpoBenefitsDiscoveryService,
        { provide: SilpoConnectionService, useValue: {} },
        { provide: SilpoOauthService, useValue: {} }
      ]
    }).compile();

    await module.close();
  });

  it('uses the user connection and returns paths, never payload values', async () => {
    const { service, listMcpTools, callSilpoTool, withReadAccess } = subject();
    listMcpTools.mockResolvedValue([
      { name: 'silpo_get_my_coupons', inputSchema: { type: 'object', properties: {} } },
      { name: 'silpo_get_my_promos', inputSchema: { type: 'object', required: [] } }
    ]);
    callSilpoTool
      .mockResolvedValueOnce({ items: [{ title: 'SECRET-CODE', active: true }] })
      .mockResolvedValueOnce({ promo: { expiresAt: '2026-12-01' } });

    const report = await service.discover('user-1');

    expect(withReadAccess).toHaveBeenCalledWith('user-1', expect.any(Function));
    expect(callSilpoTool).toHaveBeenNthCalledWith(1, 'access-token', 'silpo_get_my_coupons', {}, expect.any(String));
    expect(JSON.stringify(report)).not.toContain('SECRET-CODE');
    expect(report.tools).toContainEqual(expect.objectContaining({
      toolName: 'silpo_get_my_coupons', outcome: 'available',
      fields: expect.arrayContaining([
        { path: '$', type: 'object' },
        { path: '$.items[]', type: 'array' },
        { path: '$.items[].title', type: 'string' },
        { path: '$.items[].active', type: 'boolean' }
      ])
    }));
  });

  it('does not invoke missing, non-allowlisted, or required-argument tools', async () => {
    const { service, listMcpTools, callSilpoTool } = subject();
    listMcpTools.mockResolvedValue([
      { name: 'silpo_get_my_favorites', inputSchema: { type: 'object', required: ['branchId'] } },
      { name: 'provider_delete_coupon', inputSchema: { type: 'object', properties: {} } }
    ]);

    const report = await service.discover('user-1');

    expect(report.tools).toContainEqual({ toolName: 'silpo_get_my_favorites', outcome: 'unavailable', fields: [] });
    expect(report.tools).toContainEqual({ toolName: 'silpo_get_my_coupons', outcome: 'unavailable', fields: [] });
    expect(callSilpoTool).not.toHaveBeenCalled();
  });

  it('rejects an over-depth response without fields', async () => {
    const { service, listMcpTools, callSilpoTool } = subject();
    listMcpTools.mockResolvedValue([{ name: 'silpo_get_my_promos', inputSchema: { type: 'object' } }]);
    callSilpoTool.mockResolvedValue({ one: { two: { three: { four: { five: true } } } } });

    await expect(service.discover('user-1')).resolves.toMatchObject({
      tools: expect.arrayContaining([{ toolName: 'silpo_get_my_promos', outcome: 'invalid_response', fields: [] }])
    });
  });

  it('surfaces server-authored catalog metadata (name/description/schema) for coupon/promo/product-related tools, beyond the three checked by name', async () => {
    const { service, listMcpTools, callSilpoTool } = subject();
    listMcpTools.mockResolvedValue([
      { name: 'silpo_get_my_coupons', description: 'Returns active coupons for the current user', inputSchema: { type: 'object' } },
      { name: 'silpo_get_coupon_products', description: 'Lists products a coupon applies to', inputSchema: { type: 'object', required: ['couponId'] } },
      { name: 'silpo_place_order', description: 'Places an order', inputSchema: { type: 'object' } }
    ]);
    callSilpoTool.mockResolvedValue({ items: [] });

    const report = await service.discover('user-1');

    expect(report.catalogHints).toEqual(expect.arrayContaining([
      { name: 'silpo_get_my_coupons', description: 'Returns active coupons for the current user', inputSchema: { type: 'object' } },
      { name: 'silpo_get_coupon_products', description: 'Lists products a coupon applies to', inputSchema: { type: 'object', required: ['couponId'] } }
    ]));
    expect(report.catalogHints.some((hint) => hint.name === 'silpo_place_order')).toBe(false);
  });

  it('lets a catalog HTTP 401 escape so the user connection can retry with a fresh token', async () => {
    const { service, listMcpTools, callSilpoTool, withReadAccess } = subject();
    withReadAccess.mockImplementation(async (_userId, operation) => {
      try {
        return await operation('expired-token');
      } catch (error) {
        if (error instanceof UnauthorizedException) return operation('fresh-token');
        throw error;
      }
    });
    listMcpTools
      .mockRejectedValueOnce(new UnauthorizedException())
      .mockResolvedValueOnce([{ name: 'silpo_get_my_coupons', inputSchema: { type: 'object' } }]);
    callSilpoTool.mockResolvedValue({ items: [] });

    const report = await service.discover('user-1');

    expect(listMcpTools).toHaveBeenNthCalledWith(1, 'expired-token');
    expect(listMcpTools).toHaveBeenNthCalledWith(2, 'fresh-token');
    expect(report.tools).toContainEqual(expect.objectContaining({ toolName: 'silpo_get_my_coupons', outcome: 'available' }));
  });

  it('lets a tool HTTP 401 escape so the user connection can retry with a fresh token', async () => {
    const { service, listMcpTools, callSilpoTool, withReadAccess } = subject();
    withReadAccess.mockImplementation(async (_userId, operation) => {
      try {
        return await operation('expired-token');
      } catch (error) {
        if (error instanceof UnauthorizedException) return operation('fresh-token');
        throw error;
      }
    });
    listMcpTools.mockResolvedValue([{ name: 'silpo_get_my_coupons', inputSchema: { type: 'object' } }]);
    callSilpoTool
      .mockRejectedValueOnce(new UnauthorizedException())
      .mockResolvedValueOnce({ items: [] });

    const report = await service.discover('user-1');

    expect(callSilpoTool).toHaveBeenNthCalledWith(1, 'expired-token', 'silpo_get_my_coupons', {}, expect.any(String));
    expect(callSilpoTool).toHaveBeenNthCalledWith(2, 'fresh-token', 'silpo_get_my_coupons', {}, expect.any(String));
    expect(report.tools).toContainEqual(expect.objectContaining({ toolName: 'silpo_get_my_coupons', outcome: 'available' }));
  });

  it('reveals real field key names (user-approved 2026-09-12) but still redacts sensitive-looking keys and never returns values', async () => {
    const { service, listMcpTools, callSilpoTool } = subject();
    listMcpTools.mockResolvedValue([{ name: 'silpo_get_my_coupons', inputSchema: { type: 'object' } }]);
    callSilpoTool.mockResolvedValue({ discountPercent: 15, title: 'Знижка 15%', accessToken: 'zzz-secret' });

    const report = await service.discover('user-1');

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('Знижка');
    expect(serialized).not.toContain('zzz-secret');
    expect(report.tools).toContainEqual({
      toolName: 'silpo_get_my_coupons', outcome: 'available', fields: expect.arrayContaining([
        { path: '$', type: 'object' },
        { path: '$.discountPercent', type: 'number' },
        { path: '$.title', type: 'string' },
        { path: '$.{}', type: 'string' } // accessToken redacted: normalizes to a known-sensitive key
      ])
    });
  });

  it('redacts a key that is not a plausible identifier (e.g. a dynamic code/UUID used as an object key)', async () => {
    const { service, listMcpTools, callSilpoTool } = subject();
    listMcpTools.mockResolvedValue([{ name: 'silpo_get_my_coupons', inputSchema: { type: 'object' } }]);
    callSilpoTool.mockResolvedValue({ 'a1b2-c3d4-SECRET': true });

    const report = await service.discover('user-1');

    expect(JSON.stringify(report)).not.toContain('a1b2-c3d4-SECRET');
    expect(report.tools).toContainEqual({
      toolName: 'silpo_get_my_coupons', outcome: 'available', fields: [
        { path: '$', type: 'object' },
        { path: '$.{}', type: 'boolean' }
      ]
    });
  });

  it('peeks into the first array element to reveal its field shape, with real key names but no values', async () => {
    const { service, listMcpTools, callSilpoTool } = subject();
    callSilpoTool.mockResolvedValue({ items: [{ id: 'SECRET-ID', active: true, tags: ['x'] }, { id: 'OTHER-ID', active: false, tags: [] }] });
    listMcpTools.mockResolvedValue([{ name: 'silpo_get_my_coupons', inputSchema: { type: 'object' } }]);

    const report = await service.discover('user-1');

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('SECRET-ID');
    expect(serialized).not.toContain('OTHER-ID');
    expect(report.tools).toContainEqual({
      toolName: 'silpo_get_my_coupons', outcome: 'available', fields: expect.arrayContaining([
        { path: '$', type: 'object' },
        { path: '$.items[]', type: 'array' },
        { path: '$.items[].id', type: 'string' },
        { path: '$.items[].active', type: 'boolean' },
        { path: '$.items[].tags[]', type: 'array' }
      ])
    });
  });

  it('does not peek into an array of non-object elements', async () => {
    const { service, listMcpTools, callSilpoTool } = subject();
    listMcpTools.mockResolvedValue([{ name: 'silpo_get_my_coupons', inputSchema: { type: 'object' } }]);
    callSilpoTool.mockResolvedValue({ codes: ['SECRET-CODE-1', 'SECRET-CODE-2'] });

    const report = await service.discover('user-1');

    expect(JSON.stringify(report)).not.toContain('SECRET-CODE');
    expect(report.tools).toContainEqual({
      toolName: 'silpo_get_my_coupons', outcome: 'available', fields: [
        { path: '$', type: 'object' },
        { path: '$.codes[]', type: 'array' }
      ]
    });
  });

  it('does not invoke a tool when its schema does not prove that an empty object is valid', async () => {
    const { service, listMcpTools, callSilpoTool } = subject();
    listMcpTools.mockResolvedValue([{ name: 'silpo_get_my_coupons', inputSchema: { type: 'object', minProperties: 1 } }]);

    const report = await service.discover('user-1');

    expect(report.tools).toContainEqual({ toolName: 'silpo_get_my_coupons', outcome: 'unavailable', fields: [] });
    expect(callSilpoTool).not.toHaveBeenCalled();
  });

  it('still calls a tool whose schema carries the standard $schema meta key alongside an empty properties object', async () => {
    const { service, listMcpTools, callSilpoTool } = subject();
    listMcpTools.mockResolvedValue([{
      name: 'silpo_get_my_promos',
      inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: {} }
    }]);
    callSilpoTool.mockResolvedValue({ items: [] });

    const report = await service.discover('user-1');

    expect(callSilpoTool).toHaveBeenCalledWith('access-token', 'silpo_get_my_promos', {}, expect.any(String));
    expect(report.tools).toContainEqual(expect.objectContaining({ toolName: 'silpo_get_my_promos', outcome: 'available' }));
  });
});
