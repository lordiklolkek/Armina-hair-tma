CREATE TABLE contact_challenges (
 telegram_id INTEGER PRIMARY KEY REFERENCES users(telegram_id),
 requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 consumed_at INTEGER, CHECK(expires_at>requested_at)
);
-- statement-breakpoint
ALTER TABLE outbox ADD COLUMN reply_markup TEXT CHECK(reply_markup IS NULL OR json_valid(reply_markup));
-- statement-breakpoint
CREATE TABLE integration_status (id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload)), checked_at INTEGER NOT NULL);
