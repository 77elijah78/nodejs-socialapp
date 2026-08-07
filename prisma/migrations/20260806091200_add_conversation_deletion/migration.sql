-- Add deleted_at column to conversation_participants for per-user soft-delete
ALTER TABLE "conversation_participants" ADD COLUMN "deleted_at" TIMESTAMP(3);
