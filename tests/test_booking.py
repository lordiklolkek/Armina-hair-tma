"""Run with: pip install pytest pytest-asyncio && pytest -q

Integration coverage: signed initData, simultaneous requests, overlapping durations,
slot release when the administrator cancels the booking.
"""
import asyncio
import hashlib
import hmac
import json
import os
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

import pytest
from httpx import ASGITransport, AsyncClient

# Isolation from production/local customer database.
_temp_dir = tempfile.TemporaryDirectory()
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{Path(_temp_dir.name) / 'test.db'}"
os.environ["BOT_TOKEN"] = "123456:TEST_TOKEN"
os.environ["ADMIN_CHAT_ID"] = "999"
os.environ["PUBLIC_BASE_URL"] = ""
os.environ["RENDER_EXTERNAL_URL"] = ""
os.environ["WEBHOOK_SECRET"] = ""
os.environ["WEBHOOK_SECRET_SEED"] = ""
os.environ["ADMIN_USER_IDS"] = ""
os.environ["BOT_USERNAME"] = "ArminaHair_Bot"

import main  # noqa: E402
from database import engine, initialize_database  # noqa: E402


def signed_init_data(user_id: int, auth_date: int | None = None) -> str:
    fields = {
        "auth_date": str(int(time.time()) if auth_date is None else auth_date),
        "user": json.dumps({"id": user_id, "first_name": "Тест"}, ensure_ascii=False, separators=(",", ":")),
        "query_id": f"query_{user_id}",
    }
    data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(fields.items()))
    secret = hmac.new(b"WebAppData", main.BOT_TOKEN.encode(), hashlib.sha256).digest()
    fields["hash"] = hmac.new(secret, data_check_string.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


def booking_date():
    current = datetime.now(ZoneInfo("Asia/Yerevan")).date()
    result = current + timedelta(days=2)
    while result.weekday() == 6:
        result += timedelta(days=1)
    return result.isoformat()


@pytest.mark.asyncio
async def test_booking_race_and_cancellation(monkeypatch):
    async def no_network(*args, **kwargs):
        return {}

    monkeypatch.setattr(main, "send_message_safely", no_network)
    monkeypatch.setattr(main, "telegram_api", no_network)
    await initialize_database()
    day = booking_date()
    url = "/api/book"
    body = {"service_id": 1, "master_id": 1, "date": day,
            "time": "12:00", "name": "Тестовый клиент", "phone": "+374 99 999 999"}
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        async def book_user(uid, data):
            return await client.post(url, json=data, headers={"X-Telegram-Init-Data": signed_init_data(uid)})

        assert (await client.get("/api/services")).status_code == 200
        good, bad = await asyncio.gather(book_user(1001, body), book_user(1002, body))
        assert sorted([good.status_code, bad.status_code]) == [201, 409]
        success = good if good.status_code == 201 else bad
        identifier = success.json()["booking_id"]

        overlapping = {**body, "time": "12:30"}
        assert (await book_user(1003, overlapping)).status_code == 409
        before = (await client.get("/api/slots", params={
            "service_id": 1, "master_id": 1, "date": day
        })).json()["slots"]
        assert "12:30" not in [slot["time"] for slot in before]

        await main.handle_admin_callback({
            "id": "query_1", "from": {"id": 999}, "message": {"chat": {"id": 999}, "message_id": 1},
            "data": f"booking:cancel:{identifier}",
        })
        after = (await client.get("/api/slots", params={
            "service_id": 1, "master_id": 1, "date": day
        })).json()["slots"]
        assert "12:30" in [slot["time"] for slot in after]

    await engine.dispose()


def test_invalid_init_data_rejected():
    raw = signed_init_data(4444)
    assert main.verify_telegram_init_data(raw)["id"] == 4444
    with pytest.raises(Exception) as error:
        main.verify_telegram_init_data(raw + "&new_key=value")
    assert error.value.status_code == 401
