import { BadGatewayException } from '@nestjs/common';
import type { SilpoConnectionService } from './silpo-connection.service';
import type { SilpoOauthService } from './silpo-oauth.service';
import { SilpoProductService } from './silpo-product.service';

type Payload = Record<string, unknown>;

function subject(payload: Payload | (() => Promise<Payload>)) {
  const callSilpoTool = jest.fn(
    async (_token: string, _name: string, _args: Record<string, unknown>, _id: string) =>
      (typeof payload === 'function' ? payload() : payload)
  );
  const withReadAccess = jest.fn(async (_userId: string, op: (token: string) => Promise<unknown>) => op('access-token'));
  const service = new SilpoProductService(
    { withReadAccess } as unknown as SilpoConnectionService,
    { callSilpoTool } as unknown as SilpoOauthService
  );
  return { service, callSilpoTool, withReadAccess };
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
