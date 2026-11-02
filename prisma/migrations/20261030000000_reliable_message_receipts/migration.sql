CREATE TABLE "message_receipts" (
 "message_id" TEXT NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "read_at" TIMESTAMP(3), "delivered_at" TIMESTAMP(3),
 PRIMARY KEY ("message_id", "user_id")
);
CREATE INDEX "message_receipts_user_id_read_at_idx" ON "message_receipts"("user_id", "read_at");
CREATE TABLE "receipt_outbox" (
 "id" TEXT PRIMARY KEY, "payload" JSONB NOT NULL,
 "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "lease_until" TIMESTAMP(3), "claim_token" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX "receipt_outbox_available_at_lease_until_idx" ON "receipt_outbox"("available_at", "lease_until");
-- DM aggregate has an identifiable reader; legacy timestamps are unknown.
-- Group aggregate cannot identify a reader: never fabricate group personal reads.
INSERT INTO "message_receipts" ("message_id", "user_id", "read_at", "delivered_at")
SELECT m.id, p.user_id,
 CASE WHEN NOT c.is_group AND (m.is_read OR m.status = 'READ') THEN m.updated_at ELSE NULL END,
 CASE WHEN NOT c.is_group AND m.status IN ('DELIVERED','READ') THEN COALESCE(m.delivered_at,m.updated_at) ELSE NULL END
FROM messages m JOIN conversations c ON c.id=m.conversation_id
JOIN conversation_participants p ON p.conversation_id=m.conversation_id
WHERE p.user_id<>m.sender_id AND (c.is_group OR p.user_id=m.receiver_id)
ON CONFLICT (message_id, user_id) DO NOTHING;
