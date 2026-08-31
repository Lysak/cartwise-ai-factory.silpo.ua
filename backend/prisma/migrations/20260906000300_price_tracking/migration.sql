CREATE TABLE "PriceTracker" (
  "id" TEXT NOT NULL DEFAULT uuidv7(),
  "silpoExternalProductId" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "silpoBranchId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "currentPrice" NUMERIC(12,2),
  "lastCheckedAt" TIMESTAMP(3),
  "nextCheckAt" TIMESTAMP(3),
  "lastSuccessAt" TIMESTAMP(3),
  "failedAttempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PriceTracker_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PriceTracker_status_check" CHECK ("status" IN ('active', 'disabled'))
);
CREATE UNIQUE INDEX "PriceTracker_silpoExternalProductId_silpoBranchId_key"
  ON "PriceTracker"("silpoExternalProductId", "silpoBranchId");
CREATE INDEX "PriceTracker_status_nextCheckAt_idx"
  ON "PriceTracker"("status", "nextCheckAt");

CREATE TABLE "PriceSubscription" (
  "id" TEXT NOT NULL DEFAULT uuidv7(),
  "userId" TEXT NOT NULL,
  "priceTrackerId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PriceSubscription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PriceSubscription_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PriceSubscription_priceTrackerId_fkey"
    FOREIGN KEY ("priceTrackerId") REFERENCES "PriceTracker"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PriceSubscription_userId_priceTrackerId_key"
  ON "PriceSubscription"("userId", "priceTrackerId");
CREATE INDEX "PriceSubscription_userId_idx" ON "PriceSubscription"("userId");

CREATE TABLE "PriceObservation" (
  "id" TEXT NOT NULL DEFAULT uuidv7(),
  "priceTrackerId" TEXT NOT NULL,
  "price" NUMERIC(12,2) NOT NULL,
  "oldPrice" NUMERIC(12,2),
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PriceObservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PriceObservation_priceTrackerId_fkey"
    FOREIGN KEY ("priceTrackerId") REFERENCES "PriceTracker"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PriceObservation_priceTrackerId_observedAt_idx"
  ON "PriceObservation"("priceTrackerId", "observedAt");

CREATE TABLE "NotificationEvent" (
  "id" TEXT NOT NULL DEFAULT uuidv7(),
  "userId" TEXT NOT NULL,
  "priceTrackerId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "readAt" TIMESTAMP(3),
  CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "NotificationEvent_priceTrackerId_fkey"
    FOREIGN KEY ("priceTrackerId") REFERENCES "PriceTracker"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "NotificationEvent_userId_createdAt_idx" ON "NotificationEvent"("userId", "createdAt");
CREATE INDEX "NotificationEvent_userId_readAt_idx" ON "NotificationEvent"("userId", "readAt");
