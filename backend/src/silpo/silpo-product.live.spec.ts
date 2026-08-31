/**
 * Live end-to-end check against the real Silpo MCP through the deployed Cartwise backend.
 * Opt-in only: set SILPO_E2E_SESSION to the value of a logged-in `__Host-cartwise_session` cookie.
 *
 *   SILPO_E2E_SESSION=<cookie> npm test -- silpo-product.live.spec.ts
 *
 * Skipped in normal (offline, deterministic) runs.
 */
const session = process.env.SILPO_E2E_SESSION;
const baseUrl = (process.env.SILPO_E2E_BASE_URL ?? 'https://silpo.lysak.pp.ua').replace(/\/$/, '');
const describeLive = session ? describe : describe.skip;

type BranchSummary = {
  silpoBranchId: string;
  externalId: string | null;
  city: string | null;
  address: string | null;
  hasPickup: boolean | null;
};

describeLive('live: GET /api/silpo/branches', () => {
  jest.setTimeout(30_000);

  const get = async (query: string): Promise<{ status: number; body: { branches?: BranchSummary[]; nextOffset?: number | null } }> => {
    const response = await fetch(`${baseUrl}/api/silpo/branches${query}`, {
      headers: { Cookie: `__Host-cartwise_session=${session}` }
    });
    return { status: response.status, body: response.status === 200 ? await response.json() : {} };
  };

  it('grants access to the Vinnytsia branch on вул. Зодчих, 2', async () => {
    const { status, body } = await get('?limit=500');
    expect(status).toBe(200);

    const branches = body.branches ?? [];
    expect(branches.length).toBeGreaterThan(0);

    const zodchykh = branches.find(
      (branch) => branch.city === 'Вінниця' && (branch.address ?? '').includes('Зодчих')
    );

    expect(zodchykh).toBeDefined();
    expect(zodchykh).toMatchObject({
      externalId: '2086',
      city: 'Вінниця',
      address: 'вул. Зодчих, 2',
      silpoBranchId: expect.stringMatching(/^[0-9a-f-]{36}$/)
    });
    // The store supports self-pickup, so it is a valid target for later product / cart reads.
    expect(zodchykh?.hasPickup).toBe(true);
  });
});
