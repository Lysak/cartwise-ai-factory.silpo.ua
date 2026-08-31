import { HttpException, UnauthorizedException } from '@nestjs/common';
import { SilpoOauthController } from './silpo-oauth.controller';
import type { SilpoOauthService } from './silpo-oauth.service';
import type { SessionService } from '../auth/session.service';

const origin = 'https://app.example.com';
const oauth = {
  createDiscoveryAuthorization: jest.fn().mockResolvedValue('https://mcp.silpo.ua/authorize?state=test'),
  completeDiscoveryAuthorization: jest.fn().mockResolvedValue(undefined),
  createIdentityProbeAuthorization: jest.fn().mockResolvedValue('https://mcp.silpo.ua/authorize?state=identity-test'),
  completeIdentityProbeAuthorization: jest.fn().mockResolvedValue(undefined),
  createSilpoConnectionAuthorization: jest.fn().mockResolvedValue('https://mcp.silpo.ua/authorize?state=connect-test'),
  completeSilpoConnectionAuthorization: jest.fn().mockResolvedValue({ userId: 'user-1', sessionId: 'session-1', csrfToken: 'csrf-token' }),
  resolveBrowserFlowPurpose: jest.fn().mockResolvedValue(null),
  hasBrowserFlowState: jest.fn().mockResolvedValue(false),
  completeAuthorization: jest.fn()
};
const sessions = { incrementRateLimit: jest.fn().mockResolvedValue(1) };

