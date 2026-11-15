import asyncio
import json
import logging
import random
from datetime import datetime

import aiohttp

from cryptography.fernet import Fernet

from app.discord_client import Discord
from app.models import Account, Query, Log, User, UserLicense, SessionLocal, utcnow
from config import TOKEN_ENC_KEY

_fernet = Fernet(TOKEN_ENC_KEY)


def _dec_token(enc: str) -> str:
    """Dekripsi token dari DB. Fallback ke plaintext untuk data lama (migrasi transparan)."""
    try:
        return _fernet.decrypt(enc.encode()).decode()
    except Exception:
        return enc

log = logging.getLogger("autopost.worker")

MIN_DELAY_SEC = 5.0


def _log(qid, level: str, msg: str):
    db = SessionLocal()
    try:
        db.add(Log(query_id=qid, level=level, message=str(msg)[:1000]))
        db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()


def _load_cfg(q_id: int):
    """Snapshot config query (session pendek, ga ditahan selama sleep). None = query udah dihapus."""
    db = SessionLocal()
    try:
        q = db.get(Query, q_id)
        if not q:
            return None
        try:
            targets = json.loads(q.bypass_data or "[]")
        except ValueError:
            targets = []
        try:
            embed = json.loads(q.embed_json or "{}")
        except ValueError:
            embed = {}
        n = max(len(targets), 1) if q.query_type == "bypass" else 1
        import random as _random
        base_delay = max(float(q.delay_min or 1) * 60.0 / n, MIN_DELAY_SEC)
        rand_sec = float(getattr(q, 'delay_random_min', 0) or 0) * 60.0
        delay = base_delay + _random.uniform(0, rand_sec) if rand_sec > 0 else base_delay
        return {
            "id": q.id, "type": q.query_type, "status": q.status, "targets": targets,
            "content": q.content or "", "embed": embed if isinstance(embed, dict) else {},
            "webhook": q.webhook_url or "", "channel_id": q.channel_id,
            "channel_name": (q.channel_name or "").lstrip("#"), "delay_sec": delay,
        }
    finally:
        db.close()


def _load_acc(acc_id):
    db = SessionLocal()
    try:
        a = db.get(Account, acc_id)
        if not a:
            return None
        return {"label": a.label, "token": _dec_token(a.token_enc), "proxy": a.proxy or "", "user": a.discord_username}
    finally:
        db.close()


def _touch(q_id: int):
    db = SessionLocal()
    try:
        q = db.get(Query, q_id)
        if q:
            q.last_run = utcnow()
            db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()


def _owner_license_expired(q_id: int) -> bool:
    """Cek apakah lisensi owner query sudah expired.
    Return True kalau expired. Admin selalu False (tidak pernah expired).
    Kalau ada exception DB, return False supaya worker tidak berhenti sembarangan.
    """
    db = SessionLocal()
    try:
        q = db.get(Query, q_id)
        if not q:
            return False  # query hilang, worker berhenti sendiri via _load_cfg
        try:
            targets = json.loads(q.bypass_data or "[]")
        except ValueError:
            targets = []
        if not targets:
            return False
        acc = db.get(Account, targets[0].get("account_id"))
        if not acc:
            return False
        owner = db.get(User, acc.owner_id)
        if not owner:
            return False
        if owner.is_admin:
            return False
        ul = db.query(UserLicense).filter_by(user_id=owner.id).first()
        if ul is None:
            return True   # belum punya lisensi
        if ul.expires_at is None:
            return False  # tanpa batas
        return utcnow() >= ul.expires_at
    except Exception:
        return False
    finally:
        db.close()


async def _validate_token(acc: dict, qid: int) -> bool:
    """Cek token masih valid sebelum mulai posting. Return False kalau gagal."""
    try:
        async with Discord(acc["token"], acc["proxy"]) as dc:
            res = await dc.me()
        if "error" in res:
            code = res.get("error")
            msg = res.get("message", "")
            if code == 401:
                _log(qid, "ERROR", f"[{acc['label']}] Token tidak valid (401 Unauthorized). Ganti token akun ini lewat menu Akun → Edit Token.")
            elif code == 403:
                _log(qid, "ERROR", f"[{acc['label']}] Token diblokir / akses ditolak (403). Ganti token akun.")
            elif code == 429:
                retry = res.get("message", "")
                _log(qid, "ERROR", f"[{acc['label']}] Rate limit saat validasi token (429). {retry}. Coba lagi nanti.")
            elif code == "NETWORK":
                _log(qid, "ERROR", f"[{acc['label']}] Gagal konek ke Discord saat validasi: {msg}. Cek proxy/internet.")
            else:
                _log(qid, "ERROR", f"[{acc['label']}] Validasi token gagal ({code}): {msg}")
            return False
        username = res.get("username", acc["user"])
        return True
    except asyncio.CancelledError:
        raise
    except Exception as e:
        _log(qid, "ERROR", f"[{acc['label']}] Error saat validasi token: {e}")
        return False


