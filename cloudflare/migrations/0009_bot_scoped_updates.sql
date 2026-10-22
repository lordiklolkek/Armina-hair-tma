-- Keep legacy receipts untouched; new bot installations opt into their own scope.
CREATE TABLE telegram_bot_updates (
 bot_id TEXT NOT NULL,
 update_id INTEGER NOT NULL CHECK(update_id>=0),
 processed_at INTEGER NOT NULL DEFAULT(unixepoch()),
 PRIMARY KEY(bot_id,update_id)
);
-- statement-breakpoint
CREATE INDEX telegram_bot_updates_processed ON telegram_bot_updates(processed_at);