describe('SilpoOauthController discovery', () => {
  beforeEach(() => {
    process.env.APP_ORIGIN = origin;
    jest.clearAllMocks();
    oauth.resolveBrowserFlowPurpose.mockResolvedValue(null);
    oauth.hasBrowserFlowState.mockResolvedValue(false);
  });

  it('starts discovery only from the configured origin and sets an HttpOnly binding cookie', async () => {
    const controller = subject();
    const response = httpResponse();

    await expect(start(controller, { headers: { origin }, ip: '127.0.0.1' }, response)).resolves.toEqual({
      authorizationUrl: 'https://mcp.silpo.ua/authorize?state=test'
    });

    expect(sessions.incrementRateLimit).toHaveBeenCalledWith(expect.stringContaining('silpo:discovery:ip:'), 60);
    expect(oauth.createDiscoveryAuthorization).toHaveBeenCalledWith(expect.any(String));
    expect(response.cookie).toHaveBeenCalledWith('__Host-cartwise_discovery', expect.any(String), expect.objectContaining({
      httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600000
    }));
  });

  it.each([undefined, 'https://foreign.example'])('rejects discovery start with origin %s', async (requestOrigin) => {
    const controller = subject();

    await expect(start(controller, { headers: { origin: requestOrigin }, ip: '127.0.0.1' }, httpResponse()))
      .rejects.toBeInstanceOf(UnauthorizedException);

    expect(oauth.createDiscoveryAuthorization).not.toHaveBeenCalled();
  });

  it('clears the discovery cookie and redirects to complete after a successful callback', async () => {
    const controller = subject();
    const response = httpResponse();
    oauth.resolveBrowserFlowPurpose.mockResolvedValueOnce('discovery');

    await callback(controller, 'authorization-code', 'state-value', undefined, response, {
      cookies: { '__Host-cartwise_discovery': 'browser-binding' }
    });

    expect(oauth.completeDiscoveryAuthorization).toHaveBeenCalledWith({
      code: 'authorization-code', state: 'state-value', browserBinding: 'browser-binding'
    });
    expect(response.clearCookie).toHaveBeenCalledWith('__Host-cartwise_discovery', expect.objectContaining({ maxAge: 0 }));
    expect(response.redirect).toHaveBeenCalledWith(`${origin}/?silpo_discovery=complete`);
  });

  it('starts identity probe with a separate HttpOnly binding cookie', async () => {
    const controller = subject();
    const response = httpResponse();

    await expect(identityStart(controller, { headers: { origin }, ip: '127.0.0.1' }, response)).resolves.toEqual({
      authorizationUrl: 'https://mcp.silpo.ua/authorize?state=identity-test'
    });

    expect(sessions.incrementRateLimit).toHaveBeenCalledWith(expect.stringContaining('silpo:identity-probe:ip:'), 60);
    expect(oauth.createIdentityProbeAuthorization).toHaveBeenCalledWith(expect.any(String));
    expect(response.cookie).toHaveBeenCalledWith('__Host-cartwise_identity_probe', expect.any(String), expect.objectContaining({
      httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600000
    }));
  });

  it('clears the identity-probe cookie and redirects to complete after callback', async () => {
    const controller = subject();
    const response = httpResponse();
    oauth.resolveBrowserFlowPurpose.mockResolvedValueOnce('identity_probe');

    await callback(controller, 'authorization-code', 'state-value', undefined, response, {
      cookies: { '__Host-cartwise_identity_probe': 'browser-binding' }
    });

    expect(oauth.completeIdentityProbeAuthorization).toHaveBeenCalledWith({
      code: 'authorization-code', state: 'state-value', browserBinding: 'browser-binding'
    });
    expect(response.clearCookie).toHaveBeenCalledWith('__Host-cartwise_identity_probe', expect.objectContaining({ maxAge: 0 }));
    expect(response.redirect).toHaveBeenCalledWith(`${origin}/?silpo_identity_probe=complete`);
  });

  it('starts Silpo connect only from the configured origin and sets the session-binding cookie', async () => {
    const controller = subject();
    const response = httpResponse();

    await expect(connectStart(controller, { headers: { origin }, ip: '127.0.0.1' }, response)).resolves.toEqual({
      authorizationUrl: 'https://mcp.silpo.ua/authorize?state=connect-test'
    });

    expect(sessions.incrementRateLimit).toHaveBeenCalledWith(expect.stringContaining('silpo:connect:ip:'), 60);
    expect(oauth.createSilpoConnectionAuthorization).toHaveBeenCalledWith(expect.any(String));
    expect(response.cookie).toHaveBeenCalledWith('__Host-cartwise_silpo_connect', expect.any(String), expect.objectContaining({
      httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600000
    }));
  });

  it.each([undefined, 'https://foreign.example'])('rejects Silpo connect start with origin %s', async (requestOrigin) => {
    const controller = subject();

    await expect(connectStart(controller, { headers: { origin: requestOrigin }, ip: '127.0.0.1' }, httpResponse()))
      .rejects.toBeInstanceOf(UnauthorizedException);

    expect(oauth.createSilpoConnectionAuthorization).not.toHaveBeenCalled();
  });

  it('enforces the Silpo connect rate-limit boundary', async () => {
    sessions.incrementRateLimit.mockResolvedValueOnce(11);
    const controller = subject();

    await connectStart(controller, { headers: { origin }, ip: '127.0.0.1' }, httpResponse()).then(
      () => { throw new Error('Expected rate limit rejection'); },
      (error: unknown) => {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(429);
      }
    );

    expect(oauth.createSilpoConnectionAuthorization).not.toHaveBeenCalled();
  });

  it('sets the opaque session cookie and clears the connect cookie after a successful callback', async () => {
    const controller = subject();
    const response = httpResponse();
    oauth.resolveBrowserFlowPurpose.mockResolvedValueOnce('silpo_connect');

    await callback(controller, 'authorization-code', 'state-value', undefined, response, {
      cookies: { '__Host-cartwise_silpo_connect': 'browser-binding' }
    });

    expect(oauth.completeSilpoConnectionAuthorization).toHaveBeenCalledWith({
      code: 'authorization-code', state: 'state-value', browserBinding: 'browser-binding'
    });
    expect(response.cookie).toHaveBeenCalledWith('__Host-cartwise_session', 'session-1', expect.objectContaining({
      httpOnly: true, secure: true, sameSite: 'lax', path: '/'
    }));
    expect(response.clearCookie).toHaveBeenCalledWith('__Host-cartwise_silpo_connect', expect.objectContaining({ maxAge: 0 }));
    expect(response.redirect).toHaveBeenCalledWith(`${origin}/?silpo=connected`);
  });

  it('clears the connect cookie and redirects to a generic failure after a failed callback', async () => {
    oauth.completeSilpoConnectionAuthorization.mockRejectedValueOnce(new Error('provider value must not escape'));
    const controller = subject();
    const response = httpResponse();
    oauth.resolveBrowserFlowPurpose.mockResolvedValueOnce('silpo_connect');

    await callback(controller, 'authorization-code', 'state-value', undefined, response, {
      cookies: { '__Host-cartwise_silpo_connect': 'browser-binding' }
    });

    expect(response.clearCookie).toHaveBeenCalledWith('__Host-cartwise_silpo_connect', expect.objectContaining({ maxAge: 0 }));
    expect(response.redirect).toHaveBeenCalledWith(`${origin}/?silpo=failed`);
  });

  it('dispatches by the state-matching binding when stale connect and identity cookies coexist', async () => {
    const controller = subject();
    const response = httpResponse();
    oauth.resolveBrowserFlowPurpose.mockImplementation(async (_state: string, binding: string) =>
      binding === 'identity-binding' ? 'identity_probe' : null
    );

    await callback(controller, 'authorization-code', 'identity-state', undefined, response, {
      cookies: {
        '__Host-cartwise_silpo_connect': 'stale-connect-binding',
        '__Host-cartwise_identity_probe': 'identity-binding'
      }
    });

    expect(oauth.completeIdentityProbeAuthorization).toHaveBeenCalledWith({
      code: 'authorization-code', state: 'identity-state', browserBinding: 'identity-binding'
    });
    expect(oauth.completeSilpoConnectionAuthorization).not.toHaveBeenCalled();
    expect(response.clearCookie).toHaveBeenCalledWith('__Host-cartwise_identity_probe', expect.objectContaining({ maxAge: 0 }));
    expect(response.clearCookie).not.toHaveBeenCalledWith('__Host-cartwise_silpo_connect', expect.anything());
  });

  it('falls through to legacy Telegram completion for a valid legacy state with a stale browser cookie', async () => {
    oauth.completeAuthorization.mockResolvedValueOnce({ userId: 'telegram-user', sessionId: 'telegram-session' });
    const controller = subject();
    const response = httpResponse();

    await callback(controller, 'authorization-code', 'telegram-state', undefined, response, {
      cookies: { '__Host-cartwise_silpo_connect': 'stale-connect-binding' }
    });

    expect(oauth.completeAuthorization).toHaveBeenCalledWith({ code: 'authorization-code', state: 'telegram-state' });
    expect(oauth.completeSilpoConnectionAuthorization).not.toHaveBeenCalled();
    expect(oauth.completeIdentityProbeAuthorization).not.toHaveBeenCalled();
    expect(response.cookie).toHaveBeenCalledWith('__Host-cartwise_session', 'telegram-session', expect.anything());
    expect(response.redirect).toHaveBeenCalledWith(`${origin}/?silpo=connected`);
  });

  it('clears the matching connect cookie and redirects generically on provider error without consuming state', async () => {
    oauth.resolveBrowserFlowPurpose.mockResolvedValueOnce('silpo_connect');
    const controller = subject();
    const response = httpResponse();

    await callback(controller, 'authorization-code', 'state-value', 'access_denied', response, {
      cookies: { '__Host-cartwise_silpo_connect': 'browser-binding' }
    });

    expect(oauth.completeSilpoConnectionAuthorization).not.toHaveBeenCalled();
    expect(response.clearCookie).toHaveBeenCalledWith('__Host-cartwise_silpo_connect', expect.objectContaining({ maxAge: 0 }));
    expect(response.redirect).toHaveBeenCalledWith(`${origin}/?silpo=failed`);
  });

  it.each([
    ['missing code', undefined, 'state-value'],
    ['missing state', 'authorization-code', undefined]
  ])('clears the dedicated identity cookie and redirects generically on %s', async (_caseName, callbackCode, callbackState) => {
    oauth.resolveBrowserFlowPurpose.mockResolvedValueOnce('identity_probe');
    const controller = subject();
    const response = httpResponse();

    await callback(controller, callbackCode, callbackState, undefined, response, {
      cookies: { '__Host-cartwise_identity_probe': 'browser-binding' }
    });

    expect(oauth.completeIdentityProbeAuthorization).not.toHaveBeenCalled();
    expect(response.clearCookie).toHaveBeenCalledWith('__Host-cartwise_identity_probe', expect.objectContaining({ maxAge: 0 }));
    expect(response.redirect).toHaveBeenCalledWith(`${origin}/?silpo_identity_probe=failed`);
  });
});

