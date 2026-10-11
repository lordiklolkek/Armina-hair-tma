"""FastAPI web app + Telegram Bot API webhook.

Security notes:
- Browser-provided Telegram initData is verified with a constant-time HMAC check.
- A SQLite BEGIN IMMEDIATE write transaction serializes all booking writes.
- Only administrators of ADMIN_CHAT_ID (or configured ADMIN_USER_IDS) can approve.
"""
from __future__ import annotations

import hashlib
import hmac
import html
import json
import logging
import os
import re
import time as unix_time
from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, insert, select, update
from sqlalchemy.exc import SQLAlchemyError

load_dotenv()
from database import (  # noqa: E402 - load environment before DB URL is read
    Booking, Master, Service, User, WorkingHours, MasterDayOff, engine,
    initialize_database, master_services,
)

LOG = logging.getLogger("salon")
logging.basicConfig(level=logging.INFO)
BASE_DIR = Path(__file__).resolve().parent
BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
BOT_USERNAME = os.getenv("BOT_USERNAME", "ArminaHair_Bot").strip().lstrip("@")
ADMIN_CHAT_ID = os.getenv("ADMIN_CHAT_ID", "").strip()
ADMIN_USER_IDS = {
    int(value.strip()) for value in os.getenv("ADMIN_USER_IDS", "").split(",") if value.strip()
}


def resolve_public_base_url() -> str:
    return (os.getenv("PUBLIC_BASE_URL", "").strip()
            or os.getenv("RENDER_EXTERNAL_URL", "").strip()).rstrip("/")


def resolve_webhook_secret() -> str:
    explicit = os.getenv("WEBHOOK_SECRET", "").strip()
    seed = os.getenv("WEBHOOK_SECRET_SEED", "").strip()
    # Render-generated secrets are base64 and may contain characters Telegram forbids.
    return explicit or (hashlib.sha256(seed.encode()).hexdigest() if seed else "")


PUBLIC_BASE_URL = resolve_public_base_url()
WEBHOOK_SECRET = resolve_webhook_secret()
# httpx's INFO request log contains the Bot API token in the URL.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
SALON_NAME = os.getenv("SALON_NAME", "Armina Hair")
SALON_ADDRESS = os.getenv("SALON_ADDRESS", "Адрес уточняется у администратора")
YEREVAN = ZoneInfo("Asia/Yerevan")
UTC = timezone.utc
STEP_MINUTES = 30
BOOKING_NOTICE_MINUTES = 60
ADVANCE_DAYS = 30
AUTH_MAX_AGE_SECONDS = 86400


class BookingRequest(BaseModel):
    service_id: int = Field(ge=1)
    master_id: int | None = Field(default=None, ge=1)  # None = any eligible master
    date: date
    time: str = Field(pattern=r"^\d{2}:\d{2}$")
    name: str = Field(min_length=2, max_length=80)
    phone: str = Field(min_length=7, max_length=24)

    @field_validator("name", "phone", mode="before")
    @classmethod
    def trim(cls, value):
        return value.strip() if isinstance(value, str) else value

    @field_validator("phone")
    @classmethod
    def validate_phone(cls, value: str) -> str:
        if not re.fullmatch(r"\+?[0-9()\-\s]{7,24}", value):
            raise ValueError("Неверный номер телефона")
        digits = re.sub(r"\D", "", value)
        if not 7 <= len(digits) <= 15:
            raise ValueError("Введите номер с 7–15 цифрами")
        return value


def utc_naive(value: datetime) -> datetime:
    return value.astimezone(UTC).replace(tzinfo=None)


def local_interval(day: date, slot: str, duration: int) -> tuple[datetime, datetime]:
    try:
        start_clock = time.fromisoformat(slot)
    except ValueError as exc:
        raise HTTPException(422, "Неверный формат времени") from exc
    if start_clock.second or start_clock.microsecond or start_clock.minute % STEP_MINUTES:
        raise HTTPException(422, "Недопустимый шаг времени")
    start = datetime.combine(day, start_clock, tzinfo=YEREVAN)
    return start, start + timedelta(minutes=duration)


