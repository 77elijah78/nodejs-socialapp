ALTER TABLE "messages" ADD COLUMN "file_name" TEXT, ADD COLUMN "file_mime_type" TEXT,
 ADD COLUMN "file_size" INTEGER, ADD COLUMN "shared_reference" JSONB;
CREATE TABLE "message_deletions" (
 "message_id" TEXT NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
 "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
 "deleted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("message_id", "user_id")
);
CREATE INDEX "message_deletions_user_id_deleted_at_idx" ON "message_deletions"("user_id", "deleted_at");
CREATE INDEX "messages_conversation_id_created_at_id_idx" ON "messages"("conversation_id", "created_at", "id");
