# cartwise-ai-factory.silpo.ua

## Production identity cutover

Configure these server-only environment variables in production: `DATABASE_URL`, `REDIS_URL`, `TOKEN_ENCRYPTION_KEY`, `APP_ORIGIN`, `TELEGRAM_BOT_TOKEN`, `SESSION_COOKIE_INSECURE`, and `TRUST_PROXY`. Do not expose any of them as `VITE_*` variables or commit their values.

Before applying the Telegram identity migration, an operator must confirm that the target database is fresh or that every legacy unowned `SilpoConnection` credential has an approved retirement procedure. The migration must remain unapplied while unowned rows exist without that approval; it neither deletes nor remotely revokes legacy credentials.
