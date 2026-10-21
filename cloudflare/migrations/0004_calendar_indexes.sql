CREATE INDEX booking_calendar_start ON bookings(starts_at,id);
-- statement-breakpoint
CREATE INDEX booking_calendar_barber_start ON bookings(barber_id,starts_at,id);