def ensure_date_allowed(day: date) -> None:
    today = datetime.now(YEREVAN).date()
    if not today <= day <= today + timedelta(days=ADVANCE_DAYS):
        raise HTTPException(422, "Дата должна быть в пределах ближайших 30 дней")


def verify_telegram_init_data(raw: str) -> dict:
    if not BOT_TOKEN:
        raise HTTPException(503, "Токен Telegram-бота не настроен")
    if not raw or len(raw) > 8192:
        raise HTTPException(401, "Откройте приложение через Telegram")
    try:
        pairs = parse_qsl(raw, keep_blank_values=True, strict_parsing=True)
        values = dict(pairs)
        if len(pairs) != len(values):
            raise ValueError("Duplicate initData keys")
        supplied_hash = values.pop("hash")
        if len(supplied_hash) != 64 or not re.fullmatch(r"[a-fA-F0-9]{64}", supplied_hash):
            raise ValueError("Invalid hash")
        check_string = "\n".join(f"{key}={value}" for key, value in sorted(values.items()))
        secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        expected = hmac.new(secret_key, check_string.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, supplied_hash.lower()):
            raise ValueError("Invalid HMAC")
        auth_date = int(values["auth_date"])
        age = int(unix_time.time()) - auth_date
        if age < -60 or age > AUTH_MAX_AGE_SECONDS:
            raise ValueError("initData expired")
        user = json.loads(values["user"])
        if not isinstance(user, dict) or not isinstance(user.get("id"), int) or isinstance(user["id"], bool):
            raise ValueError("Missing Telegram user id")
        return user
    except (ValueError, KeyError, json.JSONDecodeError) as exc:
        raise HTTPException(401, "Ошибка проверки данных Telegram. Откройте приложение заново") from exc


async def telegram_user(x_telegram_init_data: str = Header(default="")) -> dict:
    return verify_telegram_init_data(x_telegram_init_data)


async def telegram_api(method: str, payload: dict) -> dict:
    if not BOT_TOKEN:
        raise RuntimeError("BOT_TOKEN has not been configured")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(f"https://api.telegram.org/bot{BOT_TOKEN}/{method}", json=payload)
            response.raise_for_status()
            result = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        # Never propagate an exception whose text includes the credential-bearing URL.
        raise RuntimeError(f"Telegram {method} failed ({type(exc).__name__})") from None
    if not isinstance(result, dict):
        raise RuntimeError(f"Telegram {method}: invalid response")
    if not result.get("ok"):
        raise RuntimeError(f"Telegram {method}: {result.get('description')}")
    return result.get("result")


async def send_message_safely(chat_id: int | str, message: str, reply_markup: dict | None = None) -> None:
    payload = {"chat_id": chat_id, "text": message, "parse_mode": "HTML"}
    if reply_markup is not None:
        payload["reply_markup"] = reply_markup
    try:
        await telegram_api("sendMessage", payload)
    except Exception as exc:
        # Avoid logging the full Bot API URL: it contains the secret bot token.
        LOG.error("Telegram sendMessage failed for chat %s (%s)", chat_id, type(exc).__name__)


def validate_telegram_config() -> None:
    if PUBLIC_BASE_URL:
        try:
            parsed = urlsplit(PUBLIC_BASE_URL)
            valid = (parsed.scheme == "https" and parsed.hostname and not parsed.username
                     and not parsed.password and not parsed.query and not parsed.fragment
                     and not parsed.path and parsed.port in (None, 443, 80, 88, 8443))
        except ValueError:
            valid = False
        if not valid:
            raise RuntimeError("PUBLIC_BASE_URL must be a public HTTPS origin without a path or credentials")
        if not BOT_TOKEN or not WEBHOOK_SECRET or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", WEBHOOK_SECRET):
            raise RuntimeError("Configure BOT_TOKEN and WEBHOOK_SECRET before enabling webhook")
        if ADMIN_CHAT_ID and not re.fullmatch(r"-?[1-9][0-9]*", ADMIN_CHAT_ID):
            raise RuntimeError("ADMIN_CHAT_ID must be a numeric Telegram chat ID, not a username")


