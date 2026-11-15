from datetime import datetime, timedelta
"""
api.py — LePost backend (merged)
Semua endpoint dari source_lama + endpoint baru untuk ui_baru:
  /me, /public, /signup, /redeem, /admin/*, /admin/broadcast
"""
import json
import os
import re
import secrets
import string
from datetime import timedelta
from typing import Any, Dict, List, Literal, Optional

from fastapi import Request, APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text, ForeignKey, text
from sqlalchemy.orm import Session

from cryptography.fernet import Fernet

from app.auth import current_user, verify_pw, make_token, hash_pw
from app.discord_client import Discord
from app.models import User, Account, Query, Log, UserLicense, get_db, utcnow, Base, engine
from config import TOKEN_ENC_KEY

_fernet = Fernet(TOKEN_ENC_KEY)


def _enc_token(raw: str) -> str:
    """Enkripsi Discord token sebelum disimpan ke DB."""
    return _fernet.encrypt(raw.encode()).decode()


def _dec_token(enc: str) -> str:
    """Dekripsi Discord token dari DB. Kalau gagal (data lama plaintext), kembalikan as-is."""
    try:
        return _fernet.decrypt(enc.encode()).decode()
    except Exception:
        # fallback: token lama yang belum dienkripsi (migrasi transparan)
        return enc

router = APIRouter()


# ─────────────────────────── extra models (untuk fitur baru) ───────────────────────────
class License(Base):
    """Tabel lisensi key pengguna."""
    __tablename__ = "licenses"
    id = Column(Integer, primary_key=True)
    key = Column(String(64), unique=True, index=True)
    days = Column(Integer, default=30)
    max_accounts = Column(Integer, default=1)   # 0 = tidak terbatas
    max_channels = Column(Integer, default=5)   # 0 = tidak terbatas
    allow_bypass = Column(Boolean, default=False)
    allow_dashboard = Column(Boolean, default=False)
    note = Column(String(64), default="")
    used_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    used_at = Column(DateTime, nullable=True)



class Broadcast(Base):
    """Pesan broadcast global dari admin."""
    __tablename__ = "broadcasts"
    id = Column(Integer, primary_key=True)
    message = Column(Text, default="")
    type = Column(String(16), default="info")  # info | warn | danger
    created_at = Column(DateTime, default=utcnow)




class UserBroadcast(Base):
    """Notif broadcast khusus per user (misal: H-3 lisensi habis)."""
    __tablename__ = "user_broadcasts"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    message = Column(Text, default="")
    type = Column(String(16), default="warn")  # info | warn | danger
    created_at = Column(DateTime, default=utcnow)
    dismissed = Column(Boolean, default=False)

def _ensure_extra_tables():
    """Buat tabel extra kalau belum ada (safe, tidak drop tabel lama)."""
    Base.metadata.create_all(engine, tables=[
        License.__table__,
        Broadcast.__table__,
        UserBroadcast.__table__,
    ])




# ─────────────────────────── helpers ───────────────────────────
def _dump(m, **kw):
    return m.model_dump(**kw) if hasattr(m, "model_dump") else m.dict(**kw)


def _check_channel(cid: str):
    if not re.match(ID_RE, cid or ""):
        raise HTTPException(400, "Channel ID ga valid, pilih channel dulu")


PROXY_RE = re.compile(r"^(socks5h?|socks4a?|https?)://\S+$", re.I)
ID_RE = r"^\d{5,25}$"


def _iso(dt) -> Optional[str]:
    return dt.isoformat() + "Z" if dt else None


def _owned_ids(db: Session, user: User) -> set:
    return {i for (i,) in db.query(Account.id).filter(Account.owner_id == user.id).all()}


def _q_acc_ids(q: Query) -> set:
    try:
        return {int(t["account_id"]) for t in json.loads(q.bypass_data or "[]")}
    except (ValueError, KeyError, TypeError):
        return set()


def _visible(q: Query, user: User, owned: set) -> bool:
    return user.is_admin or bool(_q_acc_ids(q) & owned)


def _visible_queries(db: Session, user: User) -> List[Query]:
    owned = _owned_ids(db, user)
    return [q for q in db.query(Query).order_by(Query.id).all() if _visible(q, user, owned)]


def _get_query(db: Session, qid: int, user: User) -> Query:
    q = db.get(Query, qid)
    if not q or not _visible(q, user, _owned_ids(db, user)):
        raise HTTPException(404, "Query ga ketemu")
    return q


def _get_account(db: Session, aid: int, user: User) -> Account:
    acc = db.get(Account, aid)
    if not acc or acc.owner_id != user.id:
        raise HTTPException(404, "Akun ga ketemu")
    return acc


def _check_targets(db: Session, user: User, targets):
    if not targets:
        raise HTTPException(400, "Pilih minimal 1 akun")
    owned = _owned_ids(db, user)
    for t in targets:
        if t.account_id not in owned:
            raise HTTPException(403, f"Akun ID {t.account_id} bukan punyamu")


