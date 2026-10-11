"""SQLAlchemy models, async SQLite connection and demonstration catalog."""
from __future__ import annotations

import os
from datetime import date, datetime, time, timezone
from pathlib import Path

from sqlalchemy import (
    BigInteger, Boolean, DateTime, ForeignKey, Index, Integer, String, Table,
    Column, UniqueConstraint, Date, event, func, select
)
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./salon.db")
if not DATABASE_URL.startswith("sqlite+aiosqlite:///"):
    raise ValueError("This SQLite edition requires DATABASE_URL=sqlite+aiosqlite:///...")

# Create an on-disk SQLite parent folder if a path (not :memory:) was configured.
_db_path = DATABASE_URL.removeprefix("sqlite+aiosqlite:///")
if _db_path not in (":memory:", ""):
    Path(_db_path).expanduser().parent.mkdir(parents=True, exist_ok=True)

engine = create_async_engine(DATABASE_URL, connect_args={"timeout": 10})
Session = async_sessionmaker(engine, expire_on_commit=False)


@event.listens_for(engine.sync_engine, "connect")
def _sqlite_pragmas(dbapi_connection, _connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA busy_timeout=10000")
    cursor.close()


class Base(DeclarativeBase):
    pass


master_services = Table(
    "master_services", Base.metadata,
    Column("master_id", ForeignKey("masters.id", ondelete="CASCADE"), primary_key=True),
    Column("service_id", ForeignKey("services.id", ondelete="CASCADE"), primary_key=True),
)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)
    first_name: Mapped[str] = mapped_column(String(100))
    username: Mapped[str | None] = mapped_column(String(100), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(30), nullable=True)


class Service(Base):
    __tablename__ = "services"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(String(250))
    category: Mapped[str] = mapped_column(String(50))
    icon: Mapped[str] = mapped_column(String(10), default="✨")
    duration_minutes: Mapped[int] = mapped_column(Integer)
    price_amd: Mapped[int] = mapped_column(Integer)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    masters: Mapped[list[Master]] = relationship(secondary=master_services, back_populates="services")


class Master(Base):
    __tablename__ = "masters"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    specialty: Mapped[str] = mapped_column(String(100))
    initials: Mapped[str] = mapped_column(String(5))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    services: Mapped[list[Service]] = relationship(secondary=master_services, back_populates="masters")
    working_hours: Mapped[list[WorkingHours]] = relationship(back_populates="master", cascade="all, delete-orphan")


class WorkingHours(Base):
    __tablename__ = "working_hours"
    id: Mapped[int] = mapped_column(primary_key=True)
    master_id: Mapped[int] = mapped_column(ForeignKey("masters.id", ondelete="CASCADE"), index=True)
    weekday: Mapped[int] = mapped_column(Integer)  # Monday=0, Sunday=6
    start_time: Mapped[time] = mapped_column()
    end_time: Mapped[time] = mapped_column()
    master: Mapped[Master] = relationship(back_populates="working_hours")
    __table_args__ = (Index("ix_schedule_master_weekday", "master_id", "weekday"),)


class MasterDayOff(Base):
    """Full-day exception to the weekly schedule (Armenia local date)."""
    __tablename__ = "master_days_off"
    id: Mapped[int] = mapped_column(primary_key=True)
    master_id: Mapped[int] = mapped_column(ForeignKey("masters.id", ondelete="CASCADE"), index=True)
    day: Mapped[datetime.date] = mapped_column(Date, nullable=False)
    __table_args__ = (UniqueConstraint("master_id", "day", name="uq_master_day_off"),)


class Booking(Base):
    __tablename__ = "bookings"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    service_id: Mapped[int] = mapped_column(ForeignKey("services.id"))
    master_id: Mapped[int] = mapped_column(ForeignKey("masters.id"), index=True)
    starts_at_utc: Mapped[datetime] = mapped_column(DateTime(timezone=False))
    ends_at_utc: Mapped[datetime] = mapped_column(DateTime(timezone=False))
    client_name: Mapped[str] = mapped_column(String(80))
    phone: Mapped[str] = mapped_column(String(30))
    status: Mapped[str] = mapped_column(String(15), default="pending")  # pending/confirmed/cancelled
    created_at_utc: Mapped[datetime] = mapped_column(
        DateTime(timezone=False), default=lambda: datetime.now(timezone.utc).replace(tzinfo=None)
    )
    __table_args__ = (Index("ix_booking_master_interval", "master_id", "starts_at_utc", "ends_at_utc"),)


async def initialize_database() -> None:
    """Create tables and seed only if the catalog is entirely empty."""
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async with Session() as session:
        existing = await session.scalar(select(func.count(Service.id)))
        if existing:
            return

        haircut = Service(title="Женская стрижка", description="Форма, укладка и лёгкий уход", category="Волосы", icon="✂️", duration_minutes=60, price_amd=6000)
        coloring = Service(title="Окрашивание", description="Обновление цвета и бережный уход", category="Волосы", icon="🎨", duration_minutes=120, price_amd=18000)
        manicure = Service(title="Маникюр", description="Аккуратный маникюр с покрытием", category="Ногти", icon="💅", duration_minutes=90, price_amd=8000)
        brows = Service(title="Оформление бровей", description="Коррекция формы и окрашивание", category="Лицо", icon="✨", duration_minutes=30, price_amd=4000)
        anna = Master(name="Анна", specialty="Стилист по волосам", initials="АН", services=[haircut, coloring])
        mari = Master(name="Мари", specialty="Нейл-мастер и бровист", initials="МА", services=[manicure, brows])
        liana = Master(name="Лиана", specialty="Универсальный мастер", initials="ЛИ", services=[haircut, manicure, brows])
        for master in (anna, mari, liana):
            for day in range(6):
                master.working_hours.append(WorkingHours(
                    weekday=day,
                    start_time=time(10 if day < 5 else 11, 0),
                    end_time=time(19 if day < 5 else 16, 0),
                ))
        session.add_all([anna, mari, liana])
        await session.commit()
