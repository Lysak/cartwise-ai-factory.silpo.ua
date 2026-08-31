import { Controller, Get, HttpException, HttpStatus, Post, Query, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { CsrfGuard } from '../auth/csrf.guard';
import { SessionGuard } from '../auth/session.guard';
import { sessionCookieName, sessionCookieOptions, SessionService } from '../auth/session.service';
import { SilpoOauthService, type BrowserFlowPurpose } from './silpo-oauth.service';

type RequestLike = { ip?: string; headers?: { origin?: string }; cookies?: Record<string, string>; user?: { id: string } };
const discoveryCookieName = '__Host-cartwise_discovery';
const identityProbeCookieName = '__Host-cartwise_identity_probe';
const silpoConnectCookieName = '__Host-cartwise_silpo_connect';
const browserFlows: Array<{ cookieName: string; purpose: BrowserFlowPurpose; failureQuery: string }> = [
  { cookieName: silpoConnectCookieName, purpose: 'silpo_connect', failureQuery: 'silpo=failed' },
  { cookieName: identityProbeCookieName, purpose: 'identity_probe', failureQuery: 'silpo_identity_probe=failed' },
  { cookieName: discoveryCookieName, purpose: 'discovery', failureQuery: 'silpo_discovery=failed' }
];

@Controller('auth/silpo')
export class SilpoOauthController {
  constructor(private readonly oauth: SilpoOauthService, private readonly sessions: SessionService) {}

  @Post('discovery/start')
  async discoveryStart(@Req() request: RequestLike, @Res({ passthrough: true }) response: Response): Promise<{ authorizationUrl: string }> {
    if (request.headers?.origin !== requiredOrigin()) throw new UnauthorizedException();
    if (await this.sessions.incrementRateLimit(`silpo:discovery:ip:${hash(request.ip ?? '')}`, 60) > 10) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    const browserBinding = randomBytes(32).toString('base64url');
    const authorizationUrl = await this.oauth.createDiscoveryAuthorization(browserBinding);
    response.cookie(discoveryCookieName, browserBinding, discoveryCookieOptions());
    return { authorizationUrl };
  }

  @Post('identity-probe/start')
  async identityProbeStart(@Req() request: RequestLike, @Res({ passthrough: true }) response: Response): Promise<{ authorizationUrl: string }> {
    if (request.headers?.origin !== requiredOrigin()) throw new UnauthorizedException();
    if (await this.sessions.incrementRateLimit(`silpo:identity-probe:ip:${hash(request.ip ?? '')}`, 60) > 10) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    const browserBinding = randomBytes(32).toString('base64url');
    const authorizationUrl = await this.oauth.createIdentityProbeAuthorization(browserBinding);
    response.cookie(identityProbeCookieName, browserBinding, discoveryCookieOptions());
    return { authorizationUrl };
  }

  @Post('connect/start')
  async connectStart(@Req() request: RequestLike, @Res({ passthrough: true }) response: Response): Promise<{ authorizationUrl: string }> {
    if (request.headers?.origin !== requiredOrigin()) throw new UnauthorizedException();
    if (await this.sessions.incrementRateLimit(`silpo:connect:ip:${hash(request.ip ?? '')}`, 60) > 10) {
      throw new HttpException('Too Many Requests', HttpStatus.TOO_MANY_REQUESTS);
    }
    const browserBinding = randomBytes(32).toString('base64url');
    const authorizationUrl = await this.oauth.createSilpoConnectionAuthorization(browserBinding);
    response.cookie(silpoConnectCookieName, browserBinding, discoveryCookieOptions());
    return { authorizationUrl };
  }

  @Post('reauthorize')
  @UseGuards(SessionGuard, CsrfGuard)
  async reauthorize(@Req() request: RequestLike): Promise<{ authorizationUrl: string }> {
    const sessionId = request.cookies?.[sessionCookieName()];
    const userId = request.user?.id;
    if (!sessionId || !userId) throw new UnauthorizedException();
    return { authorizationUrl: await this.oauth.createReauthorization({ userId, sessionId }) };
  }

  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() response: Response,
    @Req() request: RequestLike
  ): Promise<void> {
    let selected: { cookieName: string; purpose: BrowserFlowPurpose; failureQuery: string; binding: string } | undefined;
    let browserState = false;
    try {
      if (state) {
        for (const flow of browserFlows) {
          const binding = request.cookies?.[flow.cookieName];
          if (binding && await this.oauth.resolveBrowserFlowPurpose(state, binding) === flow.purpose) {
            selected = { ...flow, binding };
            break;
          }
        }
      }
    } catch {
      clearBrowserCookies(response, request.cookies);
      response.redirect(`${requiredOrigin()}/?silpo=failed`);
      return;
    }

    if (!selected && (error || !code || !state)) {
      const fallback = browserFlows.find((flow) => request.cookies?.[flow.cookieName]);
      if (fallback) selected = { ...fallback, binding: request.cookies![fallback.cookieName] };
    }

    if (!selected && state && code && !error && browserFlows.some((flow) => request.cookies?.[flow.cookieName])) {
      try {
        browserState = await this.oauth.hasBrowserFlowState(state);
      } catch {
        clearBrowserCookies(response, request.cookies);
        response.redirect(`${requiredOrigin()}/?silpo=failed`);
        return;
      }
      if (browserState) {
        const fallback = browserFlows.find((flow) => request.cookies?.[flow.cookieName]);
        clearBrowserCookies(response, request.cookies);
        response.redirect(`${requiredOrigin()}/?${fallback?.failureQuery ?? 'silpo=failed'}`);
        return;
      }
    }

    if (selected) {
      try {
        if (error || !code || !state) throw new UnauthorizedException();
        if (selected.purpose === 'silpo_connect') {
          const session = await this.oauth.completeSilpoConnectionAuthorization({ code, state, browserBinding: selected.binding });
          response.clearCookie(selected.cookieName, { ...discoveryCookieOptions(), maxAge: 0 });
          response.cookie(sessionCookieName(), session.sessionId, sessionCookieOptions());
          response.redirect(`${requiredOrigin()}/?silpo=connected`);
        } else if (selected.purpose === 'identity_probe') {
          await this.oauth.completeIdentityProbeAuthorization({ code, state, browserBinding: selected.binding });
          response.clearCookie(selected.cookieName, { ...discoveryCookieOptions(), maxAge: 0 });
          response.redirect(`${requiredOrigin()}/?silpo_identity_probe=complete`);
        } else {
          await this.oauth.completeDiscoveryAuthorization({ code, state, browserBinding: selected.binding });
          response.clearCookie(selected.cookieName, { ...discoveryCookieOptions(), maxAge: 0 });
          response.redirect(`${requiredOrigin()}/?silpo_discovery=complete`);
        }
      } catch {
        response.clearCookie(selected.cookieName, { ...discoveryCookieOptions(), maxAge: 0 });
        response.redirect(`${requiredOrigin()}/?${selected.failureQuery}`);
      }
      return;
    }

    if (browserState || (!state || !code || !!error) && browserFlows.some((flow) => request.cookies?.[flow.cookieName])) {
      const fallback = browserFlows.find((flow) => request.cookies?.[flow.cookieName]);
      clearBrowserCookies(response, request.cookies);
      response.redirect(`${requiredOrigin()}/?${fallback?.failureQuery ?? 'silpo=failed'}`);
      return;
    }

    if (error || !code || !state) {
      response.status(400).send('Silpo authorization was not completed.');
      return;
    }

    try {
      const session = await this.oauth.completeAuthorization({ code, state });
      response.cookie(sessionCookieName(), session.sessionId, sessionCookieOptions());
      response.redirect(`${requiredOrigin()}/?silpo=connected`);
    } catch {
      // A single-use OAuth state (already consumed by an earlier, possibly
      // interrupted request) or a genuinely expired one both land here. The
      // app screen, not a raw 401 JSON body, is the right thing to show —
      // if the first attempt actually succeeded, the session cookie is
      // already set and the user is simply already logged in.
      response.redirect(`${requiredOrigin()}/?silpo=failed`);
    }
  }
}

const requiredOrigin = (): string => {
  if (!process.env.APP_ORIGIN) throw new Error('APP_ORIGIN is required');
  return process.env.APP_ORIGIN.replace(/\/$/, '');
};

const discoveryCookieOptions = () => ({
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 10 * 60 * 1000
});

const clearBrowserCookies = (response: Response, cookies: Record<string, string> | undefined): void => {
  for (const flow of browserFlows) {
    if (cookies?.[flow.cookieName]) response.clearCookie(flow.cookieName, { ...discoveryCookieOptions(), maxAge: 0 });
  }
};

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
