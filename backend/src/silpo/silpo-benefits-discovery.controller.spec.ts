import { HttpException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { createHash } from 'node:crypto';
import { CsrfGuard } from '../auth/csrf.guard';
import { SessionGuard } from '../auth/session.guard';
import type { SessionService } from '../auth/session.service';
import { SilpoBenefitsDiscoveryController } from './silpo-benefits-discovery.controller';
import { SilpoBenefitsDiscoveryService } from './silpo-benefits-discovery.service';
import { SilpoModule } from './silpo.module';

const discovery = { discover: jest.fn(), listPersonalBenefits: jest.fn() };
const sessions = { incrementRateLimit: jest.fn().mockResolvedValue(1) };

const subject = () => new SilpoBenefitsDiscoveryController(
  discovery as unknown as SilpoBenefitsDiscoveryService,
  sessions as unknown as SessionService
);

describe('SilpoBenefitsDiscoveryController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    discovery.discover.mockResolvedValue({ tools: [] });
    discovery.listPersonalBenefits.mockResolvedValue({ outcome: 'available', benefits: [] });
    sessions.incrementRateLimit.mockResolvedValue(1);
  });

  it('uses SessionGuard and CsrfGuard, then forwards only the authenticated id', async () => {
    expect(Reflect.getMetadata('__guards__', SilpoBenefitsDiscoveryController.prototype.discover))
      .toEqual(expect.arrayContaining([SessionGuard, CsrfGuard]));

    await expect(subject().discover({ user: { id: 'user-1' } })).resolves.toEqual({ tools: [] });
    expect(discovery.discover).toHaveBeenCalledWith('user-1');
  });

  it('protects the personal-benefits endpoint and forwards only the user id', async () => {
    await expect(subject().listPersonalBenefits({ user: { id: 'user-1' } })).resolves.toEqual({ outcome: 'available', benefits: [] });
    expect(discovery.listPersonalBenefits).toHaveBeenCalledWith('user-1');
    expect(Reflect.getMetadata('__guards__', SilpoBenefitsDiscoveryController.prototype.listPersonalBenefits))
      .toEqual(expect.arrayContaining([SessionGuard, CsrfGuard]));
  });

  it('binds the exact POST route and passes through a non-empty report unchanged', async () => {
    const report = {
      tools: [{ toolName: 'silpo_get_my_promos', outcome: 'available', fields: [{ path: '$', type: 'object' }] }]
    } as const;
    discovery.discover.mockResolvedValueOnce(report);

    expect(Reflect.getMetadata(PATH_METADATA, SilpoBenefitsDiscoveryController)).toBe('silpo/benefits');
    expect(Reflect.getMetadata(PATH_METADATA, SilpoBenefitsDiscoveryController.prototype.discover)).toBe('discovery');
    expect(Reflect.getMetadata(METHOD_METADATA, SilpoBenefitsDiscoveryController.prototype.discover)).toBe(RequestMethod.POST);
    await expect(subject().discover({ user: { id: 'user-1' } })).resolves.toBe(report);
  });

  it('uses the exact hashed user rate key and sixty-second window', async () => {
    await subject().discover({ user: { id: 'user-1' } });

    expect(sessions.incrementRateLimit).toHaveBeenCalledWith(
      `silpo:benefits-discovery:user:${createHash('sha256').update('user-1').digest('hex')}`,
      60
    );
  });

  it('returns 429 before the service after three calls', async () => {
    sessions.incrementRateLimit.mockResolvedValueOnce(4);

    await expect(subject().discover({ user: { id: 'user-1' } })).rejects.toMatchObject({ status: 429 });
    expect(discovery.discover).not.toHaveBeenCalled();
  });

  it('rejects requests without an authenticated user', async () => {
    await expect(subject().discover({})).rejects.toBeInstanceOf(HttpException);
    expect(sessions.incrementRateLimit).not.toHaveBeenCalled();
    expect(discovery.discover).not.toHaveBeenCalled();
  });

  it('registers the controller and provider in SilpoModule', () => {
    expect(Reflect.getMetadata('controllers', SilpoModule)).toContain(SilpoBenefitsDiscoveryController);
    expect(Reflect.getMetadata('providers', SilpoModule)).toContain(SilpoBenefitsDiscoveryService);
  });
});
