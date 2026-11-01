-- Additive: retain existing IDs, read state, dedupe keys and timestamps.
-- Historical read times are unknown and intentionally remain NULL.
ALTER TABLE "notifications"
  ADD COLUMN "read_at" TIMESTAMP(3),
  ADD COLUMN "dismissed_at" TIMESTAMP(3),
  ADD COLUMN "withdrawn_at" TIMESTAMP(3),
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "metadata" JSONB;
CREATE INDEX "notifications_active_page_idx"
  ON "notifications"("user_id", "dismissed_at", "withdrawn_at", "created_at", "id");

-- Attach retry keys to the latest identifiable legacy activity without deleting
-- historical duplicates or inventing missing comment references.
WITH candidates AS (
  SELECT id,
    CASE
      WHEN type='FOLLOW' THEN 'follow:' || actor_id || ':' || user_id
      WHEN type='LIKE' AND COALESCE(post_id,resource_id) IS NOT NULL
        THEN 'like:' || COALESCE(post_id,resource_id) || ':' || actor_id
      WHEN type='SHARE' AND COALESCE(post_id,resource_id) IS NOT NULL
        THEN 'share:' || COALESCE(post_id,resource_id) || ':' || actor_id
      WHEN type='COMMENT' AND comment_id IS NOT NULL
        THEN 'comment:' || comment_id || ':' || user_id
    END AS retry_key, created_at
  FROM notifications WHERE dedupe_key IS NULL AND actor_id IS NOT NULL AND actor_id <> user_id
), ranked AS (
  SELECT id, retry_key, row_number() OVER (PARTITION BY retry_key ORDER BY created_at DESC,id DESC) AS position
  FROM candidates WHERE retry_key IS NOT NULL
)
UPDATE notifications n SET dedupe_key=r.retry_key FROM ranked r
WHERE n.id=r.id AND r.position=1
  AND NOT EXISTS (SELECT 1 FROM notifications existing WHERE existing.dedupe_key=r.retry_key);
