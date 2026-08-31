ALTER TABLE "User" ADD COLUMN "silpoExternalId" TEXT;
CREATE UNIQUE INDEX "User_silpoExternalId_key" ON "User"("silpoExternalId");