async def _post_once(cfg: dict, turn: int) -> bool:
    """Kirim 1 pesan sesuai giliran. Return True kalau attempt dilakukan, False kalau skip (akun hilang/no targets)."""
    qid = cfg["id"]
    targets = cfg["targets"]
    if not targets:
        _log(qid, "ERROR", "Query ga punya akun. Edit query ini dulu.")
        return False

    if cfg["type"] == "bypass":
        target = targets[turn % len(targets)]
        txt = target.get("content", "")
    else:
        target = targets[0]
        txt = cfg["content"]
    txt = str(txt or "").replace("{date}", datetime.now().strftime("%Y-%m-%d"))

    acc = _load_acc(target.get("account_id"))
    if not acc:
        _log(qid, "ERROR", f"Akun ID {target.get('account_id')} ga ketemu (kehapus?). Giliran di-skip.")
        return False

    chan = cfg["channel_name"] or cfg["channel_id"]
    log.info("Query %s: giliran %s (@%s) -> #%s", qid, acc["label"], acc["user"], chan)

    async with Discord(acc["token"], acc["proxy"]) as dc:
        res = await dc.send(cfg["channel_id"], txt, cfg["embed"])

    if "error" in res:
        code = res.get("error")
        detail = res.get("message") or ""
        if code == 401:
            _log(qid, "ERROR", f"[{acc['label']}] Token tidak valid (401). Ganti token akun lewat menu Akun → Edit Token.")
        elif code == 429:
            _log(qid, "ERROR", f"[{acc['label']}] Rate limit (429): {detail}. Worker akan coba lagi setelah delay.")
        elif code == "NETWORK":
            _log(qid, "ERROR", f"[{acc['label']}] Gagal kirim (network error): {detail}")
        else:
            _log(qid, "ERROR", f"[{acc['label']}] Gagal ({code}): {detail}"[:1000])
        # return True: attempt sudah dilakukan ke Discord (meski gagal), giliran tetap maju
        return True

    _log(qid, "SUCCESS", f"[{acc['label']}] Sukses ke #{chan}")

    if cfg["webhook"]:
        try:
            now_str = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
            preview = txt[:200] + ("..." if len(txt) > 200 else "")
            safe_preview = preview.replace("```", "'''")
            safe_label = acc['label'].replace("`", "'")
            embed_payload = {
                "embeds": [{
                    "title": "📨 Auto Post Report",
                    "color": 0x27ae60,
                    "fields": [
                        {"name": "✅ Status",   "value": "Sukses",                  "inline": True},
                        {"name": "👤 Akun",     "value": f"`{safe_label}`",         "inline": True},
                        {"name": "📢 Channel",  "value": f"`#{chan}`",               "inline": True},
                        {"name": "📝 Pesan",    "value": f"```{safe_preview}```",   "inline": False},
                    ],
                    "footer": {"text": "LePost • Auto Poster"},
                    "timestamp": now_str,
                }]
            }
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as s:
                async with s.post(cfg["webhook"], json=embed_payload) as r:
                    if r.status >= 400:
                        _log(qid, "ERROR", f"Webhook tembusan gagal ({r.status})")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            _log(qid, "ERROR", f"Webhook tembusan error: {e}")

    return True


async def run_query_loop(q_id: int):
    log.info("Worker nyala buat Query ID %s", q_id)
    first = True   # post pertama langsung jalan, berikutnya nunggu delay
    turn = 0       # giliran akun (mode bypass)
    validated = False  # sudah validasi token?
    last_status = "active"  # tracking status sebelumnya buat re-validasi

    while True:
        try:
            cfg = _load_cfg(q_id)
            if cfg is None:
                return  # query dihapus -> worker berhenti
            if cfg["status"] != "active":
                # Bug #3 fix: reset validated DAN turn saat distop, supaya re-validasi
                # pas distart lagi, dan giliran akun mulai dari 0 lagi (bukan sisa turn
                # tinggi dari sebelumnya yang bisa skip akun tertentu karena % len berubah)
                if last_status == "active":
                    validated = False
                    first = True
                    turn = 0
                last_status = cfg["status"]
                await asyncio.sleep(5)
                continue
            last_status = "active"

            # Validasi token sekali saat pertama kali aktif
            if not validated:
                targets = cfg.get("targets", [])
                if targets:
                    all_ok = True
                    checked = set()
                    for t in targets:
                        aid = t.get("account_id")
                        if aid in checked:
                            continue
                        checked.add(aid)
                        acc = _load_acc(aid)
                        if not acc:
                            _log(q_id, "ERROR", f"Akun ID {aid} ga ketemu (kehapus?)")
                            all_ok = False
                            continue
                        ok = await _validate_token(acc, q_id)
                        if not ok:
                            all_ok = False
                    if not all_ok:
                        # Stop query kalau ada token invalid
                        db = SessionLocal()
                        try:
                            q = db.get(Query, q_id)
                            if q:
                                q.status = "stopped"
                                db.commit()
                        finally:
                            db.close()
                        _log(q_id, "INFO", "Query dihentikan otomatis karena ada token tidak valid.")
                        return
                # Set validated=True SETELAH validasi selesai tanpa exception
                validated = True

            if not first:
                await asyncio.sleep(cfg["delay_sec"])
                cfg = _load_cfg(q_id)  # baca ulang: bisa aja diedit/distop pas nunggu
                if cfg is None:
                    return
                if cfg["status"] != "active":
                    continue
            first = False

            # Cek lisensi owner setiap giliran — kalau expired, stop query otomatis
            if _owner_license_expired(q_id):
                db = SessionLocal()
                try:
                    q = db.get(Query, q_id)
                    if q and q.status == "active":
                        q.status = "stopped"
                        db.commit()
                except Exception:
                    db.rollback()
                finally:
                    db.close()
                _log(q_id, "INFO", "Query dihentikan otomatis: masa aktif lisensi habis.")
                return

            attempted = await _post_once(cfg, turn)
            # Bug fix: turn hanya naik kalau benar-benar attempt kirim pesan
            # (bukan skip karena akun hilang), supaya giliran akun tidak melompat
            if attempted:
                turn += 1
            _touch(q_id)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.exception("Worker error (query %s)", q_id)
            _log(q_id, "ERROR", f"Worker error: {e}")
            await asyncio.sleep(10)
