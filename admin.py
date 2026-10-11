"""Authenticated in-Telegram admin panel for one salon.

Only Telegram users explicitly whitelisted in ADMIN_USER_IDS, the private
ADMIN_CHAT_ID owner, or actual administrators of ADMIN_CHAT_ID group can access.
All persistent changes happen server-side, never in browser local storage.
"""
from __future__ import annotations

import html
import logging
from datetime import date, datetime, time, timezone, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import delete, insert, select, update

import main as core
from database import Booking, Master, MasterDayOff, Service, User, WorkingHours, Session, engine, master_services

logger = logging.getLogger(__name__)
router = APIRouter()
ROOT = Path(__file__).resolve().parent


async def is_user_admin(user_id: int) -> bool:
    if user_id in core.ADMIN_USER_IDS:
        return True
    if not core.ADMIN_CHAT_ID:
        return False
    if str(user_id) == core.ADMIN_CHAT_ID:  # private owner chat
        return True
    try:
        member = await core.telegram_api("getChatMember", {
            "chat_id": core.ADMIN_CHAT_ID, "user_id": user_id
        })
        return member.get("status") in ("administrator", "creator")
    except Exception:
        # Fail closed. Do not assume permission when Telegram is offline.
        return False


async def admin_identity(x_telegram_init_data: str = Header(default="")) -> dict:
    user = core.verify_telegram_init_data(x_telegram_init_data)
    if not await is_user_admin(user["id"]):
        raise HTTPException(status_code=403, detail="Только администратор может открыть этот раздел")
    return user


@router.get("/admin", include_in_schema=False)
async def admin_page():
    return FileResponse(ROOT / "templates" / "admin.html", headers={"Cache-Control": "no-store"})


@router.get("/api/admin/overview", dependencies=[Depends(admin_identity)])
async def overview():
    now = core.utc_naive(datetime.now(timezone.utc))
    tomorrow = now + timedelta(days=1)
    async with engine.connect() as connection:
        all_records = (await connection.execute(select(Booking.status))).all()
        upcoming = await connection.scalar(select(Booking.id).where(
            Booking.status.in_(["pending", "confirmed"]),
            Booking.starts_at_utc >= now, Booking.starts_at_utc <= tomorrow
        ).limit(1))
    statuses = [r.status for r in all_records]
    return {"pending": statuses.count("pending"), "confirmed": statuses.count("confirmed"),
            "cancelled": statuses.count("cancelled"), "upcoming_24h": bool(upcoming),
            "salon": core.SALON_NAME, "timezone": "Asia/Yerevan"}


class ServiceInput(BaseModel):
    title: str = Field(min_length=2, max_length=100)
    description: str = Field(default="", max_length=250)
    category: str = Field(default="Услуги", min_length=1, max_length=50)
    icon: str = Field(default="✨", min_length=1, max_length=10)
    duration_minutes: int = Field(ge=15, le=480, multiple_of=15)
    price_amd: int = Field(ge=0, le=20_000_000)
    active: bool = True


class ServicePatch(BaseModel):
    title: str | None = Field(default=None, min_length=2, max_length=100)
    description: str | None = Field(default=None, max_length=250)
    category: str | None = Field(default=None, min_length=1, max_length=50)
    icon: str | None = Field(default=None, min_length=1, max_length=10)
    duration_minutes: int | None = Field(default=None, ge=15, le=480, multiple_of=15)
    price_amd: int | None = Field(default=None, ge=0, le=20_000_000)
    active: bool | None = None

    @model_validator(mode="after")
    def disallow_null(self):
        if any(value is None for value in self.model_dump(exclude_unset=True).values()):
            raise ValueError("Null values are not allowed")
        return self


@router.get("/api/admin/services", dependencies=[Depends(admin_identity)])
async def list_services():
    async with Session() as session:
        data = (await session.execute(select(Service).order_by(Service.id))).scalars().all()
        return [{k: getattr(s, k) for k in
                 ("id", "title", "description", "category", "icon", "duration_minutes", "price_amd", "active")}
                for s in data]


@router.post("/api/admin/services", status_code=201, dependencies=[Depends(admin_identity)])
async def create_service(data: ServiceInput):
    async with engine.begin() as connection:
        result = await connection.execute(insert(Service).values(**data.model_dump()))
    return {"id": result.inserted_primary_key[0]}


@router.patch("/api/admin/services/{service_id}", dependencies=[Depends(admin_identity)])
async def patch_service(service_id: int, data: ServicePatch):
    updates = data.model_dump(exclude_unset=True)
    async with engine.begin() as connection:
        exists = await connection.scalar(select(Service.id).where(Service.id == service_id))
        if not exists:
            raise HTTPException(404, "Услуга не найдена")
        if updates:
            await connection.execute(update(Service).where(Service.id == service_id).values(**updates))
    return {"ok": True}


class MasterInput(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    specialty: str = Field(default="Мастер", min_length=1, max_length=100)
    initials: str = Field(min_length=1, max_length=5)
    active: bool = True
    service_ids: list[int] = Field(default_factory=list, max_length=100)


class MasterPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=100)
    specialty: str | None = Field(default=None, min_length=1, max_length=100)
    initials: str | None = Field(default=None, min_length=1, max_length=5)
    active: bool | None = None
    service_ids: list[int] | None = Field(default=None, max_length=100)


