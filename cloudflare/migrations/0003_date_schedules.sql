-- Each date override replaces the weekly hours, including an empty day off.
CREATE TABLE schedule_overrides (
 barber_id TEXT NOT NULL REFERENCES barbers(id), day TEXT NOT NULL,
 hours_json TEXT NOT NULL CHECK(json_valid(hours_json) AND json_type(hours_json)='array' AND json_array_length(hours_json)<=8),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), PRIMARY KEY(barber_id,day),
 CHECK(length(day)=10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(day,'+0 days') IS day)
);
-- statement-breakpoint
CREATE VIEW effective_working_hours AS
 SELECT barber_id,NULL day,weekday,start_minute,end_minute FROM working_hours
 UNION ALL
 SELECT o.barber_id,o.day,NULL,json_extract(j.value,'$.start_minute'),json_extract(j.value,'$.end_minute')
 FROM schedule_overrides o,json_each(o.hours_json) j;
-- statement-breakpoint
CREATE VIEW booking_schedule_violations AS
 SELECT b.id,b.barber_id,date(b.starts_at,'unixepoch','+4 hours') day FROM bookings b
 WHERE b.status IN('confirmed','pending') AND b.ends_at>unixepoch() AND NOT EXISTS (
  SELECT 1 FROM effective_working_hours w WHERE w.barber_id=b.barber_id AND (
   w.day=date(b.starts_at,'unixepoch','+4 hours') OR (w.day IS NULL
   AND w.weekday=(CAST(strftime('%w',b.starts_at,'unixepoch','+4 hours') AS INTEGER)+6)%7
   AND NOT EXISTS(SELECT 1 FROM schedule_overrides o WHERE o.barber_id=b.barber_id AND o.day=date(b.starts_at,'unixepoch','+4 hours'))))
  AND b.starts_at>=unixepoch(date(b.starts_at,'unixepoch','+4 hours')||'T00:00:00+04:00')+w.start_minute*60
  AND b.ends_at<=unixepoch(date(b.starts_at,'unixepoch','+4 hours')||'T00:00:00+04:00')+w.end_minute*60);
-- statement-breakpoint
DROP TRIGGER booking_insert_guard;
-- statement-breakpoint
DROP TRIGGER booking_update_guard;
-- statement-breakpoint
CREATE TRIGGER booking_insert_guard BEFORE INSERT ON bookings WHEN NEW.status IN('confirmed','pending') BEGIN
 SELECT RAISE(ABORT,'BARBER_UNAVAILABLE') WHERE NOT EXISTS (
  SELECT 1 FROM barbers b JOIN barber_services bs ON bs.barber_id=b.id JOIN services s ON s.id=bs.service_id
  WHERE b.id=NEW.barber_id AND s.id=NEW.service_id AND b.active=1 AND b.archived=0 AND s.active=1 AND (NEW.source='manual' OR b.online_enabled=1));
 SELECT RAISE(ABORT,'OUTSIDE_SCHEDULE') WHERE NOT EXISTS (
  SELECT 1 FROM effective_working_hours w WHERE w.barber_id=NEW.barber_id AND (
   w.day=date(NEW.starts_at,'unixepoch','+4 hours') OR (w.day IS NULL
   AND w.weekday=(CAST(strftime('%w',NEW.starts_at,'unixepoch','+4 hours') AS INTEGER)+6)%7
   AND NOT EXISTS(SELECT 1 FROM schedule_overrides o WHERE o.barber_id=NEW.barber_id AND o.day=date(NEW.starts_at,'unixepoch','+4 hours'))))
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
  SELECT 1 FROM effective_working_hours w WHERE w.barber_id=NEW.barber_id AND (
   w.day=date(NEW.starts_at,'unixepoch','+4 hours') OR (w.day IS NULL
   AND w.weekday=(CAST(strftime('%w',NEW.starts_at,'unixepoch','+4 hours') AS INTEGER)+6)%7
   AND NOT EXISTS(SELECT 1 FROM schedule_overrides o WHERE o.barber_id=NEW.barber_id AND o.day=date(NEW.starts_at,'unixepoch','+4 hours'))))
  AND NEW.starts_at>=unixepoch(date(NEW.starts_at,'unixepoch','+4 hours')||'T00:00:00+04:00')+w.start_minute*60
  AND NEW.ends_at<=unixepoch(date(NEW.starts_at,'unixepoch','+4 hours')||'T00:00:00+04:00')+w.end_minute*60);
 SELECT RAISE(ABORT,'ABSENCE_CONFLICT') WHERE EXISTS (
  SELECT 1 FROM absences a WHERE a.barber_id=NEW.barber_id AND a.starts_at<NEW.ends_at AND a.ends_at>NEW.starts_at);
