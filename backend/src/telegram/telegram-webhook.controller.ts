import { Controller, Post, Req, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { TelegramLinkService } from './telegram-link.service';
import { TelegramNotificationService } from '../tracking/telegram-notification.service';

const startLinkPattern = /^\/start link_(\S+)$/;

type WebhookBody = {
  message?: {
    chat?: { id?: string | number; type?: string };
    from?: { id?: string | number };
    text?: string;
  };
};

type RequestLike = {
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

@Controller('telegram')
export class TelegramWebhookController {
  constructor(
    private readonly link: TelegramLinkService,
    private readonly notifications: TelegramNotificationService
  ) {}

  @Post('webhook')
  async handle(@Req() request: RequestLike): Promise<{ ok: true }> {
    if (!matchesSecret(request.headers?.['x-telegram-bot-api-secret-token'])) throw new UnauthorizedException();

    const message = (request.body as WebhookBody)?.message;
    const chatId = message?.chat?.id;
    const fromId = message?.from?.id;
    const match = typeof message?.text === 'string' ? startLinkPattern.exec(message.text) : null;
    // Identity must come from the sender (`from.id`), not the chat: in a group
    // the bot is a member of, `chat.id` is the group's id, not the user's, and
    // `User.telegramUserId` is a per-user identity everywhere else (session
    // lookup, price-drop sends). Restricting to private chats too means the
    // deep-link flow can only ever be completed 1:1 with the bot.
    if (!match || chatId == null || fromId == null || message?.chat?.type !== 'private') return { ok: true };

    let result: 'linked' | 'conflict' | 'invalid';
    try {
      result = await this.link.consume(match[1], String(fromId));
    } catch {
      // Never 5xx Telegram: the token is already consumed at this point
      // (single-use UPDATE happens first), so a retry cannot succeed anyway.
      return { ok: true };
    }
    if (result === 'linked') {
      await this.notifications.sendText(String(chatId), 'Telegram-акаунт підключено до Cartwise.');
    } else if (result === 'conflict') {
      await this.notifications.sendText(String(chatId), 'Цей Telegram-акаунт уже підключено до іншого користувача Cartwise.');
    }
    // 'invalid' (unknown/expired/already-consumed token): silently ignored per plan.
    return { ok: true };
  }
}

const matchesSecret = (header: string | string[] | undefined): boolean => {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || typeof header !== 'string' || !header) return false;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(header);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
};