function subject(): SilpoOauthController {
  return new (SilpoOauthController as unknown as new (oauth: SilpoOauthService, sessions: SessionService) => SilpoOauthController)(
    oauth as unknown as SilpoOauthService,
    sessions as unknown as SessionService
  );
}

function start(controller: SilpoOauthController, request: unknown, response: unknown) {
  return (controller as unknown as {
    discoveryStart(request: unknown, response: unknown): Promise<{ authorizationUrl: string }>;
  }).discoveryStart(request, response);
}

function identityStart(controller: SilpoOauthController, request: unknown, response: unknown) {
  return (controller as unknown as {
    identityProbeStart(request: unknown, response: unknown): Promise<{ authorizationUrl: string }>;
  }).identityProbeStart(request, response);
}

function connectStart(controller: SilpoOauthController, request: unknown, response: unknown) {
  return (controller as unknown as {
    connectStart(request: unknown, response: unknown): Promise<{ authorizationUrl: string }>;
  }).connectStart(request, response);
}

function callback(controller: SilpoOauthController, code: string | undefined, state: string | undefined, error: string | undefined, response: unknown, request: unknown) {
  return (controller as unknown as {
    callback(code: string | undefined, state: string | undefined, error: string | undefined, response: unknown, request: unknown): Promise<void>;
  }).callback(code, state, error, response, request);
}

function httpResponse() {
  return { cookie: jest.fn(), clearCookie: jest.fn(), redirect: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() };
}
