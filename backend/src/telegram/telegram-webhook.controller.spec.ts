import { TelegramWebhookController } from './telegram-webhook.controller';
import type { TelegramLinkService } from './telegram-link.service';
import type { TelegramNotificationService } from '../tracking/telegram-notification.service';

type RequestLike = { headers?: Record<string, string | string[] | undefined>; body?: unknown };

const secretHeaders = (secret = 'webhook-secret') => ({ 'x-telegram-bot-api-secret-token': secret });

describe('TelegramWebhookController', () => {
  const link = { consume: jest.fn() };
  const notifications = { sendText: jest.fn().mockResolvedValue(undefined) };
  const controller = new TelegramWebhookController(link as unknown as TelegramLinkService, notifications as unknown as TelegramNotificationService);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TELEGRAM_WEBHOOK_SECRET = 'webhook-secret';
  });

  afterEach(() => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
  });

  it('rejects a request with a missing secret token header', async () => {
    const request: RequestLike = { headers: {}, body: {} };

    await expect(controller.handle(request as never)).rejects.toThrow();
    expect(link.consume).not.toHaveBeenCalled();
  });

  it('rejects a request with a wrong secret token header', async () => {
    const request: RequestLike = { headers: secretHeaders('wrong-secret'), body: {} };

    await expect(controller.handle(request as never)).rejects.toThrow();
    expect(link.consume).not.toHaveBeenCalled();
  });

  it('accepts and ignores an update that does not match the /start link_ pattern', async () => {
    const request: RequestLike = {
      headers: secretHeaders(),
      body: { message: { chat: { id: 'chat-1', type: 'private' }, from: { id: 'user-1' }, text: 'hello' } }
    };

    await expect(controller.handle(request as never)).resolves.toEqual({ ok: true });
    expect(link.consume).not.toHaveBeenCalled();
  });

  it('accepts an update with no message body and does not process it', async () => {
    const request: RequestLike = { headers: secretHeaders(), body: {} };

    await expect(controller.handle(request as never)).resolves.toEqual({ ok: true });
    expect(link.consume).not.toHaveBeenCalled();
  });

  it('consumes a valid link token using the sender id and sends a confirmation reply to the chat', async () => {
    link.consume.mockResolvedValueOnce('linked');
    const request: RequestLike = {
      headers: secretHeaders(),
      body: { message: { chat: { id: 'chat-1', type: 'private' }, from: { id: 'user-1' }, text: '/start link_raw-token' } }
    };

    await expect(controller.handle(request as never)).resolves.toEqual({ ok: true });
    expect(link.consume).toHaveBeenCalledWith('raw-token', 'user-1');
    expect(notifications.sendText).toHaveBeenCalledWith('chat-1', expect.any(String));
  });

  it('sends a conflict reply and never throws when the sender already belongs to another user', async () => {
    link.consume.mockResolvedValueOnce('conflict');
    const request: RequestLike = {
      headers: secretHeaders(),
      body: { message: { chat: { id: 'chat-1', type: 'private' }, from: { id: 'user-1' }, text: '/start link_raw-token' } }
    };

    await expect(controller.handle(request as never)).resolves.toEqual({ ok: true });
    expect(notifications.sendText).toHaveBeenCalledWith('chat-1', expect.stringContaining('уже підключено до іншого користувача'));
  });

  it('does not reply for an invalid, expired or already-consumed token', async () => {
    link.consume.mockResolvedValueOnce('invalid');
    const request: RequestLike = {
      headers: secretHeaders(),
      body: { message: { chat: { id: 'chat-1', type: 'private' }, from: { id: 'user-1' }, text: '/start link_raw-token' } }
    };

    await expect(controller.handle(request as never)).resolves.toEqual({ ok: true });
    expect(notifications.sendText).not.toHaveBeenCalled();
  });

  it('ignores a /start link_ command sent in a non-private chat and never consumes the token', async () => {
    const request: RequestLike = {
      headers: secretHeaders(),
      body: { message: { chat: { id: '-100200300', type: 'group' }, from: { id: 'user-1' }, text: '/start link_raw-token' } }
    };

    await expect(controller.handle(request as never)).resolves.toEqual({ ok: true });
    expect(link.consume).not.toHaveBeenCalled();
    expect(notifications.sendText).not.toHaveBeenCalled();
  });

  it('ignores an update with no sender id even in a private chat', async () => {
    const request: RequestLike = {
      headers: secretHeaders(),
      body: { message: { chat: { id: 'chat-1', type: 'private' }, text: '/start link_raw-token' } }
    };

    await expect(controller.handle(request as never)).resolves.toEqual({ ok: true });
    expect(link.consume).not.toHaveBeenCalled();
  });

  it('answers 200 without a reply when consume fails for a reason other than a conflict', async () => {
    link.consume.mockRejectedValueOnce(new Error('connection reset'));
    const request: RequestLike = {
      headers: secretHeaders(),
      body: { message: { chat: { id: 'chat-1', type: 'private' }, from: { id: 'user-1' }, text: '/start link_raw-token' } }
    };

    await expect(controller.handle(request as never)).resolves.toEqual({ ok: true });
    expect(notifications.sendText).not.toHaveBeenCalled();
  });
});
