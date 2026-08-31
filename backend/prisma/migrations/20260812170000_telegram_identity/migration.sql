DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "SilpoConnection") THEN
    RAISE EXCEPTION
      'Legacy unowned SilpoConnection rows require an operator-approved cutover before Telegram identity migration';
  END IF;
END $$;

CREATE TABLE "User" (
    "id" TEXT NOT NULL DEFAULT uuidv7(),
    "telegramUserId" TEXT,
    "telegramUsername" TEXT,
    "telegramFirstName" TEXT,
    "telegramLastName" TEXT,
    "telegramLanguageCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "OAuthClient" ALTER COLUMN "id" SET DEFAULT uuidv7();
ALTER TABLE "OAuthClient" ADD COLUMN "redirectUri" TEXT NOT NULL;

ALTER TABLE "OAuthState" ALTER COLUMN "id" SET DEFAULT uuidv7();
ALTER TABLE "OAuthState" ADD COLUMN "ownerUserId" TEXT;
ALTER TABLE "OAuthState" ADD COLUMN "initiatingSessionHash" TEXT;
ALTER TABLE "OAuthState" ADD COLUMN "telegramUserId" TEXT;
ALTER TABLE "OAuthState" ADD COLUMN "telegramUsername" TEXT;
ALTER TABLE "OAuthState" ADD COLUMN "telegramFirstName" TEXT;
ALTER TABLE "OAuthState" ADD COLUMN "telegramLastName" TEXT;
ALTER TABLE "OAuthState" ADD COLUMN "telegramLanguageCode" TEXT;

ALTER TABLE "SilpoConnection" ALTER COLUMN "id" SET DEFAULT uuidv7();
ALTER TABLE "SilpoConnection" ADD COLUMN "userId" TEXT NOT NULL;

ALTER TABLE "McpProbe" ALTER COLUMN "id" SET DEFAULT uuidv7();

CREATE UNIQUE INDEX "User_telegramUserId_key" ON "User"("telegramUserId");
CREATE UNIQUE INDEX "OAuthClient_redirectUri_key" ON "OAuthClient"("redirectUri");
CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");
CREATE UNIQUE INDEX "SilpoConnection_userId_key" ON "SilpoConnection"("userId");
CREATE INDEX "SilpoConnection_status_accessTokenExpiresAt_idx" ON "SilpoConnection"(status, "accessTokenExpiresAt");

ALTER TABLE "OAuthState" ADD CONSTRAINT "OAuthState_ownerUserId_fkey"
FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SilpoConnection" ADD CONSTRAINT "SilpoConnection_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OAuthState" ADD CONSTRAINT "OAuthState_exact_owner"
CHECK (
  ("ownerUserId" IS NULL AND "initiatingSessionHash" IS NULL AND "telegramUserId" IS NOT NULL)
  OR
  ("ownerUserId" IS NOT NULL AND "initiatingSessionHash" IS NOT NULL AND "telegramUserId" IS NULL)
);
