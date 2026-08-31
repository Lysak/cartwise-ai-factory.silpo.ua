import { BadRequestException, HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuthController } from './auth.controller';
import type { SessionService } from './session.service';
import type { TelegramInitDataService, VerifiedTelegramUser } from './telegram-init-data.service';
import type { SilpoOauthService } from '../silpo/silpo-oauth.service';

const telegram: VerifiedTelegramUser = {
  telegramUserId: '123456789012', username: 'test_user', firstName: 'Test', lastName: undefined, languageCode: 'uk'
};

const response = () => ({ cookie: jest.fn(), clearCookie: jest.fn() });

describe('AuthController', () => {
  const sessions = {
    incrementRateLimit: jest.fn().mockResolvedValue(1),
    resolve: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({ id: 'new-session', csrfToken: 'csrf-token' }),
    destroy: jest.fn().mockResolvedValue(undefined)
  };
  const validator = { validate: jest.fn().mockReturnValue(telegram) };
  const oauth = { createFirstAuthorization: jest.fn().mockResolvedValue('https://silpo.example/authorize') };
  const pool = { query: jest.fn() };
  const controller = new AuthController(
    sessions as unknown as SessionService,
    validator as unknown as TelegramInitDataService,
    oauth as unknown as SilpoOauthService,
    pool
  );

  beforeEach(() => jest.clearAllMocks());

  it('creates a local session for an existing verified Telegram user', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 'user-1', status: 'active' }] });
    const res = response();

    await expect(controller.bootstrap('validated-init-data', { ip: '127.0.0.1', cookies: {} }, res as never)).resolves.toEqual({
      status: 'authenticated', csrfToken: 'csrf-token', silpoStatus: 'active'
    });

    expect(sessions.create).toHaveBeenCalledWith({ userId: 'user-1', telegramUserId: telegram.telegramUserId });
    expect(oauth.createFirstAuthorization).not.toHaveBeenCalled();
    expect(res.cookie).toHaveBeenCalled();
  });

  it('renews a matching session with its current Silpo status', async () => {
    sessions.resolve.mockResolvedValueOnce({ userId: 'user-1', telegramUserId: telegram.telegramUserId, csrfSecret: 'csrf-token' });
    pool.query.mockResolvedValue({ rows: [{ status: 'active' }] });

    await expect(controller.bootstrap('validated-init-data', { ip: '127.0.0.1', cookies: { '__Host-cartwise_session': 'session-id' } }, response() as never)).resolves.toEqual({
      status: 'authenticated', csrfToken: 'csrf-token', silpoStatus: 'active'
    });

    expect(pool.query).toHaveBeenCalledWith('SELECT status FROM "SilpoConnection" WHERE "userId" = $1', ['user-1']);
  });

  it('returns reauth_required for a matching session with a reauthentication-required Silpo connection', async () => {
    sessions.resolve.mockResolvedValueOnce({ userId: 'user-1', telegramUserId: telegram.telegramUserId, csrfSecret: 'csrf-token' });
    pool.query.mockResolvedValue({ rows: [{ status: 'reauth_required' }] });

    await expect(controller.bootstrap('validated-init-data', { ip: '127.0.0.1', cookies: { '__Host-cartwise_session': 'session-id' } }, response() as never)).resolves.toEqual({
      status: 'authenticated', csrfToken: 'csrf-token', silpoStatus: 'reauth_required'
    });

    expect(pool.query).toHaveBeenCalledWith('SELECT status FROM "SilpoConnection" WHERE "userId" = $1', ['user-1']);
  });

  it('creates an owned first-authorization state only for a verified new Telegram user', async () => {
    pool.query.mockResolvedValue({ rows: [] });

    await expect(controller.bootstrap('validated-init-data', { ip: '127.0.0.1', cookies: {} }, response() as never)).resolves.toEqual({
      status: 'oauth_required', authorizationUrl: 'https://silpo.example/authorize'
    });

    expect(oauth.createFirstAuthorization).toHaveBeenCalledWith(telegram);
  });

  it('does not create authorization state when Telegram validation fails', async () => {
    validator.validate.mockImplementationOnce(() => { throw new BadRequestException(); });

    await expect(controller.bootstrap('invalid', { ip: '127.0.0.1', cookies: {} }, response() as never)).rejects.toBeInstanceOf(BadRequestException);

    expect(oauth.createFirstAuthorization).not.toHaveBeenCalled();
  });

  it('returns 429 before validating an over-limit source IP', async () => {
    sessions.incrementRateLimit.mockResolvedValueOnce(11);

    await controller.bootstrap('init-data', { ip: '127.0.0.1', cookies: {} }, response() as never).then(
      () => { throw new Error('Expected rate limit rejection'); },
      (error: unknown) => {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(429);
      }
    );

    expect(validator.validate).not.toHaveBeenCalled();
  });

  it('returns the current CSRF token and connection status for a session', async () => {
    sessions.resolve.mockResolvedValueOnce({ userId: 'user-1', telegramUserId: telegram.telegramUserId, csrfSecret: 'csrf-token' });
    pool.query.mockResolvedValue({ rows: [{ status: 'reauth_required' }] });

    await expect(controller.session({ cookies: { '__Host-cartwise_session': 'session-id' }, user: { id: 'user-1' } })).resolves.toEqual({
      status: 'authenticated', csrfToken: 'csrf-token', silpoStatus: 'reauth_required'
    });
  });

  it('returns no provider identity or token material from the session status endpoint', async () => {
    sessions.resolve.mockResolvedValueOnce({ userId: 'user-1', telegramUserId: null, csrfSecret: 'csrf-token' });
    pool.query.mockResolvedValue({ rows: [{ status: 'active', silpoExternalId: 'provider-id', accessToken: 'raw-token' }] });

    const result = await controller.session({ cookies: { '__Host-cartwise_session': 'session-id' }, user: { id: 'user-1' } });

    expect(result).toEqual({ status: 'authenticated', csrfToken: 'csrf-token', silpoStatus: 'active' });
    expect(JSON.stringify(result)).not.toContain('provider-id');
    expect(JSON.stringify(result)).not.toContain('raw-token');
  });

  it('destroys the session and clears its cookie on logout', async () => {
    const res = response();

    await expect(controller.logout({ cookies: { '__Host-cartwise_session': 'session-id' } }, res as never)).resolves.toEqual({ status: 'logged_out' });

    expect(sessions.destroy).toHaveBeenCalledWith('session-id');
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM "OAuthState"'), [
      createHash('sha256').update('session-id').digest('base64url')
    ]);
    expect(res.clearCookie).toHaveBeenCalled();
  });
});
