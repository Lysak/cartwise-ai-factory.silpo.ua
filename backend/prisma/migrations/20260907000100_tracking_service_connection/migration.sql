ALTER TABLE "SilpoConnection"
  ADD COLUMN "isTrackingService" BOOLEAN NOT NULL DEFAULT false;

DO $$
DECLARE
  active_count INTEGER;
BEGIN
  SELECT COUNT(*)
    INTO active_count
    FROM "SilpoConnection"
   WHERE status = 'active';

  IF active_count <> 1 THEN
    RAISE EXCEPTION
      'tracking service connection migration requires exactly one active SilpoConnection, found %',
      active_count;
  END IF;

  UPDATE "SilpoConnection"
     SET "isTrackingService" = true
   WHERE status = 'active';
END
$$;

CREATE UNIQUE INDEX "SilpoConnection_single_tracking_service"
  ON "SilpoConnection" ("isTrackingService")
  WHERE "isTrackingService" = true;