class HoursInput(BaseModel):
    weekday: int = Field(ge=0, le=6)
    start_time: time
    end_time: time

    @model_validator(mode="after")
    def check_hours(self):
        if (self.start_time.tzinfo or self.end_time.tzinfo or
                self.end_time <= self.start_time or
                self.start_time.second or self.end_time.second or
                self.start_time.microsecond or self.end_time.microsecond):
            raise ValueError("Enter a valid same-day working interval")
        return self


class DaysOffInput(BaseModel):
    days: list[date] = Field(max_length=366)


class ScheduleInput(BaseModel):
    hours: list[HoursInput] = Field(max_length=21)
    days: list[date] = Field(max_length=366)


def validate_hour_intervals(hours: list[HoursInput]) -> None:
    by_day = {}
    for entry in hours:
        by_day.setdefault(entry.weekday, []).append((entry.start_time, entry.end_time))
    for periods in by_day.values():
        periods.sort()
        if any(periods[i][0] < periods[i-1][1] for i in range(1, len(periods))):
            raise HTTPException(422, "Рабочие интервалы пересекаются")


def serialize_master(master, links, hours, days_off):
    return {"id": master.id, "name": master.name, "specialty": master.specialty,
            "initials": master.initials, "active": master.active,
            "service_ids": [x.service_id for x in links if x.master_id == master.id],
            "hours": [{"weekday": x.weekday, "start_time": x.start_time.strftime("%H:%M"),
                       "end_time": x.end_time.strftime("%H:%M")} for x in hours if x.master_id == master.id],
            "days_off": [x.day.isoformat() for x in days_off if x.master_id == master.id]}


@router.get("/api/admin/masters", dependencies=[Depends(admin_identity)])
async def list_masters():
    async with Session() as session:
        masters = (await session.execute(select(Master).order_by(Master.id))).scalars().all()
        links = (await session.execute(select(master_services))).all()
        hours = (await session.execute(select(WorkingHours))).scalars().all()
        days_off = (await session.execute(select(MasterDayOff))).scalars().all()
    return [serialize_master(m, links, hours, days_off) for m in masters]


async def assign_services(connection, master_id: int, service_ids: list[int]):
    unique_ids = sorted(set(service_ids))
    if unique_ids:
        existing_ids = set((await connection.execute(select(Service.id).where(Service.id.in_(unique_ids)))).scalars().all())
        if existing_ids != set(unique_ids):
            raise HTTPException(422, "Указана несуществующая услуга")
    await connection.execute(delete(master_services).where(master_services.c.master_id == master_id))
    if unique_ids:
        await connection.execute(insert(master_services), [
            {"master_id": master_id, "service_id": i} for i in unique_ids
        ])


@router.post("/api/admin/masters", status_code=201, dependencies=[Depends(admin_identity)])
async def create_master(data: MasterInput):
    fields = data.model_dump(exclude={"service_ids"})
    async with engine.begin() as connection:
        result = await connection.execute(insert(Master).values(**fields))
        master_id = result.inserted_primary_key[0]
        await assign_services(connection, master_id, data.service_ids)
    return {"id": master_id}


@router.patch("/api/admin/masters/{master_id}", dependencies=[Depends(admin_identity)])
async def patch_master(master_id: int, data: MasterPatch):
    updates = data.model_dump(exclude_unset=True)
    if any(v is None for v in updates.values()):
        raise HTTPException(422, "Null values are not allowed")
    service_ids = updates.pop("service_ids", None)
    async with engine.begin() as connection:
        if not await connection.scalar(select(Master.id).where(Master.id == master_id)):
            raise HTTPException(404, "Мастер не найден")
        if updates:
            await connection.execute(update(Master).where(Master.id == master_id).values(**updates))
        if service_ids is not None:
            await assign_services(connection, master_id, service_ids)
    return {"ok": True}


@router.put("/api/admin/masters/{master_id}/hours", dependencies=[Depends(admin_identity)])
async def change_hours(master_id: int, hours: list[HoursInput]):
    if len(hours) > 21:
        raise HTTPException(422, "Too many intervals")
    validate_hour_intervals(hours)
    async with engine.begin() as connection:
        if not await connection.scalar(select(Master.id).where(Master.id == master_id)):
            raise HTTPException(404, "Мастер не найден")
        await connection.execute(delete(WorkingHours).where(WorkingHours.master_id == master_id))
        if hours:
            await connection.execute(insert(WorkingHours), [
                {"master_id": master_id, **item.model_dump()} for item in hours
            ])
    return {"ok": True}


@router.put("/api/admin/masters/{master_id}/days-off", dependencies=[Depends(admin_identity)])
async def change_days_off(master_id: int, data: DaysOffInput):
    days = sorted(set(data.days))
    async with engine.begin() as connection:
        if not await connection.scalar(select(Master.id).where(Master.id == master_id)):
            raise HTTPException(404, "Мастер не найден")
        await connection.execute(delete(MasterDayOff).where(MasterDayOff.master_id == master_id))
        if days:
            await connection.execute(insert(MasterDayOff), [{"master_id": master_id, "day": d} for d in days])
    return {"ok": True, "note": "Существующие записи остаются; при необходимости отмените их вручную"}


