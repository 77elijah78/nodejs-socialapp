-- DropIndex
DROP INDEX "story_views_story_id_viewer_id_idx";

-- AlterTable
ALTER TABLE "messages" ALTER COLUMN "updated_at" DROP DEFAULT;