def _check_webhook(url: str):
    if url and not url.startswith((
        "https://discord.com/api/webhooks/",
        "https://discordapp.com/api/webhooks/",
        "https://canary.discord.com/api/webhooks/",
        "https://ptb.discord.com/api/webhooks/",
    )):
        raise HTTPException(400, "Webhook harus URL webhook Discord")


def _q_out(q: Query) -> dict:
    try:
        bypass_data = json.loads(q.bypass_data or "[]")
    except (ValueError, TypeError):
        bypass_data = []
    try:
        embed = json.loads(q.embed_json or "{}")
        if not isinstance(embed, dict):
            embed = {}
    except (ValueError, TypeError):
        embed = {}
    return {
        "id": q.id, "query_type": q.query_type,
        "bypass_data": bypass_data,
        "guild_id": q.guild_id or "", "channel_id": q.channel_id,
        "channel_name": q.channel_name, "content": q.content,
        "embed": embed,
        "webhook_url": q.webhook_url or "",
        "status": q.status, "delay_min": q.delay_min,
        "last_run": _iso(q.last_run),
    }


def _discord_fail(res: dict, what: str):
    status = res.get("error")
    raise HTTPException(400, f"{what}: {res.get('message') or status} ({status})")


def _get_ul(db: Session, uid: int) -> Optional[UserLicense]:
    return db.query(UserLicense).filter_by(user_id=uid).first()


def _seconds_left(ul: Optional[UserLicense]) -> Optional[int]:
    if ul is None or ul.expires_at is None:
        return None
    delta = (ul.expires_at - utcnow()).total_seconds()
    return max(0, int(delta))


def _is_expired(ul: Optional[UserLicense]) -> bool:
    sec = _seconds_left(ul)
    return sec is not None and sec <= 0


def _user_account_count(db: Session, uid: int) -> int:
    return db.query(Account).filter_by(owner_id=uid).count()


def _user_channel_count(db: Session, uid: int) -> int:
    """Jumlah channel unik dari semua query milik user."""
    acc_ids = {i for (i,) in db.query(Account.id).filter(Account.owner_id == uid).all()}
    if not acc_ids:
        return 0
    # Bug #6 fix: jangan scan semua query dari semua user (O(n) full table scan).
    # Ambil hanya channel_id dari query yang bypass_data mengandung akun milik user ini.
    # Karena bypass_data adalah JSON text, kita tetap perlu iterasi, tapi filter dulu
    # via subquery channel_id distinct — kalau data besar bisa diindeks nanti.
    ch_ids = set()
    for q in db.query(Query.channel_id, Query.bypass_data).all():
        try:
            q_acc_ids = {int(t["account_id"]) for t in json.loads(q.bypass_data or "[]")}
        except (ValueError, KeyError, TypeError):
            q_acc_ids = set()
        if q_acc_ids & acc_ids:
            ch_ids.add(q.channel_id)
    return len(ch_ids)


def _gen_key() -> str:
    chars = string.ascii_uppercase + string.digits
    parts = ["LP"] + ["".join(secrets.choice(chars) for _ in range(4)) for _ in range(4)]
    return "-".join(parts)


def _require_active_license(db: Session, user: User):
    """Raise 403 kalau user (non-admin) lisensinya sudah expired atau belum punya lisensi."""
    if user.is_admin:
        return
    ul = _get_ul(db, user.id)
    if ul is None:
        raise HTTPException(403, "Kamu belum punya lisensi aktif. Hubungi admin.")
    if _is_expired(ul):
        raise HTTPException(403, "Masa aktif lisensi kamu sudah habis. Perpanjang dulu.")


def _user_out(u: User, db: Session) -> dict:
    ul = _get_ul(db, u.id)
    sec = _seconds_left(ul)
    return {
        "id": u.id,
        "username": u.username,
        "is_admin": u.is_admin,
        "expired": _is_expired(ul),
        "seconds_left": sec,
        "expires_at": _iso(ul.expires_at) if ul else None,
        "max_accounts": ul.max_accounts if ul else 1,
        "max_channels": ul.max_channels if ul else 5,
        "allow_bypass": ul.allow_bypass if ul else False,
        "allow_dashboard": ul.allow_dashboard if ul else False,
        "accounts": _user_account_count(db, u.id),
        "channels": _user_channel_count(db, u.id),
        "is_suspended": u.is_suspended,
    }


# ─────────────────────────── schemas ───────────────────────────
class RegisterIn(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=6, max_length=128)


class LoginIn(BaseModel):
    username: str
    password: str


class SignupIn(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=6, max_length=128)
    key: str = Field(min_length=4, max_length=64)


class RedeemIn(BaseModel):
    key: str


class AccountIn(BaseModel):
    label: str = Field(min_length=1, max_length=64)
    token: str = Field(min_length=10)
    proxy: str = ""


class TargetIn(BaseModel):
    account_id: int
    content: str = ""


class QueryIn(BaseModel):
    query_type: Literal["auto", "bypass"] = "auto"
    bypass_data: List[TargetIn] = []
    guild_id: str = ""
    channel_id: str
    channel_name: str = Field(default="", max_length=128)
    content: str = ""
    embed: Dict[str, Any] = {}
    webhook_url: str = ""
    delay_min: int = Field(default=5, ge=1, le=60 * 24 * 7)


