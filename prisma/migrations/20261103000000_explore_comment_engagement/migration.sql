ALTER TABLE users ADD COLUMN is_private BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE comment_likes (
 id TEXT PRIMARY KEY, comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE ON UPDATE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(comment_id,user_id)
);
CREATE INDEX comment_likes_user_created_idx ON comment_likes(user_id,created_at);
CREATE TABLE explore_sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 post_ids TEXT[] NOT NULL, expires_at TIMESTAMP(3) NOT NULL
);
CREATE INDEX explore_sessions_user_expiry_idx ON explore_sessions(user_id,expires_at);
CREATE INDEX explore_sessions_expiry_idx ON explore_sessions(expires_at);
CREATE TABLE explore_seen (
 session_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE ON UPDATE CASCADE,
 seen_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,post_id)
);
CREATE INDEX explore_seen_user_seen_idx ON explore_seen(user_id,seen_at);
CREATE INDEX explore_seen_seen_idx ON explore_seen(seen_at);
CREATE TABLE post_interests (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
 post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE ON UPDATE CASCADE,
 weight INTEGER NOT NULL, updated_at TIMESTAMP(3) NOT NULL, PRIMARY KEY(user_id,post_id)
);
CREATE INDEX post_interests_user_updated_idx ON post_interests(user_id,updated_at);
CREATE INDEX saved_posts_user_cursor_idx ON saved_posts(user_id,created_at DESC,post_id DESC);
CREATE INDEX posts_live_cursor_idx ON posts(created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX posts_author_live_cursor_idx ON posts(author_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX comments_parent_live_idx ON comments(replied_to_id) WHERE deleted_at IS NULL;
CREATE INDEX likes_user_recent_idx ON likes(user_id,created_at DESC,post_id);
CREATE INDEX comments_author_recent_idx ON comments(author_id,created_at DESC,id);
CREATE INDEX users_status_private_idx ON users(account_status,is_private);
