import { Logger } from '@nestjs/common';
import { TelegramNotificationService } from './telegram-notification.service';

const payload = {
  type: 'price_drop',
  product: { name: 'Молоко', slug: 'milk-1', externalProductId: 'product-1' },
  price: '9.50',
  oldPrice: '10.00'
};

const subject = () => new TelegramNotificationService();

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
});

describe('TelegramNotificationService', () => {
  it('calls the Telegram Bot API sendMessage endpoint with the chat id and message text', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    await subject().send('chat-1', payload);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' })
      })
    );
    const body = JSON.parse(String((global.fetch as jest.Mock).mock.calls[0][1].body));
    expect(body.chat_id).toBe('chat-1');
    expect(body.text).toEqual(expect.stringContaining('Молоко'));
    expect(body.text).toEqual(expect.stringContaining('9.50'));

    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('fails closed without throwing and without calling fetch when the token is empty', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(subject().send('chat-1', payload)).resolves.toBeUndefined();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('test-token');
    warn.mockRestore();
  });

  it('sendText calls the same Bot API endpoint with the given chat id and text', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    await subject().sendText('chat-1', 'Telegram-акаунт підключено.');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' })
      })
    );
    const body = JSON.parse(String((global.fetch as jest.Mock).mock.calls[0][1].body));
    expect(body.chat_id).toBe('chat-1');
    expect(body.text).toBe('Telegram-акаунт підключено.');

    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it('sendText fails closed without throwing when the token is empty', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(subject().sendText('chat-1', 'text')).resolves.toBeUndefined();

    expect(global.fetch).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
