import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import timedelta

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api import router, _ensure_extra_tables
from app.auth import hash_pw
from app.models import init_db, SessionLocal, User, Query, Log, utcnow
from app.worker import run_query_loop
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
    try:
        yield
    finally:
        m_task.cancel()
        for t in app.state.tasks.values():
            t.cancel()
        await asyncio.gather(m_task, *app.state.tasks.values(), return_exceptions=True)


app = FastAPI(lifespan=lifespan)
app.include_router(router, prefix="/api")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})