@router.put("/api/admin/masters/{master_id}/schedule", dependencies=[Depends(admin_identity)])
async def change_schedule(master_id: int, data: ScheduleInput):
    """Save the entire form atomically; invalid days must not change working hours."""
    validate_hour_intervals(data.hours)
    async with engine.begin() as connection:
        if not await connection.scalar(select(Master.id).where(Master.id == master_id)):
            raise HTTPException(404, "Мастер не найден")
        await connection.execute(delete(WorkingHours).where(WorkingHours.master_id == master_id))
        await connection.execute(delete(MasterDayOff).where(MasterDayOff.master_id == master_id))
        if data.hours:
            await connection.execute(insert(WorkingHours), [
                {"master_id": master_id, **item.model_dump()} for item in data.hours
            ])
        if data.days:
            await connection.execute(insert(MasterDayOff), [
                {"master_id": master_id, "day": day} for day in sorted(set(data.days))
            ])
    return {"ok": True, "note": "Существующие записи остаются; при необходимости отмените их вручную"}


@router.get("/api/admin/bookings", dependencies=[Depends(admin_identity)])
async def list_bookings(day: date | None = Query(default=None), status: str | None = Query(default=None),
                        limit: int = Query(default=100, ge=1, le=250)):
    if status is not None and status not in ("pending", "confirmed", "cancelled"):
        raise HTTPException(422, "Неверный статус")
    stmt = (select(Booking, Service.title.label("service_title"), Master.name.label("master_name"),
                   User.telegram_id)
            .join(Service, Booking.service_id == Service.id)
            .join(Master, Booking.master_id == Master.id)
            .join(User, Booking.user_id == User.id))
    if status is not None:
        stmt = stmt.where(Booking.status == status)
    if day is not None:
        local_start = core.utc_naive(datetime.combine(day, time.min, tzinfo=core.YEREVAN))
        local_end = core.utc_naive(datetime.combine(day + timedelta(days=1), time.min, tzinfo=core.YEREVAN))
        stmt = stmt.where(Booking.starts_at_utc >= local_start, Booking.starts_at_utc < local_end)
    async with Session() as session:
        rows = (await session.execute(stmt.order_by(Booking.starts_at_utc.desc()).limit(limit))).all()
    return [{"id": record.id, "status": record.status, "service": title,
             "master": master, "client_name": record.client_name,
             "phone": record.phone, "telegram_id": telegram_id,
             "date": record.starts_at_utc.replace(tzinfo=timezone.utc).astimezone(core.YEREVAN).date().isoformat(),
             "time": record.starts_at_utc.replace(tzinfo=timezone.utc).astimezone(core.YEREVAN).strftime("%H:%M")}
            for record, title, master, telegram_id in rows]


class BookingDecision(BaseModel):
    status: str = Field(pattern="^(confirmed|cancelled)$")


@router.patch("/api/admin/bookings/{booking_id}", dependencies=[Depends(admin_identity)])
async def change_booking_status(booking_id: int, decision: BookingDecision):
    async with engine.connect() as connection:
        await connection.exec_driver_sql("BEGIN IMMEDIATE")
        try:
            row = (await connection.execute(
                select(Booking.id, Booking.status, Booking.client_name, Booking.starts_at_utc,
                       User.telegram_id, Service.title, Service.price_amd, Master.name)
                .join(User, Booking.user_id == User.id)
                .join(Service, Booking.service_id == Service.id)
                .join(Master, Booking.master_id == Master.id)
                .where(Booking.id == booking_id)
            )).first()
            if row is None:
                raise HTTPException(404, "Запись не найдена")
            if row.status == decision.status:
                raise HTTPException(409, "Статус уже установлен")
            if row.status == "cancelled" or row.status == "confirmed" and decision.status != "cancelled":
                raise HTTPException(409, "Невозможно изменить обработанную запись")
            await connection.execute(update(Booking).where(Booking.id == booking_id).values(status=decision.status))
            await connection.commit()
        except BaseException:
            await connection.rollback()
            raise
    local_start = row.starts_at_utc.replace(tzinfo=timezone.utc).astimezone(core.YEREVAN)
    action = "✅ Подтверждена" if decision.status == "confirmed" else "❌ Отменена"
    message = (f"<b>{action} запись №{booking_id}</b>\n"
               f"Услуга: {html.escape(row.title)}\nМастер: {html.escape(row.name)}\n"
               f"Когда: {local_start:%d.%m.%Y %H:%M}\n"
               f"Адрес: {html.escape(core.SALON_ADDRESS)}\n"
               f"Цена: {row.price_amd:,} ֏".replace(",", " "))
    await core.send_message_safely(row.telegram_id, message)
    await core.send_message_safely(core.ADMIN_CHAT_ID, f"{action} запись №{booking_id} через админ-панель")
    return {"ok": True, "status": decision.status}