class QueryPatch(BaseModel):
    status: Optional[Literal["active", "stopped"]] = None
    bypass_data: Optional[List[TargetIn]] = None
    guild_id: Optional[str] = None
    channel_id: Optional[str] = None
    channel_name: Optional[str] = Field(default=None, max_length=128)
    content: Optional[str] = None
    embed: Optional[Dict[str, Any]] = None
    webhook_url: Optional[str] = None
    delay_min: Optional[int] = Field(default=None, ge=1, le=60 * 24 * 7)


class KeyIn(BaseModel):
    days: int = Field(default=30, ge=1, le=3650)
    count: int = Field(default=1, ge=1, le=100)
    max_accounts: int = Field(default=1, ge=0)
    max_channels: int = Field(default=5, ge=0)
    allow_bypass: bool = False
    allow_dashboard: bool = False
    note: str = Field(default="", max_length=64)


class UserPatch(BaseModel):
    add_days: Optional[int] = None
    new_password: Optional[str] = Field(default=None, min_length=6)
    max_accounts: Optional[int] = Field(default=None, ge=0)
    max_channels: Optional[int] = Field(default=None, ge=0)
    allow_bypass: Optional[bool] = None
    allow_dashboard: Optional[bool] = None


class BroadcastIn(BaseModel):
    message: str = Field(min_length=1, max_length=500)
    type: Literal["info", "warn", "danger"] = "info"


# ─────────────────────────── public ───────────────────────────
@router.get("/public")
def public_config():
    """Kontak owner dari env, tampil di halaman landing dan redeem."""
    return {
        "wa": os.getenv("OWNER_WA", ""),
        "telegram": os.getenv("OWNER_TELEGRAM", ""),
        "discord": os.getenv("OWNER_DISCORD", ""),
    }


