ALTER TABLE "OAuthState" DROP CONSTRAINT "OAuthState_exact_owner";

ALTER TABLE "OAuthState" ADD CONSTRAINT "OAuthState_exact_owner"
CHECK (
  ("purpose" = 'telegram_first'
    AND "telegramUserId" IS NOT NULL
    AND "ownerUserId" IS NULL
    AND "initiatingSessionHash" IS NULL
    AND "browserBindingHash" IS NULL)
  OR
  ("purpose" = 'reauthorize'
    AND "telegramUserId" IS NULL
    AND "ownerUserId" IS NOT NULL
    AND "initiatingSessionHash" IS NOT NULL
    AND "browserBindingHash" IS NULL)
  OR
  ("purpose" = 'discovery'
    AND "telegramUserId" IS NULL
    AND "ownerUserId" IS NULL
    AND "initiatingSessionHash" IS NULL
    AND "browserBindingHash" IS NOT NULL)
  OR
  ("purpose" = 'identity_probe'
    AND "telegramUserId" IS NULL
    AND "ownerUserId" IS NULL
    AND "initiatingSessionHash" IS NULL
    AND "browserBindingHash" IS NOT NULL)
);
