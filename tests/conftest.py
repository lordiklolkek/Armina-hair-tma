"""Release SQLite handles in the event loop that created them (Windows too)."""
import pytest_asyncio


@pytest_asyncio.fixture(autouse=True)
async def release_database_connections():
    yield
    from database import engine

    await engine.dispose()
