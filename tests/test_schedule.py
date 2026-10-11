"""A failed schedule form must leave both hours and days off unchanged."""
import pytest
from httpx import ASGITransport, AsyncClient

from .test_booking import main, signed_init_data, booking_date
from database import initialize_database


@pytest.mark.asyncio
async def test_schedule_update_is_atomic(monkeypatch):
    async def no_network(*_args, **_kwargs):
        return {}
    monkeypatch.setattr(main, "telegram_api", no_network)
    await initialize_database()
    headers = {"X-Telegram-Init-Data": signed_init_data(999)}
    async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
        result = await client.post("/api/admin/masters", headers=headers, json={
            "name": "График тест", "initials": "ГТ", "service_ids": [1]})
        assert result.status_code == 201
        master_id = result.json()["id"]
        endpoint = f"/api/admin/masters/{master_id}/schedule"
        hours = [{"weekday": n, "start_time": "10:00", "end_time": "18:00"} for n in range(7)]
        assert (await client.put(endpoint, headers=headers, json={"hours": hours, "days": []})).status_code == 200
        changed = [{"weekday": 0, "start_time": "13:00", "end_time": "14:00"}]
        invalid = await client.put(endpoint, headers=headers, json={"hours": changed, "days": ["2026-02-31"]})
        assert invalid.status_code == 422
        masters = (await client.get("/api/admin/masters", headers=headers)).json()
        master = next(m for m in masters if m["id"] == master_id)
        assert master["hours"] == hours and master["days_off"] == []
        assert (await client.put(endpoint, headers=headers, json={
            "hours": hours, "days": [booking_date(), booking_date()]})).status_code == 200
        params = {"service_id": 1, "master_id": master_id, "date": booking_date()}
        assert (await client.get("/api/slots", params=params)).json()["slots"] == []
        overlap = hours + [{"weekday": 0, "start_time": "12:00", "end_time": "13:00"}]
        assert (await client.put(endpoint, headers=headers, json={"hours": overlap, "days": []})).status_code == 422
        assert (await client.get("/api/slots", params=params)).json()["slots"] == []
        assert (await client.put(endpoint, headers=headers, json={"hours": hours, "days": []})).status_code == 200
        assert any(s["time"] == "12:00" for s in (await client.get("/api/slots", params=params)).json()["slots"])
