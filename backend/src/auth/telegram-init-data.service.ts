import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';

export type VerifiedTelegramUser = {
  telegramUserId: string;
  username: string | undefined;
  firstName: string | undefined;
  lastName: string | undefined;
  languageCode: string | undefined;
};

@Injectable()
export class TelegramInitDataService {
  constructor(@Optional() private readonly botToken = process.env.TELEGRAM_BOT_TOKEN ?? '') {}

  validate(raw: string): VerifiedTelegramUser {
    try {
      if (!this.botToken) throw new Error();
      const params = new URLSearchParams(raw);
      const keys = new Set<string>();
      for (const [key] of params) {
        if (keys.has(key)) throw new Error();
        keys.add(key);
      }

      const hash = params.get('hash');
      if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error();
      params.delete('hash');
      const dataCheckString = [...params.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
      const secret = createHmac('sha256', 'WebAppData').update(this.botToken).digest();
      const expected = createHmac('sha256', secret).update(dataCheckString).digest();
      const actual = Buffer.from(hash, 'hex');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();

      const authDate = params.get('auth_date');
      if (!authDate || !/^\d+$/.test(authDate)) throw new Error();
      const authDateSeconds = Number(authDate);
      const now = Math.floor(Date.now() / 1000);
      if (!Number.isSafeInteger(authDateSeconds) || now - authDateSeconds > 300 || authDateSeconds - now > 30) throw new Error();

      const parsedUser: unknown = JSON.parse(params.get('user') ?? '');
      if (!parsedUser || typeof parsedUser !== 'object' || !('id' in parsedUser)) throw new Error();
      const user = parsedUser as Record<string, unknown>;
      if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0) throw new Error();

      return {
        telegramUserId: String(user.id),
        username: stringField(user.username),
        firstName: stringField(user.first_name),
        lastName: stringField(user.last_name),
        languageCode: stringField(user.language_code)
      };
    } catch {
      throw new BadRequestException();
    }
  }
}

const stringField = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
