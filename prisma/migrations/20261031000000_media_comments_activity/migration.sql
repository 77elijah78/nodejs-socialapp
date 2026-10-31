CREATE TABLE "media_assets" (
 "id" TEXT PRIMARY KEY, "owner_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "key" TEXT NOT NULL UNIQUE, "url" TEXT NOT NULL UNIQUE, "mime_type" TEXT NOT NULL,
 "source_url" TEXT, "size" INTEGER NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "media_assets_owner_id_created_at_idx" ON "media_assets"("owner_id", "created_at");
ALTER TABLE "comments" ADD COLUMN "client_request_id" TEXT;
CREATE UNIQUE INDEX "comments_author_id_client_request_id_key" ON "comments"("author_id", "client_request_id");
CREATE INDEX "comments_post_id_created_at_id_idx" ON "comments"("post_id", "created_at", "id");
ALTER TABLE "notifications" ADD COLUMN "dedupe_key" TEXT, ADD COLUMN "comment_id" TEXT;
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications"("dedupe_key");

ALTER TABLE "posts" ADD COLUMN "media_metadata" JSONB;

-- Preserve legacy dangling scalar references; enforce referential integrity for new writes.
ALTER TABLE "comments" ADD CONSTRAINT "comments_replied_to_id_fkey" FOREIGN KEY ("replied_to_id") REFERENCES "comments"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "notifications" ADD COLUMN "post_id" TEXT REFERENCES "posts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "notifications_user_id_created_at_id_idx" ON "notifications"("user_id", "created_at", "id");

-- Reference-based media authorization lookups.
CREATE INDEX "users_avatar_url_idx" ON "users"("avatar_url");
CREATE INDEX "media_assets_source_url_idx" ON "media_assets"("source_url");
CREATE INDEX "posts_image_urls_idx" ON "posts" USING GIN ("image_urls");
CREATE INDEX "posts_video_url_idx" ON "posts"("video_url");
CREATE INDEX "messages_media_url_idx" ON "messages"("media_url");
CREATE INDEX "messages_thumbnail_url_idx" ON "messages"("thumbnail_url");
CREATE INDEX "stories_media_url_idx" ON "stories"("media_url");
