CREATE TABLE mutation_guards(id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1));
-- statement-breakpoint
CREATE TRIGGER booking_notify_insert AFTER INSERT ON bookings BEGIN
 INSERT INTO outbox(id,booking_id,chat_id,text)
 SELECT NEW.id||':1:client',NEW.id,u.telegram_id,
 CASE u.language WHEN 'ru' THEN 'ДЕМО · Запись создана: '||NEW.title_ru ELSE 'ԴԵՄՈ · Ամրագրումը ստեղծված է՝ '||NEW.title_hy END
 ||' · '||strftime('%d.%m.%Y %H:%M',NEW.starts_at,'unixepoch','+4 hours')||' · '||NEW.price_min||'–'||NEW.price_max||' AMD'
 FROM clients c JOIN users u ON u.telegram_id=c.telegram_id WHERE c.id=NEW.client_id;
 INSERT INTO outbox(id,booking_id,chat_id,text)
 SELECT NEW.id||':1:barber',NEW.id,b.telegram_id,'DEMO · #'||NEW.id||' · '||strftime('%d.%m.%Y %H:%M',NEW.starts_at,'unixepoch','+4 hours')
 FROM barbers b WHERE b.id=NEW.barber_id AND b.telegram_id IS NOT NULL;
END;
-- statement-breakpoint
CREATE TRIGGER booking_notify_update AFTER UPDATE OF version ON bookings WHEN NEW.version!=OLD.version BEGIN
 UPDATE outbox SET state='failed',last_error='SUPERSEDED' WHERE booking_id=NEW.id AND state='pending' AND id LIKE '%:reminder:%';
 INSERT INTO outbox(id,booking_id,chat_id,text)
 SELECT NEW.id||':'||NEW.version||':client',NEW.id,u.telegram_id,
 CASE u.language WHEN 'ru' THEN 'ДЕМО · Запись обновлена: '||NEW.title_ru ELSE 'ԴԵՄՈ · Ամրագրումը թարմացված է՝ '||NEW.title_hy END
 ||' · '||strftime('%d.%m.%Y %H:%M',NEW.starts_at,'unixepoch','+4 hours')||' · '||
 CASE u.language WHEN 'ru' THEN CASE NEW.status WHEN 'cancelled' THEN 'Отменена' WHEN 'completed' THEN 'Завершена' WHEN 'no_show' THEN 'Неявка' WHEN 'pending' THEN 'Ожидает' ELSE 'Подтверждена' END
 ELSE CASE NEW.status WHEN 'cancelled' THEN 'Չեղարկված' WHEN 'completed' THEN 'Ավարտված' WHEN 'no_show' THEN 'Չի ներկայացել' WHEN 'pending' THEN 'Սպասման մեջ' ELSE 'Հաստատված' END END
 FROM clients c JOIN users u ON u.telegram_id=c.telegram_id WHERE c.id=NEW.client_id;
 INSERT INTO outbox(id,booking_id,chat_id,text)
 SELECT NEW.id||':'||NEW.version||':barber',NEW.id,b.telegram_id,'DEMO · #'||NEW.id||' · '||NEW.status
 FROM barbers b WHERE b.id=NEW.barber_id AND b.telegram_id IS NOT NULL;
END;
