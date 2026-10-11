"""Additional authenticated admin endpoints and schedule exception integration tests.

Requires: pip install -r requirements.txt pytest pytest-asyncio
"""
from datetime import date
from httpx import ASGITransport, AsyncClient
import pytest

from .test_booking import main, signed_init_data, booking_date
from database import initialize_database


@pytest.mark.asyncio
async def test_admin_access_catalog_and_day_off(monkeypatch):
    async def no_network(*_args, **_kwargs):
        return {}
    monkeypatch.setattr(main, "send_message_safely", no_network)
    monkeypatch.setattr(main, "telegram_api", no_network)
    await initialize_database()

    admin_headers = {"X-Telegram-Init-Data": signed_init_data(999)}
    customer_headers = {"X-Telegram-Init-Data": signed_init_data(505)}
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        assert (await client.get("/api/admin/bookings")).status_code == 401
        assert (await client.get("/api/admin/bookings", headers=customer_headers)).status_code == 403
        assert (await client.get("/api/admin/overview", headers=admin_headers)).status_code == 200

        service = {"title": "Тестовая укладка", "description": "Тест", "category": "Волосы",
                   "icon": "✂️", "price_amd": 7000, "duration_minutes": 60, "active": True}
        created = await client.post("/api/admin/services", json=service, headers=admin_headers)
        assert created.status_code == 201, created.text
        service_id = created.json()["id"]
        patched = await client.patch(f"/api/admin/services/{service_id}",
                                     json={"price_amd": 7500}, headers=admin_headers)
        assert patched.status_code == 200
        assert any(x["price_amd"] == 7500 and x["id"] == service_id
                   for x in (await client.get("/api/admin/services",headers=admin_headers)).json())

        master = await client.post("/api/admin/masters", headers=admin_headers, json={
            "name":"Тест мастер", "initials":"ТМ", "specialty":"Укладка", "service_ids":[service_id]})
        assert master.status_code == 201, master.text
        master_id = master.json()["id"]
        work_hours = [{"weekday": w, "start_time":"10:00", "end_time":"18:00"} for w in range(7)]
        assert (await client.put(f"/api/admin/masters/{master_id}/hours", headers=admin_headers,
                                 json=work_hours)).status_code == 200
        day = booking_date()
        before = (await client.get("/api/slots",params={"service_id":service_id,"master_id":master_id,
                                                        "date":day})).json()["slots"]
        assert any(x["time"] == "12:00" for x in before)
        assert (await client.put(f"/api/admin/masters/{master_id}/days-off", headers=admin_headers,
                                 json={"days":[day]})).status_code == 200
        after = (await client.get("/api/slots",params={"service_id":service_id,"master_id":master_id,
                                                       "date":day})).json()["slots"]
        assert after == []
        assert (await client.put(f"/api/admin/masters/{master_id}/days-off", headers=admin_headers,
                                 json={"days":[]})).status_code == 200
        assert (await client.patch(f"/api/admin/masters/{master_id}", headers=admin_headers,
                                   json={"active":False})).status_code == 200
        assert (await client.get("/api/slots",params={"service_id":service_id,"master_id":master_id,
                                                    "date":day})).status_code == 404


@pytest.mark.asyncio
async def test_admin_confirmation_notifies_customer(monkeypatch):
    sent = []
    async def capture(target, message, *_args, **_kwargs):
        sent.append((target,message))
    monkeypatch.setattr(main,"send_message_safely",capture)
    await initialize_database()
    admin_headers = {"X-Telegram-Init-Data": signed_init_data(999)}
    client_headers = {"X-Telegram-Init-Data": signed_init_data(601)}
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        create = await client.post("/api/book", headers=client_headers, json={
            "service_id": 1, "master_id": 1, "date": booking_date(),
            "time": "14:00", "name": "Тест подтверждения", "phone": "+374 99 222 333"})
        assert create.status_code == 201, create.text
        booking_id = create.json()["booking_id"]
        approved = await client.patch(f"/api/admin/bookings/{booking_id}",
                                      headers=admin_headers,json={"status":"confirmed"})
        assert approved.status_code == 200, approved.text
        assert any(target == 601 and 'Подтверждена' in msg for target,msg in sent)
        again = await client.patch(f"/api/admin/bookings/{booking_id}",
                                   headers=admin_headers,json={"status":"confirmed"})
        assert again.status_code == 409
