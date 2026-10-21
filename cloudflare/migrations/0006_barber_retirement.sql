ALTER TABLE barbers ADD COLUMN bookings_revision INTEGER NOT NULL DEFAULT 0;
-- statement-breakpoint
CREATE TRIGGER barber_booking_insert_revision AFTER INSERT ON bookings BEGIN
 UPDATE barbers SET bookings_revision=bookings_revision+1 WHERE id=NEW.barber_id;
END;
-- statement-breakpoint
CREATE TRIGGER barber_booking_update_revision AFTER UPDATE OF version ON bookings WHEN NEW.version!=OLD.version BEGIN
 UPDATE barbers SET bookings_revision=bookings_revision+1 WHERE id IN(OLD.barber_id,NEW.barber_id);
END;
-- statement-breakpoint
CREATE TRIGGER barber_booking_delete_revision AFTER DELETE ON bookings BEGIN
 UPDATE barbers SET bookings_revision=bookings_revision+1 WHERE id=OLD.barber_id;
END;
-- statement-breakpoint
CREATE TRIGGER booking_transfer_guard BEFORE UPDATE OF barber_id ON bookings WHEN NEW.barber_id!=OLD.barber_id AND NEW.status IN('confirmed','pending') BEGIN
 SELECT RAISE(ABORT,'BARBER_UNAVAILABLE') WHERE NOT EXISTS(
  SELECT 1 FROM barbers b JOIN barber_services bs ON bs.barber_id=b.id
  WHERE b.id=NEW.barber_id AND b.active=1 AND b.archived=0 AND bs.service_id=NEW.service_id);
END;
