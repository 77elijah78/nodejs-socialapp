-- Compatible defaults keep all existing devices on their working alert path.
ALTER TABLE "push_devices" ADD COLUMN "delivery_mode" TEXT NOT NULL DEFAULT 'expo-alert';
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_delivery_mode_check"
  CHECK ("delivery_mode" IN ('expo-alert', 'android-data-v2'));
-- Deliberately no message/conversation FK: never forget a committed action on deletion.
CREATE TABLE "notification_reply_actions" (
  "user_id" TEXT NOT NULL,
  "action_id" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "message_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_reply_actions_pkey" PRIMARY KEY ("user_id", "action_id"),
  CONSTRAINT "notification_reply_actions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
