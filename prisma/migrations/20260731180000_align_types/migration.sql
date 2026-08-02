-- CreateEnum for MessageType
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT');

-- CreateEnum for MessageStatus
CREATE TYPE "MessageStatus" AS ENUM ('SENDING', 'SENT', 'DELIVERED', 'READ');

-- Add video_url column to posts (Instagram-like video posts)
ALTER TABLE "posts" ADD COLUMN "video_url" TEXT;

-- Add replied_to_id column to comments (nested replies)
ALTER TABLE "comments" ADD COLUMN "replied_to_id" TEXT;

-- Add new columns to messages (Telegram-like features)
ALTER TABLE "messages" ADD COLUMN "thumbnail_url" TEXT;
ALTER TABLE "messages" ADD COLUMN "type" "MessageType" NOT NULL DEFAULT 'TEXT';
ALTER TABLE "messages" ADD COLUMN "status" "MessageStatus" NOT NULL DEFAULT 'SENT';
ALTER TABLE "messages" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "messages" ADD COLUMN "edited_at" TIMESTAMP(3);
ALTER TABLE "messages" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "messages" ADD COLUMN "deleted_by" TEXT;
ALTER TABLE "messages" ADD COLUMN "duration" DOUBLE PRECISION;
ALTER TABLE "messages" ADD COLUMN "replied_to_id" TEXT;
ALTER TABLE "messages" ADD COLUMN "forwarded_from_id" TEXT;

-- Indexes for new message columns
CREATE INDEX "messages_replied_to_id_idx" ON "messages"("replied_to_id");
CREATE INDEX "messages_forwarded_from_id_idx" ON "messages"("forwarded_from_id");

-- Foreign key for replies (self-referential)
ALTER TABLE "messages" ADD CONSTRAINT "messages_replied_to_id_fkey"
    FOREIGN KEY ("replied_to_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Foreign key for forwards (self-referential)
ALTER TABLE "messages" ADD CONSTRAINT "messages_forwarded_from_id_fkey"
    FOREIGN KEY ("forwarded_from_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Create saved_posts table (Instagram-like bookmarks)
CREATE TABLE "saved_posts" (
    "user_id" TEXT NOT NULL,
    "post_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_posts_pkey" PRIMARY KEY ("user_id","post_id")
);

-- Foreign keys for saved_posts
ALTER TABLE "saved_posts" ADD CONSTRAINT "saved_posts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "saved_posts" ADD CONSTRAINT "saved_posts_post_id_fkey"
    FOREIGN KEY ("post_id") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Create stories table (Instagram-like stories)
CREATE TABLE "stories" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "media_url" TEXT NOT NULL,
    "media_type" TEXT NOT NULL,
    "caption" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stories_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "stories_user_id_idx" ON "stories"("user_id");

ALTER TABLE "stories" ADD CONSTRAINT "stories_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Create story_views table
CREATE TABLE "story_views" (
    "story_id" TEXT NOT NULL,
    "viewer_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_views_pkey" PRIMARY KEY ("story_id","viewer_id")
);

CREATE INDEX "story_views_story_id_viewer_id_idx" ON "story_views"("story_id","viewer_id");

ALTER TABLE "story_views" ADD CONSTRAINT "story_views_story_id_fkey"
    FOREIGN KEY ("story_id") REFERENCES "stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "story_views" ADD CONSTRAINT "story_views_viewer_id_fkey"
    FOREIGN KEY ("viewer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