async def configure_telegram() -> None:
    validate_telegram_config()
    if PUBLIC_BASE_URL:
        bot = await telegram_api("getMe", {})
        if BOT_USERNAME and (bot or {}).get("username", "").lower() != BOT_USERNAME.lower():
            raise RuntimeError(f"BOT_TOKEN must belong to @{BOT_USERNAME}")
        await telegram_api("setWebhook", {
            "url": f"{PUBLIC_BASE_URL}/telegram/webhook",
            "secret_token": WEBHOOK_SECRET,
            "allowed_updates": ["message", "callback_query"],
        })
        await telegram_api("setChatMenuButton", {
            "menu_button": {"type": "web_app", "text": "Записаться", "web_app": {"url": PUBLIC_BASE_URL}}
        })
        await telegram_api("setMyCommands", {"commands": [
            {"command": "start", "description": "Открыть запись в Armina Hair"},
            {"command": "admin", "description": "Панель управления салоном"},
            {"command": "id", "description": "Мой Telegram ID для настройки администратора"},
        ]})
        LOG.info("Telegram webhook and Mini App menu configured")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        validate_telegram_config()
        await initialize_database()
        await configure_telegram()
        yield
    finally:
        await engine.dispose()


app = FastAPI(title="Armina Hair Booking TMA", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(BASE_DIR / "templates" / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/health")
async def health():
    try:
        async with engine.connect() as connection:
            await connection.execute(select(1))
    except SQLAlchemyError:
        return JSONResponse({"ok": False}, status_code=503)
    return {"ok": True}


@app.get("/api/config")
async def public_config():
    return {"salon_name": SALON_NAME, "salon_address": SALON_ADDRESS, "timezone": "Asia/Yerevan"}


@app.get("/api/services")
async def services():
    async with engine.connect() as connection:
        service_rows = (await connection.execute(
            select(Service.id, Service.title, Service.description, Service.category, Service.icon,
                   Service.duration_minutes, Service.price_amd).where(Service.active.is_(True)).order_by(Service.id)
        )).mappings().all()
        masters = (await connection.execute(
            select(master_services.c.service_id, Master.id, Master.name, Master.specialty, Master.initials)
            .select_from(master_services.join(Master, Master.id == master_services.c.master_id))
            .where(Master.active.is_(True)).order_by(Master.id)
        )).mappings().all()
    return [{**dict(s), "masters": [
        {"id": m["id"], "name": m["name"], "specialty": m["specialty"], "initials": m["initials"]}
        for m in masters if m["service_id"] == s["id"]
    ]} for s in service_rows]


async def eligible_masters(connection, service_id: int, master_id: int | None):
    stmt = (select(Master.id, Master.name)
            .join(master_services, master_services.c.master_id == Master.id)
            .where(master_services.c.service_id == service_id, Master.active.is_(True))
            .order_by(Master.id))
    if master_id is not None:
        stmt = stmt.where(Master.id == master_id)
    return (await connection.execute(stmt)).all()


async def master_can_work(connection, master_id: int, day: date, start: datetime, end: datetime) -> bool:
    day_off = await connection.scalar(select(MasterDayOff.id).where(
        MasterDayOff.master_id == master_id, MasterDayOff.day == day).limit(1))
    if day_off is not None:
        return False
    schedules = (await connection.execute(
        select(WorkingHours.start_time, WorkingHours.end_time).where(
            WorkingHours.master_id == master_id, WorkingHours.weekday == day.weekday()
        )
    )).all()
    return any(
        start.time() >= entry.start_time and end.time() <= entry.end_time
        and start.date() == day and end.date() == day
        for entry in schedules
    )


async def master_is_available(connection, master_id: int, day: date, start: datetime, end: datetime) -> bool:
    if not await master_can_work(connection, master_id, day, start, end):
        return False
    conflicting = await connection.scalar(
        select(Booking.id).where(
            Booking.master_id == master_id,
            Booking.status.in_(["pending", "confirmed"]),
            Booking.starts_at_utc < utc_naive(end),
            Booking.ends_at_utc > utc_naive(start),
        ).limit(1)
    )
    return conflicting is None


@app.get("/api/slots")
async def slots(
    service_id: int = Query(ge=1),
    date_value: date = Query(alias="date"),
    master_id: int | None = Query(default=None, ge=1),
):
    ensure_date_allowed(date_value)
    async with engine.connect() as connection:
        service = (await connection.execute(select(Service.id, Service.duration_minutes).where(
            Service.id == service_id, Service.active.is_(True)
        ))).first()
        if not service:
            raise HTTPException(404, "Услуга не найдена")
        masters = await eligible_masters(connection, service_id, master_id)
        if not masters:
            raise HTTPException(404, "Мастера не найдены")
        slots_found = []
        for minute in range(0, 24 * 60, STEP_MINUTES):
            clock = f"{minute // 60:02d}:{minute % 60:02d}"
            start, end = local_interval(date_value, clock, service.duration_minutes)
            if start < datetime.now(YEREVAN) + timedelta(minutes=BOOKING_NOTICE_MINUTES):
                continue
            count = 0
            for master in masters:
                if await master_is_available(connection, master.id, date_value, start, end):
                    count += 1
            if count:
                slots_found.append({"time": clock, "available_masters": count})
    return {"date": date_value.isoformat(), "slots": slots_found, "timezone": "Asia/Yerevan"}


@app.post("/api/book", status_code=201)
async def book(payload: BookingRequest, user: dict = Depends(telegram_user)):
    if not ADMIN_CHAT_ID:
        raise HTTPException(503, "Администратор пока не настроен")
    ensure_date_allowed(payload.date)
    async with engine.connect() as connection:
        # A RESERVED SQLite write lock must be acquired *before* checking availability.
        # Concurrent requests then read/check/write sequentially, avoiding overlapping bookings.
        await connection.exec_driver_sql("BEGIN IMMEDIATE")
        try:
            service = (await connection.execute(select(
                Service.id, Service.title, Service.price_amd, Service.duration_minutes
            ).where(Service.id == payload.service_id, Service.active.is_(True)))).first()
            if not service:
                raise HTTPException(404, "Услуга не найдена")
            start, end = local_interval(payload.date, payload.time, service.duration_minutes)
            if start < datetime.now(YEREVAN) + timedelta(minutes=BOOKING_NOTICE_MINUTES):
                raise HTTPException(409, "Это время уже недоступно")
            # One person cannot reserve overlapping visits, even with different masters.
            # The check runs under BEGIN IMMEDIATE together with the slot check.
            duplicate_user_booking = await connection.scalar(
                select(Booking.id).join(User, User.id == Booking.user_id).where(
                    User.telegram_id == user["id"],
                    Booking.status.in_(["pending", "confirmed"]),
                    Booking.starts_at_utc < utc_naive(end),
                    Booking.ends_at_utc > utc_naive(start),
                ).limit(1)
            )
            if duplicate_user_booking is not None:
                raise HTTPException(409, "У вас уже есть запись на это время")
            masters = await eligible_masters(connection, service.id, payload.master_id)
            if not masters:
                raise HTTPException(404, "Мастер недоступен для этой услуги")
            selected = None
            for master in masters:
                if await master_is_available(connection, master.id, payload.date, start, end):
                    selected = master
                    break
            if selected is None:
                raise HTTPException(409, "Время уже занято. Выберите другой слот")

            existing_user = (await connection.execute(
                select(User.id).where(User.telegram_id == user["id"])
            )).scalar_one_or_none()
            if existing_user is None:
                result = await connection.execute(insert(User).values(
                    telegram_id=user["id"], first_name=str(user.get("first_name", ""))[:100],
                    username=str(user.get("username") or "")[:100] or None, phone=payload.phone
                ))
                user_id = result.inserted_primary_key[0]
            else:
                user_id = existing_user
                await connection.execute(update(User).where(User.id == user_id).values(phone=payload.phone))
            record = await connection.execute(insert(Booking).values(
                user_id=user_id, service_id=service.id, master_id=selected.id,
                starts_at_utc=utc_naive(start), ends_at_utc=utc_naive(end),
                client_name=payload.name, phone=payload.phone, status="pending",
            ))
            booking_id = record.inserted_primary_key[0]
            await connection.commit()
        except BaseException:
            await connection.rollback()
            raise

    # Notifications happen after COMMIT: Telegram downtime cannot silently undo a reservation.
    detail = (f"<b>Запись №{booking_id}</b>\n"
              f"Услуга: {html.escape(service.title)}\n"
              f"Мастер: {html.escape(selected.name)}\n"
              f"Когда: {start:%d.%m.%Y} в {start:%H:%M} (Ереван)\n"
              f"Адрес: {html.escape(SALON_ADDRESS)}\n"
              f"Стоимость: {service.price_amd:,} ֏".replace(",", " "))
    await send_message_safely(user["id"], f"🕓 <b>Заявка отправлена на подтверждение</b>\n\n{detail}")
    admin_markup = {"inline_keyboard": [[
        {"text": "✅ Подтвердить", "callback_data": f"booking:confirm:{booking_id}"},
        {"text": "❌ Отменить", "callback_data": f"booking:cancel:{booking_id}"},
    ]]}
    await send_message_safely(ADMIN_CHAT_ID,
        f"🆕 <b>Новая запись — ожидает решения</b>\n\n{detail}\n"
        f"Клиент: {html.escape(payload.name)}\nТелефон: {html.escape(payload.phone)}\n"
        f"Telegram ID: <code>{user['id']}</code>", admin_markup)
    return {"booking_id": booking_id, "status": "pending", "master_name": selected.name,
            "date": payload.date.isoformat(), "time": payload.time}


async def is_admin(callback: dict) -> bool:
    actor = callback.get("from", {})
    chat = (callback.get("message") or {}).get("chat") or {}
    if str(chat.get("id")) != ADMIN_CHAT_ID:
        return False
    actor_id = actor.get("id")
    if not isinstance(actor_id, int):
        return False
    if actor_id in ADMIN_USER_IDS or str(actor_id) == ADMIN_CHAT_ID:
        return True
    try:
        member = await telegram_api("getChatMember", {"chat_id": ADMIN_CHAT_ID, "user_id": actor_id})
        return member.get("status") in ("administrator", "creator")
    except Exception:
        LOG.exception("Could not verify admin rights")
        return False


async def respond_to_callback(callback_id: str, message: str) -> None:
    try:
        await telegram_api("answerCallbackQuery", {"callback_query_id": callback_id, "text": message, "show_alert": False})
    except Exception:
        LOG.exception("Failed to answer callback")


async def handle_admin_callback(callback: dict) -> None:
    callback_id = callback.get("id", "")
    match = re.fullmatch(r"booking:(confirm|cancel):(\d+)", callback.get("data") or "")
    if not match or not await is_admin(callback):
        await respond_to_callback(callback_id, "Недостаточно прав")
        return
    action, booking_id_string = match.groups()
    booking_id = int(booking_id_string)
    status = "confirmed" if action == "confirm" else "cancelled"

    async with engine.connect() as connection:
        await connection.exec_driver_sql("BEGIN IMMEDIATE")
        try:
            row = (await connection.execute(
                select(Booking.id, Booking.status, Booking.starts_at_utc, Booking.user_id,
                       Booking.client_name, Service.title, Service.price_amd, Master.name,
                       User.telegram_id)
                .join(Service, Booking.service_id == Service.id)
                .join(Master, Booking.master_id == Master.id)
                .join(User, Booking.user_id == User.id)
                .where(Booking.id == booking_id)
            )).first()
            if not row:
                await connection.rollback()
                await respond_to_callback(callback_id, "Запись не найдена")
                return
            if row.status != "pending":
                await connection.rollback()
                await respond_to_callback(callback_id, "Запись уже обработана")
                return
            await connection.execute(update(Booking).where(Booking.id == booking_id).values(status=status))
            await connection.commit()
        except BaseException:
            await connection.rollback()
            raise

    message = callback.get("message") or {}
    if "message_id" in message:
        try:
            await telegram_api("editMessageReplyMarkup", {
                "chat_id": ADMIN_CHAT_ID, "message_id": message["message_id"],
                "reply_markup": {"inline_keyboard": []},
            })
        except Exception:
            LOG.exception("Could not remove admin buttons")
    now_local = row.starts_at_utc.replace(tzinfo=UTC).astimezone(YEREVAN)
    response = "✅ Подтверждена" if status == "confirmed" else "❌ Отменена"
    await respond_to_callback(callback_id, response)
    await send_message_safely(ADMIN_CHAT_ID, f"{response} запись №{booking_id}. Клиент: {html.escape(row.client_name)}")
    await send_message_safely(row.telegram_id,
        f"<b>{response} ваша запись №{booking_id}</b>\n"
        f"Услуга: {html.escape(row.title)}\nМастер: {html.escape(row.name)}\n"
        f"Дата: {now_local:%d.%m.%Y} в {now_local:%H:%M} (Ереван)\n"
        f"Адрес: {html.escape(SALON_ADDRESS)}\nСтоимость: {row.price_amd:,} ֏".replace(",", " "))


@app.post("/telegram/webhook", include_in_schema=False)
async def webhook(request: Request, x_telegram_bot_api_secret_token: str = Header(default="")):
    if not WEBHOOK_SECRET or not hmac.compare_digest(x_telegram_bot_api_secret_token.encode(), WEBHOOK_SECRET.encode()):
        raise HTTPException(403, "Forbidden")
    update_data = await request.json()
    if "callback_query" in update_data:
        await handle_admin_callback(update_data["callback_query"])
    elif "message" in update_data:
        message = update_data["message"]
        parts = (message.get("text") or "").split(maxsplit=1)
        command = parts[0].split("@", 1)[0] if parts else ""
        if command == "/id" and message.get("chat", {}).get("type") == "private":
            await send_message_safely(message["chat"]["id"],
                f"Ваш Telegram ID: <code>{message['chat']['id']}</code>\n"
                "Владелец салона может указать его в ADMIN_CHAT_ID на хостинге.")
        elif command == "/admin" and message.get("chat", {}).get("type") == "private":
            from admin import is_user_admin
            admin_id = message.get("from", {}).get("id")
            if isinstance(admin_id, int) and await is_user_admin(admin_id):
                markup = None
                if PUBLIC_BASE_URL:
                    markup = {"inline_keyboard": [[{
                        "text": "⚙️ Панель управления", "web_app": {"url": f"{PUBLIC_BASE_URL}/admin"}
                    }]]}
                await send_message_safely(message["chat"]["id"],
                    "⚙️ Панель управления Armina Hair. Откройте её внутри Telegram.", markup)
            else:
                await send_message_safely(message["chat"]["id"], "Нет доступа к управлению салоном.")
        elif command == "/start" and message.get("chat", {}).get("type") == "private":
            reply_markup = None
            if PUBLIC_BASE_URL:
                reply_markup = {"inline_keyboard": [[{
                    "text": "✨ Открыть запись",
                    "web_app": {"url": PUBLIC_BASE_URL},
                }]]}
            await send_message_safely(message["chat"]["id"],
                f"Добро пожаловать в <b>{html.escape(SALON_NAME)}</b>! Выберите услугу и удобное время.",
                reply_markup)
    return JSONResponse({"ok": True})

# The administrator API is separate from the public booking flow.
from admin import router as admin_router  # noqa: E402
app.include_router(admin_router)
