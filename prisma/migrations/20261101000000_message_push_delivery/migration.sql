ALTER TABLE "users" ADD COLUMN "message_push_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "push_previews_enabled" BOOLEAN NOT NULL DEFAULT false;
CREATE TYPE "PushDeliveryStatus" AS ENUM ('QUEUED','SENDING','RECEIPT_PENDING','RECEIPT_OK','FAILED','CANCELLED','UNKNOWN');
CREATE TABLE "push_devices" (
 "id" TEXT PRIMARY KEY,
 "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "device_id" TEXT NOT NULL UNIQUE, "token" TEXT UNIQUE,
 "token_version" INTEGER NOT NULL DEFAULT 1, "platform" TEXT NOT NULL DEFAULT 'android',
 "enabled" BOOLEAN NOT NULL DEFAULT true, "invalidated_at" TIMESTAMP(3),
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "push_devices_user_id_enabled_idx" ON "push_devices"("user_id","enabled");
CREATE TABLE "push_deliveries" (
 "id" TEXT PRIMARY KEY,
 "message_id" TEXT NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "device_id" TEXT NOT NULL REFERENCES "push_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "token_version" INTEGER NOT NULL, "status" "PushDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
 "ticket_id" TEXT, "error_code" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0,
 "receipt_attempts" INTEGER NOT NULL DEFAULT 0,
 "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "lease_until" TIMESTAMP(3), "claim_token" TEXT,
 "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "push_deliveries_message_id_device_id_key" UNIQUE ("message_id","device_id")
);
CREATE INDEX "push_deliveries_status_available_at_lease_until_idx" ON "push_deliveries"("status","available_at","lease_until");
CREATE INDEX "push_deliveries_status_updated_at_idx" ON "push_deliveries"("status","updated_at");
