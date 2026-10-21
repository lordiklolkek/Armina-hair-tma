ALTER TABLE outbox ADD COLUMN event_json TEXT CHECK(event_json IS NULL OR json_valid(event_json));
-- statement-breakpoint
CREATE VIEW booking_notification_snapshot AS
 SELECT b.id,json_object('id',b.id,'version',b.version,'title_hy',b.title_hy,'title_ru',b.title_ru,
  'starts_at',b.starts_at,'ends_at',b.ends_at,'price_min',b.price_min,'price_max',b.price_max,'final_price',b.final_price,
  'status',b.status,'barber_name',bm.name,'client_name',c.name) payload
 FROM bookings b JOIN barbers bm ON bm.id=b.barber_id JOIN clients c ON c.id=b.client_id;
-- statement-breakpoint
DROP TRIGGER booking_notify_insert;
-- statement-breakpoint
DROP TRIGGER booking_notify_update;
-- statement-breakpoint
CREATE TRIGGER booking_notify_insert AFTER INSERT ON bookings BEGIN
 -- Keep nonempty fallback text for a previous Worker during a rolling deployment.
 INSERT INTO outbox(id,booking_id,chat_id,text,event_json)
 SELECT NEW.id||':'||NEW.version||':client',NEW.id,u.telegram_id,CASE u.language WHEN 'ru' THEN 'ДЕМО · Запись: '||NEW.title_ru ELSE 'ԴԵՄՈ · Գրանցում՝ '||NEW.title_hy END||' · '||strftime('%d.%m.%Y %H:%M',NEW.starts_at,'unixepoch','+4 hours'),json_set(s.payload,'$.kind','created','$.audience','client')
 FROM clients c JOIN users u ON u.telegram_id=c.telegram_id JOIN booking_notification_snapshot s ON s.id=NEW.id WHERE c.id=NEW.client_id;
 INSERT INTO outbox(id,booking_id,chat_id,text,event_json)
 SELECT NEW.id||':'||NEW.version||':barber',NEW.id,b.telegram_id,'ԴԵՄՈ / ДЕМО · '||NEW.title_hy||' / '||NEW.title_ru||' · '||strftime('%d.%m.%Y %H:%M',NEW.starts_at,'unixepoch','+4 hours'),json_set(s.payload,'$.kind','created','$.audience','barber','$.recipient_barber_id',NEW.barber_id)
 FROM barbers b JOIN booking_notification_snapshot s ON s.id=NEW.id WHERE b.id=NEW.barber_id AND b.telegram_id IS NOT NULL
 AND b.telegram_id IS NOT (SELECT telegram_id FROM clients WHERE id=NEW.client_id);
END;
-- statement-breakpoint
CREATE TRIGGER booking_notify_update AFTER UPDATE OF version ON bookings WHEN NEW.version!=OLD.version BEGIN
 UPDATE outbox SET state='failed',last_error='SUPERSEDED' WHERE booking_id=NEW.id AND state='pending' AND (event_json IS NOT NULL OR id LIKE '%:reminder:%');
 INSERT INTO outbox(id,booking_id,chat_id,text,event_json)
 SELECT NEW.id||':'||NEW.version||':client',NEW.id,u.telegram_id,CASE u.language WHEN 'ru' THEN 'ДЕМО · Изменение записи: '||NEW.title_ru ELSE 'ԴԵՄՈ · Գրանցման փոփոխություն՝ '||NEW.title_hy END||' · '||strftime('%d.%m.%Y %H:%M',NEW.starts_at,'unixepoch','+4 hours')||' · '||CASE NEW.status WHEN 'cancelled' THEN 'Չեղարկված / Отменена' WHEN 'completed' THEN 'Ավարտված / Завершена' WHEN 'no_show' THEN 'Չի ներկայացել / Неявка' ELSE 'Հաստատված / Подтверждена' END,json_set(s.payload,'$.audience','client',
  '$.kind',CASE WHEN NEW.status='cancelled' THEN 'cancelled' WHEN NEW.starts_at!=OLD.starts_at OR NEW.barber_id!=OLD.barber_id THEN 'moved' ELSE 'updated' END,
  '$.previous_starts_at',OLD.starts_at,'$.previous_barber_name',(SELECT name FROM barbers WHERE id=OLD.barber_id))
 FROM clients c JOIN users u ON u.telegram_id=c.telegram_id JOIN booking_notification_snapshot s ON s.id=NEW.id WHERE c.id=NEW.client_id;
 INSERT INTO outbox(id,booking_id,chat_id,text,event_json)
 SELECT NEW.id||':'||NEW.version||':barber',NEW.id,b.telegram_id,'ԴԵՄՈ / ДЕМО · '||NEW.title_hy||' / '||NEW.title_ru||' · '||strftime('%d.%m.%Y %H:%M',NEW.starts_at,'unixepoch','+4 hours')||' · '||CASE NEW.status WHEN 'cancelled' THEN 'Չեղարկված / Отменена' WHEN 'completed' THEN 'Ավարտված / Завершена' WHEN 'no_show' THEN 'Չի ներկայացել / Неявка' ELSE 'Հաստատված / Подтверждена' END,json_set(s.payload,'$.audience','barber','$.recipient_barber_id',NEW.barber_id,
  '$.kind',CASE WHEN NEW.status='cancelled' THEN 'cancelled' WHEN NEW.starts_at!=OLD.starts_at OR NEW.barber_id!=OLD.barber_id THEN 'moved' ELSE 'updated' END,
  '$.previous_starts_at',OLD.starts_at,'$.previous_barber_name',(SELECT name FROM barbers WHERE id=OLD.barber_id))
 FROM barbers b JOIN booking_notification_snapshot s ON s.id=NEW.id WHERE b.id=NEW.barber_id AND b.telegram_id IS NOT NULL
 AND b.telegram_id IS NOT (SELECT telegram_id FROM clients WHERE id=NEW.client_id);
 INSERT INTO outbox(id,booking_id,chat_id,text,event_json)
 SELECT NEW.id||':'||NEW.version||':previous-barber',NEW.id,b.telegram_id,'ԴԵՄՈ / ДЕМО · Այցը փոխանցված է / Визит передан · '||NEW.title_hy||' / '||NEW.title_ru,json_set(s.payload,'$.audience','barber','$.kind','transferred_away','$.recipient_barber_id',OLD.barber_id,
  '$.previous_starts_at',OLD.starts_at,'$.previous_barber_name',b.name)
 FROM barbers b JOIN booking_notification_snapshot s ON s.id=NEW.id WHERE b.id=OLD.barber_id AND OLD.barber_id!=NEW.barber_id AND b.telegram_id IS NOT NULL
 AND b.telegram_id IS NOT (SELECT telegram_id FROM clients WHERE id=NEW.client_id);
END;
