import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import timedelta

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api import router, _ensure_extra_tables, UserBroadcast
from app.auth import hash_pw
from app.models import init_db, SessionLocal, User, Query, Log, UserLicense, utcnow
from app.worker import run_query_loop, start_all_gateways
from config import BASE_DIR, ADMIN_PASSWORD

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("autopost")

STATIC_DIR = BASE_DIR / "static"
LOG_KEEP_DAYS = 30


def _prune_logs():
    db = SessionLocal()
    try:
        db.query(Log).filter(Log.created_at < utcnow() - timedelta(days=LOG_KEEP_DAYS)).delete()
        db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()



THREE_DAYS = 3 * 24 * 3600  # detik


async def expiry_notify_loop():
    """Tiap 1 jam cek user yang lisensinya <= 3 hari -> buat UserBroadcast kalau belum ada."""
    while True:
        await asyncio.sleep(3600)  # tunggu 1 jam pertama biar startup bersih
        db = SessionLocal()
        try:
            from app.models import utcnow as _utcnow
            now = _utcnow()
            # Ambil semua user_licenses yang hampir habis
            uls = db.query(UserLicense).filter(
                UserLicense.expires_at.isnot(None)
            ).all()
            for ul in uls:
                secs = (ul.expires_at - now).total_seconds()
                if secs <= 0 or secs > THREE_DAYS:
                    continue
                days_left = int(secs // 86400) + 1
                # Cek sudah ada notif aktif belum
                existing = db.query(UserBroadcast).filter_by(
                    user_id=ul.user_id, dismissed=False
                ).first()
                if existing:
                    continue
                msg = (
                    f"⚠️ Lisensi kamu akan habis dalam {days_left} hari! "
                    f"Segera perpanjang agar akun tetap aktif."
                )
                db.add(UserBroadcast(
                    user_id=ul.user_id,
                    message=msg,
                    type="warn",
                ))
            db.commit()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("expiry_notify_loop error")
        finally:
            db.close()


async def manager_loop(app: FastAPI):
    """Tiap 5 detik: nyalain worker buat query 'active', matiin worker buat yang udah stop/kehapus."""
    tick = 0
    while True:
        db = SessionLocal()
        try:
            active_ids = {q.id for q in db.query(Query).filter_by(status="active").all()}
            tasks = app.state.tasks
            for qid in active_ids:
                t = tasks.get(qid)
                if t is None or t.done():
                          tasks[qid] = asyncio.create_task(run_query_loop(qid))
            for qid in list(tasks.keys()):
                if qid not in active_ids:
                    tasks[qid].cancel()
                    del tasks[qid]
            if tick % 720 == 0:  # ~tiap 1 jam
                _prune_logs()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("manager_loop error")
        finally:
            db.close()
        tick += 1
        await asyncio.sleep(5)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    _ensure_extra_tables()
    db = SessionLocal()
    try:
        if not db.query(User).filter_by(username="admin").first():
            db.add(User(username="admin", password_hash=hash_pw(ADMIN_PASSWORD), is_admin=True))
            db.commit()
            if ADMIN_PASSWORD == "admin123":
                log.warning("Login awal admin/admin123 -> GANTI! (set env ADMIN_PASSWORD sebelum run pertama)")
    finally:
        db.close()

    app.state.tasks = {}
    m_task = asyncio.create_task(manager_loop(app))
    n_task = asyncio.create_task(expiry_notify_loop())
    # Migrasi otomatis kolom baru
    from sqlalchemy import text
    from app.models import engine
    with engine.connect() as _conn:
        for _col, _typ in [("dc_id", "VARCHAR(32) DEFAULT ''"), ("dc_avatar", "VARCHAR(128) DEFAULT ''")]:
            try:
                _conn.execute(text(f"ALTER TABLE accounts ADD COLUMN IF NOT EXISTS {_col} {_typ}"))
                _conn.commit()
            except Exception:
                _conn.rollback()
    await start_all_gateways()
    try:
        yield
    finally:
        m_task.cancel()
        n_task.cancel()
        for t in app.state.tasks.values():
            t.cancel()
        await asyncio.gather(m_task, n_task, *app.state.tasks.values(), return_exceptions=True)


app = FastAPI(lifespan=lifespan)


@app.middleware("http")
async def check_ip_blacklist(request, call_next):
    from app.api import _blacklist_cache, _blacklist_loaded, _load_blacklist
    ip = request.headers.get("x-forwarded-for", request.client.host).split(",")[0].strip()
    if not _blacklist_loaded:
        db = SessionLocal()
        try:
            _load_blacklist(db)
        finally:
            db.close()
    if ip in _blacklist_cache:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=403, content={"detail": "Akses ditolak."})
    return await call_next(request)

@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:;"
    return response

app.include_router(router, prefix="/api")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})
