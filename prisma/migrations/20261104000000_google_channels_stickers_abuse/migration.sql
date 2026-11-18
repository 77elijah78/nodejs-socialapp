ALTER TYPE "MessageType" ADD VALUE 'STICKER';
CREATE TYPE "ConversationKind" AS ENUM ('DIRECT', 'GROUP', 'CHANNEL');
CREATE TYPE "ConversationRole" AS ENUM ('MEMBER', 'ADMIN');
CREATE TYPE "IdentityProvider" AS ENUM ('GOOGLE');

ALTER TABLE "conversations"
  ADD COLUMN "kind" "ConversationKind" NOT NULL DEFAULT 'DIRECT',
  ADD COLUMN "description" TEXT,
  ADD COLUMN "owner_id" TEXT,
  ADD COLUMN "is_public" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "slug" TEXT,
  ADD COLUMN "invite_token_hash" TEXT;
UPDATE "conversations" SET "kind" = CASE WHEN "is_group" THEN 'GROUP'::"ConversationKind" ELSE 'DIRECT'::"ConversationKind" END;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_kind_is_group_check"
  CHECK (("kind" = 'DIRECT' AND "is_group" = false) OR ("kind" IN ('GROUP', 'CHANNEL') AND "is_group" = true));
ALTER TABLE "conversation_participants" ADD COLUMN "role" "ConversationRole" NOT NULL DEFAULT 'MEMBER';
WITH first_members AS (
  SELECT DISTINCT ON (cp."conversation_id") cp."conversation_id", cp."user_id"
  FROM "conversation_participants" cp
  JOIN "conversations" c ON c."id" = cp."conversation_id"
  WHERE c."kind" = 'GROUP' AND cp."deleted_at" IS NULL
  ORDER BY cp."conversation_id", cp."joined_at", cp."user_id"
)
UPDATE "conversation_participants" cp SET "role" = 'ADMIN'
FROM first_members fm WHERE cp."conversation_id" = fm."conversation_id" AND cp."user_id" = fm."user_id";
WITH first_members AS (
  SELECT DISTINCT ON (cp."conversation_id") cp."conversation_id", cp."user_id"
  FROM "conversation_participants" cp
  JOIN "conversations" c ON c."id" = cp."conversation_id"
  WHERE c."kind" = 'GROUP' AND cp."deleted_at" IS NULL
  ORDER BY cp."conversation_id", cp."joined_at", cp."user_id"
)
UPDATE "conversations" c SET "owner_id" = fm."user_id"
FROM first_members fm WHERE c."id" = fm."conversation_id";
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_id_fkey"
  FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "conversations_slug_key" ON "conversations"("slug");
CREATE UNIQUE INDEX "conversations_invite_token_hash_key" ON "conversations"("invite_token_hash");
CREATE INDEX "conversations_kind_is_public_created_at_id_idx" ON "conversations"("kind", "is_public", "created_at", "id");
CREATE INDEX "conversations_owner_id_idx" ON "conversations"("owner_id");

CREATE TABLE "google_identities" (
  "id" TEXT NOT NULL,
  "provider" "IdentityProvider" NOT NULL DEFAULT 'GOOGLE',
  "provider_subject" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "email" TEXT,
  "email_verified_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "google_identities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "google_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "google_identities_provider_subject_key" ON "google_identities"("provider", "provider_subject");
CREATE UNIQUE INDEX "google_identities_provider_user_key" ON "google_identities"("provider", "user_id");
CREATE INDEX "google_identities_user_id_idx" ON "google_identities"("user_id");

CREATE TABLE "sticker_packs" (
  "id" TEXT NOT NULL,
  "owner_id" TEXT,
  "short_name" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "is_public" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "sticker_packs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sticker_packs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "sticker_packs_owner_short_name_key" ON "sticker_packs"("owner_id", "short_name");
CREATE INDEX "sticker_packs_public_cursor_idx" ON "sticker_packs"("is_public", "created_at", "id");
CREATE INDEX "sticker_packs_owner_cursor_idx" ON "sticker_packs"("owner_id", "created_at", "id");

CREATE TABLE "stickers" (
  "id" TEXT NOT NULL,
  "pack_id" TEXT NOT NULL,
  "media_asset_id" TEXT NOT NULL,
  "emoji" TEXT,
  "position" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stickers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stickers_pack_id_fkey" FOREIGN KEY ("pack_id") REFERENCES "sticker_packs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "stickers_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "stickers_media_asset_id_key" ON "stickers"("media_asset_id");
CREATE UNIQUE INDEX "stickers_pack_position_key" ON "stickers"("pack_id", "position");
CREATE INDEX "stickers_pack_id_created_at_id_idx" ON "stickers"("pack_id", "created_at", "id");

CREATE TABLE "sticker_pack_installs" (
  "user_id" TEXT NOT NULL,
  "pack_id" TEXT NOT NULL,
  "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sticker_pack_installs_pkey" PRIMARY KEY ("user_id", "pack_id"),
  CONSTRAINT "sticker_pack_installs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sticker_pack_installs_pack_id_fkey" FOREIGN KEY ("pack_id") REFERENCES "sticker_packs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "sticker_pack_installs_user_id_installed_at_pack_id_idx" ON "sticker_pack_installs"("user_id", "installed_at", "pack_id");

CREATE TABLE "sticker_favorites" (
  "user_id" TEXT NOT NULL,
  "sticker_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sticker_favorites_pkey" PRIMARY KEY ("user_id", "sticker_id"),
  CONSTRAINT "sticker_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sticker_favorites_sticker_id_fkey" FOREIGN KEY ("sticker_id") REFERENCES "stickers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "sticker_favorites_user_id_created_at_sticker_id_idx" ON "sticker_favorites"("user_id", "created_at", "sticker_id");

CREATE TABLE "sticker_recents" (
  "user_id" TEXT NOT NULL,
  "sticker_id" TEXT NOT NULL,
  "used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sticker_recents_pkey" PRIMARY KEY ("user_id", "sticker_id"),
  CONSTRAINT "sticker_recents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sticker_recents_sticker_id_fkey" FOREIGN KEY ("sticker_id") REFERENCES "stickers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "sticker_recents_user_id_used_at_sticker_id_idx" ON "sticker_recents"("user_id", "used_at", "sticker_id");

ALTER TABLE "messages" ADD COLUMN "sticker_id" TEXT;
ALTER TABLE "messages" ADD CONSTRAINT "messages_sticker_id_fkey"
  FOREIGN KEY ("sticker_id") REFERENCES "stickers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "messages_sticker_id_idx" ON "messages"("sticker_id");
