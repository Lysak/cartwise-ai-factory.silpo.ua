import { Injectable, Logger } from '@nestjs/common';

export type TelegramNotificationPayload = {
  type: string;
  product: { name: string; slug: string; externalProductId: string };
  price: string | null;
  oldPrice: string | null;
};

// ponytail: native fetch, no Telegram SDK dependency for one endpoint call.
@Injectable()
export class TelegramNotificationService {
  private readonly logger = new Logger(TelegramNotificationService.name);

  async send(chatId: string | null, payload: TelegramNotificationPayload): Promise<void> {
    if (!chatId) return;
    await this.sendText(chatId, formatMessage(payload));
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      this.logger.warn('TELEGRAM_BOT_TOKEN is not configured; skipping Telegram notification delivery');
      return;
    }

    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text })
      });
      if (!response.ok) this.logger.warn(`Telegram sendMessage failed with status ${response.status}`);
    } catch (error) {
      this.logger.warn(`Telegram sendMessage failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
}

const formatMessage = ({ product, price, oldPrice }: TelegramNotificationPayload): string => {
  const priceLine = price ? `Нова ціна: ${price} грн${oldPrice ? ` (було ${oldPrice} грн)` : ''}` : '';
  return [`Зміна ціни: ${product.name}`, priceLine].filter(Boolean).join('\n');
};
