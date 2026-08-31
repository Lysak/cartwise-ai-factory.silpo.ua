import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool } from 'pg';
import { TokenCipherService } from '../security/token-cipher.service';
import { SilpoOauthService, SilpoRefreshRejectedError } from './silpo-oauth.service';

type Connection = {
  id: string;
  userId: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string | null;
  accessTokenExpiresAt: Date | null;
  status: string;
};

const ON_DEMAND_REFRESH_WINDOW_MS = 15 * 60_000;
const SCHEDULED_REFRESH_WINDOW_MS = 2 * 60 * 60_000;

export class SilpoReauthRequiredException extends HttpException {
  constructor() {
    super(
      { code: 'SILPO_REAUTH_REQUIRED', message: 'Silpo reauthorization required' },
      HttpStatus.CONFLICT
    );
  }
}

@Injectable()
export class SilpoConnectionService {
  private readonly logger = new Logger(SilpoConnectionService.name);
  private readonly pool = new Pool({ connectionString: process.env.DATABASE_URL });
  private readonly cipher = new TokenCipherService(process.env.TOKEN_ENCRYPTION_KEY ?? '');

  constructor(private readonly oauth: SilpoOauthService) {}

  async withReadAccess<T>(userId: string, operation: (accessToken: string) => Promise<T>): Promise<T> {
    const access = await this.accessFor(userId);
    try {
      return await operation(access.token);
    } catch (error) {
      if (!isAuthorizationRejection(error)) throw error;
      const token = await this.refreshConnection(access.id, access.token, 0, true);
      return operation(token);
    }
  }

  async withWriteAccess<T>(userId: string, operation: (accessToken: string) => Promise<T>): Promise<T> {
    const access = await this.accessFor(userId);
    return operation(access.token);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async refreshExpiringConnections(): Promise<void> {
    const due = await this.pool.query<{ id: string }>(
      'SELECT id FROM "SilpoConnection" WHERE status = \'active\' AND "accessTokenExpiresAt" <= NOW() + INTERVAL \'2 hours\' ORDER BY "accessTokenExpiresAt"'
    );

    for (const connection of due.rows) {
      try {
        await this.refreshConnection(connection.id, undefined, SCHEDULED_REFRESH_WINDOW_MS);
      } catch (error) {
        if (!(error instanceof SilpoReauthRequiredException)) this.logger.warn('Silpo token refresh deferred');
      }
    }
  }

  private async accessFor(userId: string): Promise<{ id: string; token: string }> {
    const result = await this.pool.query<Connection>(
      'SELECT id, "userId", "accessTokenEncrypted", "refreshTokenEncrypted", "accessTokenExpiresAt", status FROM "SilpoConnection" WHERE "userId" = $1',
      [userId]
    );
    const connection = result.rows[0];
    if (!connection) throw new ServiceUnavailableException('Silpo connection unavailable');
    if (connection.status === 'reauth_required') throw new SilpoReauthRequiredException();

    const token = this.cipher.decrypt(connection.accessTokenEncrypted);
    if (!expiresWithin(connection.accessTokenExpiresAt, ON_DEMAND_REFRESH_WINDOW_MS)) {
      return { id: connection.id, token };
    }
    return { id: connection.id, token: await this.refreshConnection(connection.id, token, ON_DEMAND_REFRESH_WINDOW_MS) };
  }

  private async refreshConnection(
    connectionId: string,
    expectedAccessToken: string | undefined,
    refreshWindowMs: number,
    force = false
  ): Promise<string> {
    const database = await this.pool.connect();
    let committed = false;
    try {
      await database.query('BEGIN');
      const locked = await database.query<Connection>(
        'SELECT id, "userId", "accessTokenEncrypted", "refreshTokenEncrypted", "accessTokenExpiresAt", status FROM "SilpoConnection" WHERE id = $1 FOR UPDATE',
        [connectionId]
      );
      const connection = locked.rows[0];
      if (!connection) throw new ServiceUnavailableException('Silpo connection unavailable');
      if (connection.status === 'reauth_required') throw new SilpoReauthRequiredException();

      const currentAccessToken = this.cipher.decrypt(connection.accessTokenEncrypted);
      if (expectedAccessToken && currentAccessToken !== expectedAccessToken) {
        await database.query('COMMIT');
        committed = true;
        return currentAccessToken;
      }
      if (!force && !expiresWithin(connection.accessTokenExpiresAt, refreshWindowMs)) {
        await database.query('COMMIT');
        committed = true;
        return currentAccessToken;
      }
      if (!connection.refreshTokenEncrypted) {
        throw new ServiceUnavailableException('Silpo refresh token unavailable');
      }

      try {
        const tokens = await this.oauth.refreshToken(this.cipher.decrypt(connection.refreshTokenEncrypted));
        const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
        await database.query(
          'UPDATE "SilpoConnection" SET "accessTokenEncrypted" = $1, "refreshTokenEncrypted" = COALESCE($2, "refreshTokenEncrypted"), "accessTokenExpiresAt" = $3, status = \'active\', "updatedAt" = NOW() WHERE id = $4',
          [
            this.cipher.encrypt(tokens.access_token),
            tokens.refresh_token ? this.cipher.encrypt(tokens.refresh_token) : null,
            expiresAt,
            connection.id
          ]
        );
        await database.query('COMMIT');
        committed = true;
        return tokens.access_token;
      } catch (error) {
        if (!(error instanceof SilpoRefreshRejectedError)) throw error;
        await database.query(
          'UPDATE "SilpoConnection" SET status = \'reauth_required\', "updatedAt" = NOW() WHERE id = $1',
          [connection.id]
        );
        await database.query('COMMIT');
        committed = true;
        throw new SilpoReauthRequiredException();
      }
    } catch (error) {
      if (!committed) await database.query('ROLLBACK');
      throw error;
    } finally {
      database.release();
    }
  }
}

const expiresWithin = (expiresAt: Date | null, windowMs: number): boolean =>
  expiresAt !== null && new Date(expiresAt).getTime() <= Date.now() + windowMs;

const isAuthorizationRejection = (error: unknown): boolean =>
  error instanceof HttpException && error.getStatus() === HttpStatus.UNAUTHORIZED;
