from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import (
    String, Integer, Boolean, DateTime, ForeignKey, Text,
    create_engine, event, inspect, text,
)
from sqlalchemy.orm import DeclarativeBase, sessionmaker, Mapped, mapped_column

from config import DB_URL


def utcnow() -> datetime:
    """UTC naive (sama kayak datetime.utcnow, tapi ga deprecated)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


_is_sqlite = DB_URL.startswith("sqlite")
engine = create_engine(
    DB_URL,
    connect_args={"check_same_thread": False, "timeout": 30} if _is_sqlite else {},
    pool_pre_ping=True,
)

if _is_sqlite:
    # worker + API nulis bareng -> WAL biar ga gampang "database is locked"
    @event.listens_for(engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=30000")
        cur.close()

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)


class Account(Base):
    __tablename__ = "accounts"
    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    label: Mapped[str] = mapped_column(String(64))
    token_enc: Mapped[str] = mapped_column(Text)
    proxy: Mapped[str] = mapped_column(String(255), default="")
    discord_username: Mapped[str] = mapped_column(String(64), default="")


class Query(Base):
    __tablename__ = "queries"
    id: Mapped[int] = mapped_column(primary_key=True)
    query_type: Mapped[str] = mapped_column(String(16), default="auto")
    # JSON: [{"account_id": 1, "content": "teks"}]
    bypass_data: Mapped[str] = mapped_column(Text, default="[]")
    guild_id: Mapped[str] = mapped_column(String(32), default="")
    channel_id: Mapped[str] = mapped_column(String(32))
    channel_name: Mapped[str] = mapped_column(String(128), default="")
    content: Mapped[str] = mapped_column(Text, default="")  # dipake buat Auto Post
    embed_json: Mapped[str] = mapped_column(Text, default="{}")
    webhook_url: Mapped[str] = mapped_column(Text, default="")
    delay_min: Mapped[int] = mapped_column(Integer, default=5)
    status: Mapped[str] = mapped_column(String(16), default="stopped")
    last_run: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class Log(Base):
    __tablename__ = "logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    query_id: Mapped[Optional[int]] = mapped_column(ForeignKey("queries.id"), nullable=True)
    level: Mapped[str] = mapped_column(String(8))
    message: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class UserLicense(Base):
    """Masa aktif user aktif setelah redeem key."""
    __tablename__ = "user_licenses"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), unique=True)
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    max_accounts: Mapped[int] = mapped_column(Integer, default=1)
    max_channels: Mapped[int] = mapped_column(Integer, default=5)


def _migrate():
    """create_all ga nambah kolom baru ke tabel lama -> tambahin manual (data.db lama tetep aman)."""
    insp = inspect(engine)
    if "queries" in insp.get_table_names():
        cols = {c["name"] for c in insp.get_columns("queries")}
        if "guild_id" not in cols:
            with engine.begin() as con:
                con.execute(text("ALTER TABLE queries ADD COLUMN guild_id VARCHAR(32) NOT NULL DEFAULT ''"))


def init_db():
    Base.metadata.create_all(engine)
    _migrate()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