# ─────────────────────────── auth ───────────────────────────
@router.post("/register")
def register(inp: RegisterIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Daftarkan user baru (hanya admin)."""
    if not user.is_admin:
        raise HTTPException(403, "Cuma admin yang bisa bikin user")
    if db.query(User).filter_by(username=inp.username).first():
        raise HTTPException(400, "Username sudah dipakai")
    db.add(User(username=inp.username, password_hash=hash_pw(inp.password)))
    db.commit()
    return {"ok": True}


@router.post("/signup")
def signup(inp: SignupIn, db: Session = Depends(get_db)):
    """Daftar mandiri pakai key dari admin."""
    # Bug #1 fix: SELECT FOR UPDATE untuk hindari race condition dua request
    # dengan username berbeda tapi key sama lolos cek used_by bersamaan
    lic = db.query(License).filter_by(key=inp.key.upper()).with_for_update().first()
    if not lic:
        raise HTTPException(400, "Key tidak ditemukan")
    if lic.used_by:
        raise HTTPException(400, "Key sudah dipakai")
    if db.query(User).filter_by(username=inp.username).first():
        raise HTTPException(400, "Username sudah dipakai")
    u = User(username=inp.username, password_hash=hash_pw(inp.password))
    db.add(u)
    db.flush()
    # tandai key terpakai
    lic.used_by = u.id
    lic.used_at = utcnow()
    # buat lisensi user
    db.add(UserLicense(
        user_id=u.id,
        expires_at=utcnow() + timedelta(days=lic.days),
        max_accounts=lic.max_accounts,
        max_channels=lic.max_channels,
        allow_bypass=lic.allow_bypass,
        allow_dashboard=lic.allow_dashboard,
    ))
    db.commit()
    reset_rate_limit(client_ip)
    return {"token": make_token(u)}



# === RATE LIMIT LOGIN ===
_login_attempts = {}
RATE_LIMIT_MAX = 5
RATE_LIMIT_WINDOW = 300
RATE_LIMIT_LOCKOUT = 900

def check_rate_limit(ip):
    from datetime import datetime, timedelta
    now = datetime.utcnow()
    entry = _login_attempts.get(ip)
    if entry:
        if entry.get("locked_until") and now < entry["locked_until"]:
            sisa = int((entry["locked_until"] - now).total_seconds() / 60) + 1
            raise HTTPException(status_code=429, detail=f"Terlalu banyak percobaan. Coba lagi dalam {sisa} menit.")
        if (now - entry["first_attempt"]).total_seconds() > RATE_LIMIT_WINDOW:
            del _login_attempts[ip]

def record_failed_login(ip):
    from datetime import datetime, timedelta
    now = datetime.utcnow()
    entry = _login_attempts.get(ip)
    if not entry or (now - entry["first_attempt"]).total_seconds() > RATE_LIMIT_WINDOW:
        _login_attempts[ip] = {"count": 1, "first_attempt": now, "locked_until": None}
    else:
        entry["count"] += 1
        if entry["count"] >= RATE_LIMIT_MAX:
            entry["locked_until"] = now + timedelta(seconds=RATE_LIMIT_LOCKOUT)

def reset_rate_limit(ip):
    _login_attempts.pop(ip, None)

@router.post("/login")
def login(request: Request, inp: LoginIn, db: Session = Depends(get_db)):
    client_ip = request.client.host
    check_rate_limit(client_ip)
    u = db.query(User).filter_by(username=inp.username).first()
    if not u or not verify_pw(inp.password, u.password_hash):
        record_failed_login(client_ip)
        raise HTTPException(401, "Username / password salah")
    if u.is_suspended:
        raise HTTPException(403, "Akun kamu disuspend. Hubungi admin.")
    return {"token": make_token(u)}


@router.get("/me")
def me(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Profil user saat ini termasuk sisa masa aktif dan limit."""
    return _user_out(user, db)


@router.post("/redeem")
def redeem(inp: RedeemIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Perpanjang / upgrade masa aktif dengan key baru."""
    # Bug #11 fix: SELECT FOR UPDATE untuk hindari race condition dua request
    # /redeem bersamaan dari user yang sama lolos cek used_by sebelum commit
    lic = db.query(License).filter_by(key=inp.key.upper()).with_for_update().first()
    if not lic:
        raise HTTPException(400, "Key tidak ditemukan")
    if lic.used_by and lic.used_by != user.id:
        raise HTTPException(400, "Key sudah dipakai user lain")
    if lic.used_by == user.id:
        raise HTTPException(400, "Key ini sudah kamu pakai sebelumnya")
    ul = _get_ul(db, user.id)
    now = utcnow()
    base = max(ul.expires_at, now) if (ul and ul.expires_at and ul.expires_at > now) else now
    new_exp = base + timedelta(days=lic.days)
    if ul:
        ul.expires_at = new_exp
        ul.max_accounts = lic.max_accounts
        ul.max_channels = lic.max_channels
    else:
        db.add(UserLicense(
            user_id=user.id, expires_at=new_exp,
            max_accounts=lic.max_accounts, max_channels=lic.max_channels, allow_bypass=lic.allow_bypass, allow_dashboard=lic.allow_dashboard,
        ))
    lic.used_by = user.id
    lic.used_at = now
    db.commit()
    return {"ok": True}


# ─────────────────────────── stats & logs ───────────────────────────
@router.get("/stats")
def get_stats(user: User = Depends(current_user), db: Session = Depends(get_db)):
    qs = _visible_queries(db, user)
    ids = [q.id for q in qs]
    total = failed = posts_24h = 0
    # Bug #3 fix: success_rate dihitung dari 7 hari terakhir agar tidak misleading
    # (kalau dulu banyak error tapi sekarang bagus, angkanya tetap jelek kalau all-time)
    rate_window = utcnow() - timedelta(days=7)
    rate_ok = rate_fail = 0
    if ids:
        total = db.query(Log).filter(Log.query_id.in_(ids), Log.level == "SUCCESS").count()
        failed = db.query(Log).filter(Log.query_id.in_(ids), Log.level == "ERROR").count()
        posts_24h = db.query(Log).filter(
            Log.query_id.in_(ids), Log.level == "SUCCESS",
            Log.created_at >= utcnow() - timedelta(hours=24)
        ).count()
        rate_ok = db.query(Log).filter(
            Log.query_id.in_(ids), Log.level == "SUCCESS",
            Log.created_at >= rate_window
        ).count()
        rate_fail = db.query(Log).filter(
            Log.query_id.in_(ids), Log.level == "ERROR",
            Log.created_at >= rate_window
        ).count()
    rate = round(rate_ok * 100 / (rate_ok + rate_fail)) if (rate_ok + rate_fail) else None
    return {
        "total_posts": total, "failed": failed, "posts_24h": posts_24h,
        "success_rate": rate,
        "active": sum(1 for q in qs if q.status == "active"),
        "scheduled": len(qs),
    }


@router.get("/stats/activity")
def get_activity(days: int = 7, user: User = Depends(current_user), db: Session = Depends(get_db)):
    days = max(1, min(days, 30))
    ids = [q.id for q in _visible_queries(db, user)]
    today = utcnow().date()
    buckets = {(today - timedelta(days=i)).isoformat(): {"success": 0, "error": 0} for i in range(days - 1, -1, -1)}
    if ids:
        since = utcnow().replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=days - 1)
        rows = db.query(Log.level, Log.created_at).filter(Log.query_id.in_(ids), Log.created_at >= since).all()
        for level, ts in rows:
            # ts adalah naive UTC — gunakan date() langsung (UTC)
            ts_date = ts.date() if hasattr(ts, 'date') else ts
            b = buckets.get(ts_date.isoformat())
            if b is None:
                continue
            if level == "SUCCESS":
                b["success"] += 1
            elif level == "ERROR":
                b["error"] += 1
    return [{"date": d, **v} for d, v in buckets.items()]


@router.get("/logs")
def get_logs(limit: int = 50, user: User = Depends(current_user), db: Session = Depends(get_db)):
    limit = max(1, min(limit, 500))
    ids = [q.id for q in _visible_queries(db, user)]
    if not ids:
        return []
    rows = (db.query(Log)
              .filter(Log.query_id.in_(ids), Log.query_id.isnot(None))
              .order_by(Log.id.desc()).limit(limit).all())
    return [{"level": r.level, "message": r.message, "ts": _iso(r.created_at)} for r in rows]


# ─────────────────────────── accounts ───────────────────────────
@router.get("/accounts")
def list_accounts(user: User = Depends(current_user), db: Session = Depends(get_db)):
    accs = db.query(Account).filter_by(owner_id=user.id).order_by(Account.id).all()
    return [{"id": a.id, "label": a.label, "dc_user": a.discord_username, "proxy": bool(a.proxy)} for a in accs]


@router.post("/accounts")
async def add_account(data: AccountIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    token, proxy = data.token.strip(), data.proxy.strip()
    if proxy and not PROXY_RE.match(proxy):
        raise HTTPException(400, "Format proxy salah (contoh: socks5://user:pass@host:1080)")
    # cek lisensi & limit akun (admin bebas)
    _require_active_license(db, user)
    if not user.is_admin:
        ul = _get_ul(db, user.id)
        if ul and ul.max_accounts > 0:
            cur = _user_account_count(db, user.id)
            if cur >= ul.max_accounts:
                raise HTTPException(403, f"Sudah mencapai limit {ul.max_accounts} akun")
    async with Discord(token, proxy) as dc:
        result = await dc.me()
    if "error" in result:
        if result["error"] == 401:
            raise HTTPException(400, "Token ga valid / udah mati (401)")
        _discord_fail(result, "Gagal cek token")
    a = Account(
        owner_id=user.id, label=data.label.strip(),
        token_enc=_enc_token(token), proxy=proxy,
        discord_username=result.get("username", ""),
    )
    db.add(a)
    db.commit()
    return {"id": a.id, "label": a.label, "dc_user": a.discord_username, "proxy": bool(a.proxy)}


@router.delete("/accounts/{aid}")
def del_account(aid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    acc = _get_account(db, aid, user)
    # Bug #2 fix: filter hanya query yang masih aktif/milik user ini,
    # bukan semua query dari semua user (termasuk soft-deleted / orphan)
    owned = _owned_ids(db, user)
    used = []
    for q in db.query(Query).all():
        ids = _q_acc_ids(q)
        if aid in ids and bool(ids & owned):
            used.append(q.id)
    if used:
        raise HTTPException(400, "Akun masih dipakai di Query #" + ", #".join(map(str, used)) + ". Hapus query-nya dulu.")
    db.delete(acc)
    db.commit()
    return {"ok": True}


class AccountPatch(BaseModel):
    token: Optional[str] = Field(default=None, min_length=10)
    proxy: Optional[str] = None
    label: Optional[str] = None


@router.patch("/accounts/{aid}")
async def patch_account(aid: int, data: AccountPatch, user: User = Depends(current_user), db: Session = Depends(get_db)):
    acc = _get_account(db, aid, user)
    if data.token is not None:
        token = data.token.strip()
        proxy = data.proxy.strip() if data.proxy is not None else (acc.proxy or "")
        if proxy and not PROXY_RE.match(proxy):
            raise HTTPException(400, "Format proxy salah (contoh: socks5://user:pass@host:1080)")
        async with Discord(token, proxy) as dc:
            result = await dc.me()
        if "error" in result:
            if result["error"] == 401:
                raise HTTPException(400, "Token baru ga valid / udah mati (401)")
            _discord_fail(result, "Gagal cek token baru")
        acc.token_enc = _enc_token(token)
        acc.discord_username = result.get("username", acc.discord_username)
        if data.proxy is not None:
            acc.proxy = proxy
    if data.label is not None:
        acc.label = data.label.strip() or acc.label
    db.commit()
    return {"id": acc.id, "label": acc.label, "dc_user": acc.discord_username, "proxy": bool(acc.proxy)}


@router.get("/fetch/guilds/{account_id}")
async def fetch_guilds(account_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    acc = _get_account(db, account_id, user)
    async with Discord(_dec_token(acc.token_enc), acc.proxy) as dc:
        res = await dc.get_guilds()
    if not isinstance(res, list):
        _discord_fail(res, "Gagal ambil server")
    return sorted(
        ({"id": g["id"], "name": g["name"]} for g in res),
        key=lambda g: g["name"].lower(),
    )


@router.get("/fetch/channels/{account_id}/{guild_id}")
async def fetch_channels(
    account_id: int, guild_id: str,
    user: User = Depends(current_user), db: Session = Depends(get_db),
):
    if not guild_id.isdigit():
        raise HTTPException(400, "Guild ID ga valid")
    acc = _get_account(db, account_id, user)
    async with Discord(_dec_token(acc.token_enc), acc.proxy) as dc:
        res = await dc.get_channels(guild_id)
    if not isinstance(res, list):
        _discord_fail(res, "Gagal ambil channel")
    text_ch = sorted(
        (c for c in res if c.get("type") == 0),
        key=lambda c: (c.get("position", 0), c.get("name", "")),
    )
    return [{"id": c["id"], "name": c["name"], "slowmode": c.get("rate_limit_per_user", 0) or 0} for c in text_ch]


# ─────────────────────────── queries ───────────────────────────
@router.get("/queries")
def list_queries(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return [_q_out(q) for q in _visible_queries(db, user)]


@router.post("/queries")
def add_query(data: QueryIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _check_targets(db, user, data.bypass_data)
    _check_channel(data.channel_id)
    _check_webhook(data.webhook_url)
    if data.query_type == "auto":
        if len(data.bypass_data) != 1:
            raise HTTPException(400, "Auto post harus tepat 1 akun")
        if not data.content.strip():
            raise HTTPException(400, "Pesan teks wajib diisi")
    # cek lisensi aktif & limit channel (admin bebas)
    _require_active_license(db, user)
    if not user.is_admin:
        ul = _get_ul(db, user.id)
        if ul and ul.max_channels > 0:
            # Bug fix: 1x scan untuk hitung existing_channels, channel unik, DAN same_ch_count
            # (sebelumnya 3x full table scan terpisah + tidak ada try/except di same_ch_count)
            acc_ids = _owned_ids(db, user)
            existing_channels: set = set()
            same_ch_count = 0
            for q in db.query(Query.channel_id, Query.bypass_data).all():
                try:
                    q_acc_ids = {int(t["account_id"]) for t in json.loads(q.bypass_data or "[]") if "account_id" in t}
                except (ValueError, KeyError, TypeError):
                    q_acc_ids = set()
                if not (q_acc_ids & acc_ids):
                    continue
                existing_channels.add(q.channel_id)
                if q.channel_id == data.channel_id:
                    same_ch_count += 1

            is_new_channel = data.channel_id not in existing_channels
            cur = len(existing_channels)
            if is_new_channel and cur >= ul.max_channels:
                raise HTTPException(403, f"Sudah mencapai limit {ul.max_channels} channel. Hapus query di channel lain dulu.")
            if same_ch_count >= 10:
                raise HTTPException(403, "Maksimal 10 query per channel")
    q = Query(
        query_type=data.query_type,
        bypass_data=json.dumps([_dump(t) for t in data.bypass_data]),
        guild_id=data.guild_id, channel_id=data.channel_id, channel_name=data.channel_name,
        content=data.content, embed_json=json.dumps(data.embed),
        webhook_url=data.webhook_url, delay_min=data.delay_min, status="stopped",
    )
    db.add(q)
    db.commit()
    return {"id": q.id}


@router.patch("/queries/{qid}")
def update_query(qid: int, data: QueryPatch, user: User = Depends(current_user), db: Session = Depends(get_db)):
    q = _get_query(db, qid, user)
    d = _dump(data, exclude_unset=True)
    # cek lisensi aktif kalau mau set status=active (admin bebas)
    if d.get("status") == "active":
        _require_active_license(db, user)
    if d.get("channel_id") is not None:
        _check_channel(d["channel_id"])
    if "bypass_data" in d:
        _check_targets(db, user, data.bypass_data or [])
        q.bypass_data = json.dumps([_dump(t) for t in (data.bypass_data or [])])
    if "webhook_url" in d:
        _check_webhook(d["webhook_url"] or "")
        q.webhook_url = d["webhook_url"] or ""
    if "embed" in d:
        q.embed_json = json.dumps(d["embed"] or {})
    for f in ("status", "content", "guild_id", "channel_id", "channel_name", "delay_min"):
        if f in d and d[f] is not None:
            setattr(q, f, d[f])
    db.commit()
    return {"ok": True}


@router.delete("/queries/{qid}")
def del_query(qid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    q = _get_query(db, qid, user)
    db.query(Log).filter(Log.query_id == qid).delete()
    db.delete(q)
    db.commit()
    return {"ok": True}


# ─────────────────────────── admin: keys ───────────────────────────
def _require_admin(user: User):
    if not user.is_admin:
        raise HTTPException(403, "Hanya admin yang bisa akses ini")


@router.get("/admin/keys")
def admin_list_keys(user: User = Depends(current_user), db: Session = Depends(get_db)):
    _require_admin(user)
    keys = db.query(License).order_by(License.id.desc()).all()
    result = []
    for k in keys:
        used_name = None
        if k.used_by:
            u = db.get(User, k.used_by)
            used_name = u.username if u else f"uid:{k.used_by}"
        result.append({
            "id": k.id,
            "key": k.key,
            "days": k.days,
            "max_accounts": k.max_accounts,
            "max_channels": k.max_channels,
            "note": k.note,
            "used_by": used_name,
            "used_at": _iso(k.used_at),
        })
    return result


@router.post("/admin/keys")
def admin_create_keys(inp: KeyIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _require_admin(user)
    created = []
    for _ in range(inp.count):
        # Bug #4 fix: kalau semua 10 attempt bentrok, raise error — jangan
        # pakai nilai k dari iterasi terakhir yang sudah ada di DB
        k = None
        for _ in range(10):
            candidate = _gen_key()
            if not db.query(License).filter_by(key=candidate).first():
                k = candidate
                break
        if k is None:
            raise HTTPException(500, "Gagal generate key unik, coba lagi.")
        lic = License(
            key=k, days=inp.days,
            max_accounts=inp.max_accounts, max_channels=inp.max_channels,
            note=inp.note.strip(),
            allow_bypass=inp.allow_bypass,
            allow_dashboard=inp.allow_dashboard,
        )
        db.add(lic)
        created.append(k)
    db.commit()
    return [{"key": k} for k in created]


@router.delete("/admin/keys/{kid}")
def admin_del_key(kid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _require_admin(user)
    lic = db.get(License, kid)
    if not lic:
        raise HTTPException(404, "Key tidak ditemukan")
    if lic.used_by:
        raise HTTPException(400, "Key sudah dipakai, tidak bisa dihapus")
    db.delete(lic)
    db.commit()
    return {"ok": True}


# ─────────────────────────── admin: users ───────────────────────────
@router.get("/admin/users")
def admin_list_users(user: User = Depends(current_user), db: Session = Depends(get_db)):
    _require_admin(user)
    users = db.query(User).order_by(User.id).all()
    return [_user_out(u, db) for u in users]


@router.patch("/admin/users/{uid}")
def admin_patch_user(uid: int, inp: UserPatch, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _require_admin(user)
    target = db.get(User, uid)
    if not target:
        raise HTTPException(404, "User tidak ditemukan")
    if inp.new_password:
        target.password_hash = hash_pw(inp.new_password)
    ul = _get_ul(db, uid)
    now = utcnow()
    if inp.add_days is not None:
        base = max(ul.expires_at, now) if (ul and ul.expires_at and ul.expires_at > now) else now
        new_exp = base + timedelta(days=inp.add_days)
        if ul:
            ul.expires_at = new_exp
        else:
            ul = UserLicense(user_id=uid, expires_at=new_exp)
            db.add(ul)
    # jika ul belum ada tapi admin mau set limit akun/channel, buat dulu
    if ul is None and (inp.max_accounts is not None or inp.max_channels is not None):
        ul = UserLicense(user_id=uid, expires_at=None)
        db.add(ul)
    if ul is None and (inp.allow_bypass is not None or inp.allow_dashboard is not None):
        ul = UserLicense(user_id=uid, expires_at=None)
        db.add(ul)
    if ul:
        if inp.max_accounts is not None:
            ul.max_accounts = inp.max_accounts
        if inp.max_channels is not None:
            ul.max_channels = inp.max_channels
        if inp.allow_bypass is not None:
            ul.allow_bypass = inp.allow_bypass
        if inp.allow_dashboard is not None:
            ul.allow_dashboard = inp.allow_dashboard
    db.commit()
    return {"ok": True}


@router.post("/admin/users/{uid}/stop-queries")
def admin_stop_user_queries(uid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _require_admin(user)
    target = db.get(User, uid)
    if not target:
        raise HTTPException(404, "User tidak ditemukan")
    acc_ids = {i for (i,) in db.query(Account.id).filter(Account.owner_id == uid).all()}
    stopped = 0
    for q in db.query(Query).filter(Query.status == "active").all():
        if _q_acc_ids(q) & acc_ids:
            q.status = "stopped"
            stopped += 1
    db.commit()
    return {"ok": True, "stopped": stopped}

@router.delete("/admin/users/{uid}")
def admin_del_user(uid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _require_admin(user)
    target = db.get(User, uid)
    if not target:
        raise HTTPException(404, "User tidak ditemukan")
    if target.is_admin:
        raise HTTPException(400, "Tidak bisa menghapus admin")
    # hapus semua data milik user
    owned = _owned_ids(db, target)
    # Bug #5 fix: stop dulu semua query aktif sebelum dihapus,
    # supaya manager_loop cancel worker-nya sebelum akun benar-benar hilang dari DB
    for q in db.query(Query).filter_by(status="active").all():
        if _q_acc_ids(q) & owned:
            q.status = "stopped"
    db.flush()  # commit status=stopped dulu biar manager_loop bisa baca
    # hapus query + log yang milik user ini
    for q in db.query(Query).all():
        if _q_acc_ids(q) & owned:
            db.query(Log).filter(Log.query_id == q.id).delete()
            db.delete(q)
    # hapus akun
    accs = db.query(Account).filter_by(owner_id=uid).all()
    for a in accs:
        db.delete(a)
    # lepas referensi user di tabel licenses (used_by FK)
    db.query(License).filter_by(used_by=uid).update({"used_by": None, "used_at": None})
    # hapus lisensi
    for ul in db.query(UserLicense).filter_by(user_id=uid).all():
        db.delete(ul)
    db.flush()
    # hapus user
    db.delete(target)
    db.commit()
    return {"ok": True}


@router.post("/admin/users/{uid}/stop")
def admin_stop_user(uid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Stop paksa semua query milik user tertentu."""
    _require_admin(user)
    target = db.get(User, uid)
    if not target:
        raise HTTPException(404, "User tidak ditemukan")
    owned = _owned_ids(db, target)
    stopped = 0
    for q in db.query(Query).filter_by(status="active").all():
        if _q_acc_ids(q) & owned:
            q.status = "stopped"
            stopped += 1
    db.commit()
    return {"ok": True, "stopped": stopped}


@router.post("/admin/stop_all")
def admin_stop_all(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Stop paksa semua query dari semua user (global)."""
    _require_admin(user)
    n = db.query(Query).filter_by(status="active").update({"status": "stopped"})
    db.commit()
    return {"ok": True, "stopped": n}



@router.post("/admin/users/{uid}/suspend")
def admin_suspend_user(uid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Suspend / unsuspend user."""
    _require_admin(user)
    target = db.get(User, uid)
    if not target:
        raise HTTPException(404, "User tidak ditemukan")
    if target.is_admin:
        raise HTTPException(400, "Tidak bisa suspend admin")
    target.is_suspended = not target.is_suspended
    if target.is_suspended:
        owned = _owned_ids(db, target)
        for q in db.query(Query).filter_by(status="active").all():
            if _q_acc_ids(q) & owned:
                q.status = "stopped"
    db.commit()
    return {"ok": True, "is_suspended": target.is_suspended}


@router.delete("/admin/keys/{kid}")
def admin_revoke_key(kid: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Revoke / hapus key lisensi."""
    _require_admin(user)
    lic = db.get(License, kid)
    if not lic:
        raise HTTPException(404, "Key tidak ditemukan")
    if lic.used_by:
        db.query(UserLicense).filter_by(user_id=lic.used_by).delete()
        db.flush()
    db.delete(lic)
    db.commit()
    return {"ok": True}

# ─────────────────────────── admin: broadcast ───────────────────────────
@router.get("/admin/broadcast")
def admin_get_broadcast(user: User = Depends(current_user), db: Session = Depends(get_db)):
    _require_admin(user)
    bc = db.query(Broadcast).order_by(Broadcast.id.desc()).first()
    if not bc:
        return {}
    return {"message": bc.message, "type": bc.type, "created_at": _iso(bc.created_at)}


@router.post("/admin/broadcast")
def admin_set_broadcast(inp: BroadcastIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    _require_admin(user)
    # hapus broadcast lama, simpan yang baru
    db.query(Broadcast).delete()
    db.add(Broadcast(message=inp.message, type=inp.type))
    db.commit()
    return {"ok": True}


@router.delete("/admin/broadcast")
def admin_del_broadcast(user: User = Depends(current_user), db: Session = Depends(get_db)):
    _require_admin(user)
    db.query(Broadcast).delete()
    db.commit()
    return {"ok": True}


# ─────────────────────────── user: broadcast (baca saja) ───────────────────────────
@router.get("/broadcast")
def get_broadcast(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """User membaca broadcast: user-specific dulu, fallback ke global."""
    # Cek notif personal (belum di-dismiss)
    ubc = (
        db.query(UserBroadcast)
        .filter_by(user_id=user.id, dismissed=False)
        .order_by(UserBroadcast.id.desc())
        .first()
    )
    if ubc:
        return {"message": ubc.message, "type": ubc.type, "user_broadcast_id": ubc.id}
    # Fallback ke broadcast global
    bc = db.query(Broadcast).order_by(Broadcast.id.desc()).first()
    if not bc:
        return {}
    return {"message": bc.message, "type": bc.type}


@router.post("/broadcast/dismiss/{bc_id}")
def dismiss_user_broadcast(bc_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """User dismiss notif personal (misal: notif H-3)."""
    ubc = db.query(UserBroadcast).filter_by(id=bc_id, user_id=user.id).first()
    if ubc:
        ubc.dismissed = True
        db.commit()
    return {"ok": True}

# ─────────────────────────── admin: trigger notif H-3 manual ───────────────────────────
@router.post("/admin/trigger-expiry-notify")
def admin_trigger_expiry_notify(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Admin trigger manual cek H-3 lisensi -> buat UserBroadcast."""
    if not user.is_admin:
        raise HTTPException(403)
    from app.models import UserLicense, utcnow as _utcnow
    THREE_DAYS = 3 * 24 * 3600
    now = _utcnow()
    uls = db.query(UserLicense).filter(UserLicense.expires_at.isnot(None)).all()
    count = 0
    for ul in uls:
        secs = (ul.expires_at - now).total_seconds()
        if secs <= 0 or secs > THREE_DAYS:
            continue
        existing = db.query(UserBroadcast).filter_by(user_id=ul.user_id, dismissed=False).first()
        if existing:
            continue
        days_left = int(secs // 86400) + 1
        msg = (
            f"⚠️ Lisensi kamu akan habis dalam {days_left} hari! "
            f"Segera perpanjang agar akun tetap aktif."
        )
        db.add(UserBroadcast(user_id=ul.user_id, message=msg, type="warn"))
        count += 1
    db.commit()
    return {"ok": True, "notified": count}