END;

-- statement-breakpoint
CREATE TRIGGER schedule_override_insert_guard AFTER INSERT ON schedule_overrides BEGIN
 SELECT RAISE(ABORT,'INVALID_SCHEDULE') WHERE EXISTS (
  SELECT 1 FROM json_each(NEW.hours_json) j WHERE json_type(j.value)!='object'
  OR json_type(j.value,'$.start_minute') IS NOT 'integer' OR json_type(j.value,'$.end_minute') IS NOT 'integer'
  OR json_extract(j.value,'$.start_minute') NOT BETWEEN 0 AND 1435
  OR json_extract(j.value,'$.end_minute') NOT BETWEEN 5 AND 1440
  OR json_extract(j.value,'$.start_minute')%5!=0 OR json_extract(j.value,'$.end_minute')%5!=0
  OR json_extract(j.value,'$.end_minute')<=json_extract(j.value,'$.start_minute'));
 SELECT RAISE(ABORT,'INVALID_SCHEDULE') WHERE EXISTS (
  SELECT 1 FROM json_each(NEW.hours_json) a,json_each(NEW.hours_json) b WHERE a.key<b.key
  AND json_extract(a.value,'$.start_minute')<json_extract(b.value,'$.end_minute')
  AND json_extract(a.value,'$.end_minute')>json_extract(b.value,'$.start_minute'));
 SELECT RAISE(ABORT,'SCHEDULE_CONFLICT') WHERE EXISTS (
  SELECT 1 FROM booking_schedule_violations WHERE barber_id=NEW.barber_id AND day=NEW.day);
END;

-- statement-breakpoint
CREATE TRIGGER schedule_override_update_guard AFTER UPDATE ON schedule_overrides BEGIN
 SELECT RAISE(ABORT,'INVALID_SCHEDULE') WHERE EXISTS (
  SELECT 1 FROM json_each(NEW.hours_json) j WHERE json_type(j.value)!='object'
  OR json_type(j.value,'$.start_minute') IS NOT 'integer' OR json_type(j.value,'$.end_minute') IS NOT 'integer'
  OR json_extract(j.value,'$.start_minute') NOT BETWEEN 0 AND 1435
  OR json_extract(j.value,'$.end_minute') NOT BETWEEN 5 AND 1440
  OR json_extract(j.value,'$.start_minute')%5!=0 OR json_extract(j.value,'$.end_minute')%5!=0
  OR json_extract(j.value,'$.end_minute')<=json_extract(j.value,'$.start_minute'));
 SELECT RAISE(ABORT,'INVALID_SCHEDULE') WHERE EXISTS (
  SELECT 1 FROM json_each(NEW.hours_json) a,json_each(NEW.hours_json) b WHERE a.key<b.key
  AND json_extract(a.value,'$.start_minute')<json_extract(b.value,'$.end_minute')
  AND json_extract(a.value,'$.end_minute')>json_extract(b.value,'$.start_minute'));
 SELECT RAISE(ABORT,'SCHEDULE_CONFLICT') WHERE EXISTS (
  SELECT 1 FROM booking_schedule_violations WHERE barber_id=NEW.barber_id AND day=NEW.day);
END;
-- statement-breakpoint
CREATE TRIGGER schedule_override_delete_guard AFTER DELETE ON schedule_overrides BEGIN
 SELECT RAISE(ABORT,'SCHEDULE_CONFLICT') WHERE EXISTS (
  SELECT 1 FROM booking_schedule_violations WHERE barber_id=OLD.barber_id AND day=OLD.day);
END;
