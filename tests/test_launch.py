"""Deployment setup, credential-safe errors and Telegram webhook behavior."""
import logging
import time
import traceback

import httpx
import pytest
from httpx import ASGITransport, AsyncClient

from .test_booking import main, signed_init_data
from database import initialize_database


def test_render_url_and_secret(monkeypatch):
    monkeypatch.setenv("PUBLIC_BASE_URL", "")
    monkeypatch.setenv("RENDER_EXTERNAL_URL", "https://armina-demo.onrender.com/")
    assert main.resolve_public_base_url() == "https://armina-demo.onrender.com"
    monkeypatch.setenv("PUBLIC_BASE_URL", " https://armina.example/ ")
    assert main.resolve_public_base_url() == "https://armina.example"
    monkeypatch.setenv("WEBHOOK_SECRET", "")
    monkeypatch.setenv("WEBHOOK_SECRET_SEED", "Render/base64+seed==")
    secret = main.resolve_webhook_secret()
    assert len(secret) == 64 and all(c in "0123456789abcdef" for c in secret)
    monkeypatch.setenv("WEBHOOK_SECRET", "a" * 32)
    assert main.resolve_webhook_secret() == "a" * 32


@pytest.mark.parametrize("url", ["http://armina.example", "https://user:pass@armina.example",
                                  "https://armina.example/path", "https://armina.example?token=demo",
                                  "https://armina.example:9999", "https://"])
def test_invalid_public_urls_rejected(monkeypatch, url):
    monkeypatch.setattr(main, "PUBLIC_BASE_URL", url)
    monkeypatch.setattr(main, "WEBHOOK_SECRET", "a" * 32)
    with pytest.raises(RuntimeError, match="HTTPS origin"):
        main.validate_telegram_config()


@pytest.mark.asyncio
async def test_configures_expected_bot(monkeypatch):
    calls = []
    async def fake_api(method, payload):
        calls.append((method, payload))
        return {"username": "ArminaHair_Bot"} if method == "getMe" else True
    monkeypatch.setattr(main, "telegram_api", fake_api)
    monkeypatch.setattr(main, "PUBLIC_BASE_URL", "https://armina.example")
    monkeypatch.setattr(main, "WEBHOOK_SECRET", "a" * 32)
    await main.configure_telegram()
    assert [method for method, _ in calls] == ["getMe", "setWebhook", "setChatMenuButton", "setMyCommands"]
    assert calls[1][1]["url"] == "https://armina.example/telegram/webhook"
    assert calls[1][1]["secret_token"] == main.WEBHOOK_SECRET
    assert calls[2][1]["menu_button"]["web_app"]["url"] == "https://armina.example"
    assert {c["command"] for c in calls[3][1]["commands"]} == {"start", "admin", "id"}


@pytest.mark.asyncio
async def test_render_restart_preserves_external_webhook_by_default(monkeypatch):
    calls = []
    async def capture_configuration():
        calls.append("configure")
    monkeypatch.setattr(main, "configure_telegram", capture_configuration)
    monkeypatch.delenv("TELEGRAM_AUTO_CONFIGURE", raising=False)
    async with main.lifespan(main.app):
        pass
    assert calls == []
    monkeypatch.setenv("TELEGRAM_AUTO_CONFIGURE", "false")
    async with main.lifespan(main.app):
        pass
    assert calls == []
    monkeypatch.setenv("TELEGRAM_AUTO_CONFIGURE", "true")
    async with main.lifespan(main.app):
        pass
    assert calls == ["configure"]


@pytest.mark.asyncio
async def test_wrong_bot_cannot_be_reconfigured(monkeypatch):
    calls = []
    async def fake_api(method, payload):
        calls.append(method)
        return {"username": "AnotherBot"}
    monkeypatch.setattr(main, "telegram_api", fake_api)
    monkeypatch.setattr(main, "PUBLIC_BASE_URL", "https://armina.example")
    monkeypatch.setattr(main, "WEBHOOK_SECRET", "a" * 32)
    with pytest.raises(RuntimeError, match="ArminaHair_Bot"):
        await main.configure_telegram()
    assert calls == ["getMe"]


@pytest.mark.asyncio
async def test_bot_api_error_does_not_leak_token(monkeypatch, caplog):
    original_client = httpx.AsyncClient
    def failure(request):
        return httpx.Response(401, json={"ok": False, "description": "Unauthorized"})
    def mocked_client(**kwargs):
        return original_client(transport=httpx.MockTransport(failure), **kwargs)
    monkeypatch.setattr(main.httpx, "AsyncClient", mocked_client)
    caplog.set_level(logging.INFO)
    with pytest.raises(RuntimeError) as error:
        await main.telegram_api("getMe", {})
    rendered = "".join(traceback.format_exception(error.value)) + caplog.text
    assert main.BOT_TOKEN not in rendered
    assert "HTTPStatusError" in str(error.value)


@pytest.mark.parametrize("age", [main.AUTH_MAX_AGE_SECONDS + 1, -120])
def test_expired_or_future_init_data_rejected(age):
    with pytest.raises(main.HTTPException) as error:
        main.verify_telegram_init_data(signed_init_data(55, int(time.time()) - age))
    assert error.value.status_code == 401


@pytest.mark.asyncio
async def test_lifespan_static_files_health_and_private_id_command(monkeypatch):
    sent = []
    async def capture(chat_id, message, reply_markup=None):
        sent.append((chat_id, message, reply_markup))
    monkeypatch.setattr(main, "send_message_safely", capture)
    monkeypatch.setattr(main, "WEBHOOK_SECRET", "a" * 32)
    async with main.lifespan(main.app):
        async with AsyncClient(transport=ASGITransport(app=main.app), base_url="http://test") as client:
            assert (await client.get("/health")).json() == {"ok": True}
            for path in ("/", "/admin", "/static/app.js", "/static/style.css", "/static/admin.js", "/static/admin.css"):
                assert (await client.get(path)).status_code == 200
            update = {"message": {"text": "/id@ArminaHair_Bot", "chat": {"id": 777, "type": "private"}}}
            assert (await client.post("/telegram/webhook", json=update)).status_code == 403
            result = await client.post("/telegram/webhook", json=update,
                                       headers={"X-Telegram-Bot-Api-Secret-Token": main.WEBHOOK_SECRET})
            assert result.status_code == 200
    assert len(sent) == 1 and sent[0][0] == 777 and "<code>777</code>" in sent[0][1]
