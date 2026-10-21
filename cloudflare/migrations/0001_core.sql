PRAGMA foreign_keys = ON;
-- statement-breakpoint
CREATE TABLE settings (
 id INTEGER PRIMARY KEY CHECK(id=1), name TEXT NOT NULL DEFAULT '37 Barbershop',
 address TEXT NOT NULL DEFAULT 'Շահումյան 33, Կապան, Հայաստան', logo_url TEXT,
 advance_days INTEGER NOT NULL DEFAULT 30 CHECK(advance_days BETWEEN 1 AND 90),
 notice_minutes INTEGER NOT NULL DEFAULT 60 CHECK(notice_minutes BETWEEN 0 AND 1440)
);
-- statement-breakpoint
INSERT INTO settings(id) VALUES(1);
-- statement-breakpoint
CREATE TABLE users (
 telegram_id INTEGER PRIMARY KEY CHECK(telegram_id>0), language TEXT NOT NULL DEFAULT 'hy' CHECK(language IN ('hy','ru')),
 phone TEXT, phone_verified_at INTEGER, blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN(0,1))
);
-- statement-breakpoint
CREATE TABLE barbers (
 id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100), description TEXT NOT NULL DEFAULT '', photo_url TEXT,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), online_enabled INTEGER NOT NULL DEFAULT 0 CHECK(online_enabled IN(0,1)),
 archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1)), telegram_id INTEGER UNIQUE REFERENCES users(telegram_id), version INTEGER NOT NULL DEFAULT 1
);
-- statement-breakpoint
CREATE TABLE services (
 id TEXT PRIMARY KEY, title_hy TEXT NOT NULL, title_ru TEXT NOT NULL, description_hy TEXT NOT NULL DEFAULT '', description_ru TEXT NOT NULL DEFAULT '',
 price_min INTEGER NOT NULL CHECK(price_min>=0), price_max INTEGER NOT NULL CHECK(price_max>=price_min),
 duration INTEGER NOT NULL CHECK(duration BETWEEN 5 AND 480 AND duration%5=0), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), sort_order INTEGER NOT NULL DEFAULT 0
);
-- statement-breakpoint
CREATE TABLE barber_services (
 barber_id TEXT NOT NULL REFERENCES barbers(id), service_id TEXT NOT NULL REFERENCES services(id),
 duration INTEGER CHECK(duration BETWEEN 5 AND 480 AND duration%5=0), PRIMARY KEY(barber_id,service_id)
);
-- statement-breakpoint
CREATE TABLE working_hours (
 id TEXT PRIMARY KEY, barber_id TEXT NOT NULL REFERENCES barbers(id), weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6),
 start_minute INTEGER NOT NULL CHECK(start_minute BETWEEN 0 AND 1435 AND start_minute%5=0),
 end_minute INTEGER NOT NULL CHECK(end_minute BETWEEN 5 AND 1440 AND end_minute%5=0),
 CHECK(end_minute>start_minute), UNIQUE(barber_id,weekday,start_minute)
);
-- statement-breakpoint
CREATE TABLE absences (
 id TEXT PRIMARY KEY, barber_id TEXT NOT NULL REFERENCES barbers(id), starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL CHECK(ends_at>starts_at),
 kind TEXT NOT NULL CHECK(kind IN('vacation','unavailable','break'))
);
-- statement-breakpoint
CREATE TABLE clients (
 id TEXT PRIMARY KEY, telegram_id INTEGER UNIQUE REFERENCES users(telegram_id), name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100), phone TEXT
);
-- statement-breakpoint
CREATE TABLE bookings (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id), barber_id TEXT NOT NULL REFERENCES barbers(id), service_id TEXT NOT NULL REFERENCES services(id),
 title_hy TEXT NOT NULL, title_ru TEXT NOT NULL, price_min INTEGER NOT NULL CHECK(price_min>=0), price_max INTEGER NOT NULL CHECK(price_max>=price_min), final_price INTEGER CHECK(final_price>=0),
 starts_at INTEGER NOT NULL CHECK(starts_at%300=0), ends_at INTEGER NOT NULL CHECK(ends_at>starts_at AND ends_at%300=0 AND ends_at-starts_at<=28800),
 status TEXT NOT NULL CHECK(status IN('confirmed','pending','cancelled','completed','no_show')), source TEXT NOT NULL CHECK(source IN('online','manual')),
 created_by INTEGER NOT NULL REFERENCES users(telegram_id), idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT(unixepoch()), UNIQUE(created_by,idempotency_key)
);
-- statement-breakpoint
CREATE INDEX booking_barber_interval ON bookings(barber_id,starts_at,ends_at) WHERE status IN('confirmed','pending');
-- statement-breakpoint
CREATE INDEX booking_client_future ON bookings(client_id,status,starts_at);
-- statement-breakpoint
CREATE INDEX hours_barber_day ON working_hours(barber_id,weekday);
-- statement-breakpoint
CREATE INDEX absence_barber_interval ON absences(barber_id,starts_at,ends_at);
-- statement-breakpoint
CREATE TABLE notes (
 barber_id TEXT NOT NULL REFERENCES barbers(id), client_id TEXT NOT NULL REFERENCES clients(id), text TEXT NOT NULL CHECK(length(text)<=2000), PRIMARY KEY(barber_id,client_id)
);
-- statement-breakpoint
CREATE TABLE invitations (
 token_hash TEXT PRIMARY KEY, barber_id TEXT NOT NULL REFERENCES barbers(id), expires_at INTEGER NOT NULL,
 used_by INTEGER REFERENCES users(telegram_id), created_by INTEGER NOT NULL REFERENCES users(telegram_id)
);
-- statement-breakpoint
CREATE TABLE outbox (
 id TEXT PRIMARY KEY, booking_id TEXT REFERENCES bookings(id), chat_id INTEGER NOT NULL, text TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','sending','sent','failed')), attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT(unixepoch()), lease_until INTEGER, lease_token TEXT, last_error TEXT
);
-- statement-breakpoint
CREATE INDEX outbox_due ON outbox(state,next_attempt_at);
-- statement-breakpoint
CREATE TABLE telegram_updates(update_id INTEGER PRIMARY KEY, processed_at INTEGER NOT NULL DEFAULT(unixepoch()));
-- statement-breakpoint
CREATE TABLE rate_limits(key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
-- statement-breakpoint
CREATE TABLE audit_log(id TEXT PRIMARY KEY, actor INTEGER NOT NULL, action TEXT NOT NULL, entity_id TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT(unixepoch()));
-- statement-breakpoint
CREATE TRIGGER booking_insert_guard BEFORE INSERT ON bookings WHEN NEW.status IN('confirmed','pending') BEGIN
 SELECT RAISE(ABORT,'BARBER_UNAVAILABLE') WHERE NOT EXISTS (
  SELECT 1 FROM barbers b JOIN barber_services bs ON bs.barber_id=b.id JOIN services s ON s.id=bs.service_id
  WHERE b.id=NEW.barber_id AND s.id=NEW.service_id AND b.active=1 AND b.archived=0 AND s.active=1 AND (NEW.source='manual' OR b.online_enabled=1));
 SELECT RAISE(ABORT,'OUTSIDE_SCHEDULE') WHERE NOT EXISTS (
  SELECT 1 FROM working_hours w WHERE w.barber_id=NEW.barber_id AND w.weekday=(CAST(strftime('%w',NEW.starts_at,'unixepoch','+4 hours') AS INTEGER)+6)%7
  AND NEW.starts_at>=unixepoch(date(NEW.starts_at,'unixepoch','+4 hours')||'T00:00:00+04:00')+w.start_minute*60
  AND NEW.ends_at<=unixepoch(date(NEW.starts_at,'unixepoch','+4 hours')||'T00:00:00+04:00')+w.end_minute*60);
 SELECT RAISE(ABORT,'ABSENCE_CONFLICT') WHERE EXISTS (
  SELECT 1 FROM absences a WHERE a.barber_id=NEW.barber_id AND a.starts_at<NEW.ends_at AND a.ends_at>NEW.starts_at);
 SELECT RAISE(ABORT,'BOOKING_CONFLICT') WHERE EXISTS (
  SELECT 1 FROM bookings b WHERE b.status IN('confirmed','pending') AND (b.barber_id=NEW.barber_id OR b.client_id=NEW.client_id) AND b.starts_at<NEW.ends_at AND b.ends_at>NEW.starts_at);
 SELECT RAISE(ABORT,'CLIENT_BLOCKED') WHERE NEW.source='online' AND EXISTS (
  SELECT 1 FROM clients c JOIN users u ON u.telegram_id=c.telegram_id WHERE c.id=NEW.client_id AND u.blocked=1);
 SELECT RAISE(ABORT,'BOOKING_LIMIT') WHERE NEW.source='online' AND
  (SELECT count(*) FROM bookings b WHERE b.client_id=NEW.client_id AND b.source='online' AND b.status IN('confirmed','pending') AND b.ends_at>unixepoch()) >=
  CASE WHEN EXISTS(SELECT 1 FROM bookings b WHERE b.client_id=NEW.client_id AND b.status='completed') THEN 2 ELSE 1 END;
END;
-- statement-breakpoint
CREATE TRIGGER booking_update_guard BEFORE UPDATE OF starts_at,ends_at,status,barber_id ON bookings WHEN NEW.status IN('confirmed','pending') BEGIN
 SELECT RAISE(ABORT,'BARBER_UNAVAILABLE') WHERE (NEW.starts_at!=OLD.starts_at OR NEW.ends_at!=OLD.ends_at OR NEW.barber_id!=OLD.barber_id)
 AND NOT EXISTS(SELECT 1 FROM barbers WHERE id=NEW.barber_id AND active=1 AND archived=0);
 SELECT RAISE(ABORT,'BOOKING_CONFLICT') WHERE EXISTS (
  SELECT 1 FROM bookings b WHERE b.id!=NEW.id AND b.status IN('confirmed','pending') AND (b.barber_id=NEW.barber_id OR b.client_id=NEW.client_id) AND b.starts_at<NEW.ends_at AND b.ends_at>NEW.starts_at);
 SELECT RAISE(ABORT,'OUTSIDE_SCHEDULE') WHERE (NEW.starts_at!=OLD.starts_at OR NEW.ends_at!=OLD.ends_at OR NEW.barber_id!=OLD.barber_id) AND NOT EXISTS (
  SELECT 1 FROM working_hours w WHERE w.barber_id=NEW.barber_id AND w.weekday=(CAST(strftime('%w',NEW.starts_at,'unixepoch','+4 hours') AS INTEGER)+6)%7
  AND NEW.starts_at>=unixepoch(date(NEW.starts_at,'unixepoch','+4 hours')||'T00:00:00+04:00')+w.start_minute*60
  AND NEW.ends_at<=unixepoch(date(NEW.starts_at,'unixepoch','+4 hours')||'T00:00:00+04:00')+w.end_minute*60);
 SELECT RAISE(ABORT,'ABSENCE_CONFLICT') WHERE EXISTS (
  SELECT 1 FROM absences a WHERE a.barber_id=NEW.barber_id AND a.starts_at<NEW.ends_at AND a.ends_at>NEW.starts_at);
END;
-- statement-breakpoint
CREATE TRIGGER absence_insert_guard BEFORE INSERT ON absences BEGIN
 SELECT RAISE(ABORT,'SCHEDULE_CONFLICT') WHERE EXISTS (
  SELECT 1 FROM bookings b WHERE b.barber_id=NEW.barber_id AND b.status IN('confirmed','pending') AND b.starts_at<NEW.ends_at AND b.ends_at>NEW.starts_at);
END;
