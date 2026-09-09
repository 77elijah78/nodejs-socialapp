-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'BANNED', 'DELETED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "AdminRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'MODERATOR', 'SUPPORT_AGENT', 'ANALYST');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- AlterTable: users
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "account_status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN IF NOT EXISTS "suspended_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "suspended_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "banned_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "banned_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "last_active_at" TIMESTAMP(3);

-- AlterTable: posts
ALTER TABLE "posts"
  ADD COLUMN IF NOT EXISTS "deleted_by" TEXT;

-- AlterTable: comments
ALTER TABLE "comments"
  ADD COLUMN IF NOT EXISTS "replied_to_id" TEXT,
  ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "deleted_by" TEXT;

-- AlterTable: stories
ALTER TABLE "stories"
  ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "removed_by" TEXT;

-- AlterTable: reports
ALTER TABLE "reports"
  ADD COLUMN IF NOT EXISTS "assigned_admin_id" TEXT,
  ADD COLUMN IF NOT EXISTS "resolution_note" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "admin_accounts" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "user_id" TEXT NOT NULL,
  "role" "AdminRole" NOT NULL DEFAULT 'MODERATOR',
  "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_by_user_id" TEXT,
  "disabled_at" TIMESTAMP(3),
  "last_login_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "admin_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "admin_account_id" TEXT,
  "action" TEXT NOT NULL,
  "target_type" TEXT NOT NULL,
  "target_id" TEXT,
  "reason" TEXT,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "platform_settings" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "key" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "description" TEXT,
  "updated_by_admin_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "report_notes" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "report_id" TEXT NOT NULL,
  "admin_account_id" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "report_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "admin_accounts_user_id_key" ON "admin_accounts"("user_id");
CREATE INDEX IF NOT EXISTS "admin_accounts_role_idx" ON "admin_accounts"("role");
CREATE INDEX IF NOT EXISTS "admin_accounts_is_active_idx" ON "admin_accounts"("is_active");

CREATE INDEX IF NOT EXISTS "audit_logs_admin_account_id_idx" ON "audit_logs"("admin_account_id");
CREATE INDEX IF NOT EXISTS "audit_logs_action_idx" ON "audit_logs"("action");
CREATE INDEX IF NOT EXISTS "audit_logs_target_type_idx" ON "audit_logs"("target_type");
CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs"("created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "platform_settings_key_key" ON "platform_settings"("key");
CREATE INDEX IF NOT EXISTS "platform_settings_category_idx" ON "platform_settings"("category");

CREATE INDEX IF NOT EXISTS "report_notes_report_id_idx" ON "report_notes"("report_id");
CREATE INDEX IF NOT EXISTS "report_notes_created_at_idx" ON "report_notes"("created_at");

CREATE INDEX IF NOT EXISTS "users_account_status_idx" ON "users"("account_status");
CREATE INDEX IF NOT EXISTS "users_created_at_idx" ON "users"("created_at");
CREATE INDEX IF NOT EXISTS "users_last_active_at_idx" ON "users"("last_active_at");

CREATE INDEX IF NOT EXISTS "follows_following_id_idx" ON "follows"("following_id");

CREATE INDEX IF NOT EXISTS "posts_created_at_idx" ON "posts"("created_at");
CREATE INDEX IF NOT EXISTS "posts_deleted_at_idx" ON "posts"("deleted_at");

CREATE INDEX IF NOT EXISTS "likes_post_id_idx" ON "likes"("post_id");
CREATE INDEX IF NOT EXISTS "likes_created_at_idx" ON "likes"("created_at");

CREATE INDEX IF NOT EXISTS "comments_author_id_idx" ON "comments"("author_id");
CREATE INDEX IF NOT EXISTS "comments_created_at_idx" ON "comments"("created_at");
CREATE INDEX IF NOT EXISTS "comments_deleted_at_idx" ON "comments"("deleted_at");

CREATE INDEX IF NOT EXISTS "reports_status_idx" ON "reports"("status");
CREATE INDEX IF NOT EXISTS "reports_created_at_idx" ON "reports"("created_at");
CREATE INDEX IF NOT EXISTS "reports_assigned_admin_id_idx" ON "reports"("assigned_admin_id");

CREATE INDEX IF NOT EXISTS "conversations_updated_at_idx" ON "conversations"("updated_at");

CREATE INDEX IF NOT EXISTS "conversation_participants_user_id_idx" ON "conversation_participants"("user_id");

CREATE INDEX IF NOT EXISTS "messages_receiver_id_idx" ON "messages"("receiver_id");
CREATE INDEX IF NOT EXISTS "messages_status_idx" ON "messages"("status");
CREATE INDEX IF NOT EXISTS "messages_created_at_idx" ON "messages"("created_at");
CREATE INDEX IF NOT EXISTS "messages_type_idx" ON "messages"("type");

CREATE INDEX IF NOT EXISTS "stories_created_at_idx" ON "stories"("created_at");
CREATE INDEX IF NOT EXISTS "stories_expires_at_idx" ON "stories"("expires_at");
CREATE INDEX IF NOT EXISTS "stories_deleted_at_idx" ON "stories"("deleted_at");

CREATE INDEX IF NOT EXISTS "story_views_viewer_id_idx" ON "story_views"("viewer_id");

-- AddForeignKey
ALTER TABLE "admin_accounts"
  ADD CONSTRAINT "admin_accounts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_admin_account_id_fkey"
  FOREIGN KEY ("admin_account_id") REFERENCES "admin_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "platform_settings"
  ADD CONSTRAINT "platform_settings_updated_by_admin_id_fkey"
  FOREIGN KEY ("updated_by_admin_id") REFERENCES "admin_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "report_notes"
  ADD CONSTRAINT "report_notes_report_id_fkey"
  FOREIGN KEY ("report_id") REFERENCES "reports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "report_notes"
  ADD CONSTRAINT "report_notes_admin_account_id_fkey"
  FOREIGN KEY ("admin_account_id") REFERENCES "admin_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reports"
  ADD CONSTRAINT "reports_assigned_admin_id_fkey"
  FOREIGN KEY ("assigned_admin_id") REFERENCES "admin_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed default safe settings
INSERT INTO "platform_settings" ("key", "category", "value", "description")
VALUES
  ('platform_name', 'general', '"Social App"'::jsonb, 'Public platform name used in admin surfaces'),
  ('platform_description', 'general', '"A modern social media platform"'::jsonb, 'Internal description for operational reference'),
  ('registration_enabled', 'general', 'true'::jsonb, 'Allow new user registrations'),
  ('maintenance_mode', 'general', 'false'::jsonb, 'Temporarily disable non-admin user traffic'),
  ('default_account_visibility', 'users', '"public"'::jsonb, 'Default visibility applied by clients that support it'),
  ('max_post_images', 'content', '4'::jsonb, 'Maximum number of images allowed per post'),
  ('allowed_story_media_types', 'content', '["image","video"]'::jsonb, 'Allowed story media types'),
  ('allowed_post_report_reasons', 'moderation', '["spam","harassment","abusive content","impersonation","inappropriate content","copyright","other"]'::jsonb, 'Configured moderation reasons for post reports')
ON CONFLICT ("key") DO NOTHING;
