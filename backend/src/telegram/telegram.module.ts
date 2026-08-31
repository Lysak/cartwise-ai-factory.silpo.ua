import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TrackingModule } from '../tracking/tracking.module';
import { TelegramLinkController } from './telegram-link.controller';
import { TelegramLinkService } from './telegram-link.service';
import { TelegramWebhookController } from './telegram-webhook.controller';

@Module({
  imports: [AuthModule, TrackingModule],
  controllers: [TelegramLinkController, TelegramWebhookController],
  providers: [TelegramLinkService]
})
export class TelegramModule implements OnModuleInit {
  private readonly logger = new Logger(TelegramModule.name);

  // Best-effort webhook self-registration: never blocks app boot, matching
  // TelegramNotificationService's fail-closed pattern for the same Bot API.
  onModuleInit(): void {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const origin = process.env.APP_ORIGIN;
    if (!token || !secret || !origin) return;

    const url = `${origin.replace(/\/$/, '')}/api/telegram/webhook`;
    fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, secret_token: secret })
    })
      .then((response) => {
        if (!response.ok) this.logger.warn(`Telegram setWebhook failed with status ${response.status}`);
      })
      .catch((error: unknown) => {
        this.logger.warn(`Telegram setWebhook failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      });
  }
}
