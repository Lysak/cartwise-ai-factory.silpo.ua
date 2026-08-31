CREATE TABLE "ProductAnalysis" (
  "id" TEXT NOT NULL DEFAULT uuidv7(),
  "slug" TEXT NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "algorithmVersion" TEXT NOT NULL,
  "score" INTEGER,
  "confidence" TEXT,
  "factors" JSONB NOT NULL,
  "components" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProductAnalysis_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProductAnalysis_slug_sourceHash_algorithmVersion_key" ON "ProductAnalysis"("slug", "sourceHash", "algorithmVersion");
