import asyncio
import json
import logging
import random
import time
from datetime import datetime, timedelta

import aiohttp
from sqlalchemy import or_

from cryptography.fernet import Fernet

from app.discord_client import Discord
from app.models import Account, Query, Log, User, UserLicense, SessionLocal, utcnow, ChannelState
from config import TOKEN_ENC_KEY

_fernet = Fernet(TOKEN_ENC_KEY)


def _dec_token(enc: str) -> str:
    """Dekripsi token dari DB. Fallback ke plaintext untuk data lama (migrasi transparan)."""
    try:
        return _fernet.decrypt(enc.encode()).decode()
    except Exception:
        import logging as _lg
        _lg.getLogger("autopost").warning("SECURITY: token plaintext fallback dipakai di worker - re-save token akun!")
        return enc

log = logging.getLogger("autopost.worker")

MIN_DELAY_SEC = 5.0
RETRY_SLEEP_MAX = 900.0  # detik maksimal nunggu di tempat waktu kena slowmode


def _initial_wait(q_id: int, delay_sec: float) -> float:
    # FIX-429: sisa cooldown sejak last_run
    db = SessionLocal()
    try:
        q = db.get(Query, q_id)
        if not q or not q.last_run:
            return 0.0
        return max(0.0, delay_sec - (utcnow() - q.last_run).total_seconds())
    except Exception:
        return 0.0
    finally:
        db.close()


def _channel_db_cooldown_remaining(ch_id) -> float:
    """Sisa cooldown channel di DB (detik). 0 = sudah boleh kirim."""
    cid = str(ch_id)
    db = SessionLocal()
    try:
        row = db.get(ChannelState, cid)
        if row is None or row.next_allowed_at is None:
            return 0.0
        remaining = (row.next_allowed_at - utcnow()).total_seconds()
        return max(0.0, remaining)
    except Exception:
        return 0.0
    finally:
        db.close()


def _claim_channel(ch_id, gap_sec: float) -> bool:
    """Ambil hak kirim ke channel ini. Atomik (lewat DB), jadi aman walau ada
    lebih dari satu query/proses yang mau kirim ke channel yang sama.
    True = boleh kirim sekarang, False = channel baru saja dapat post."""
    cid = str(ch_id)
    db = SessionLocal()
    try:
        now = utcnow()
        until = now + timedelta(seconds=max(float(gap_sec), MIN_DELAY_SEC))
        row = db.get(ChannelState, cid)
        if row is None:
            db.add(ChannelState(channel_id=cid, next_allowed_at=until))
            try:
                db.commit()
                return True
            except Exception:
                db.rollback()
                return False  # proses lain barusan bikin baris yang sama
        res = (
            db.query(ChannelState)
            .filter(
                ChannelState.channel_id == cid,
                or_(ChannelState.next_allowed_at.is_(None), ChannelState.next_allowed_at <= now),
            )
            .update({ChannelState.next_allowed_at: until}, synchronize_session=False)
        )
        db.commit()
        return res == 1
    except Exception:
        db.rollback()
        log.warning("Gagal claim channel %s, kirim tetap dilanjutkan", cid, exc_info=True)
        return True
    finally:
        db.close()


def _set_channel_cooldown(ch_id, seconds: float):
    """Tandai channel ini tidak boleh dikirimi selama N detik (mis. abis kena 429)."""
    cid = str(ch_id)
    db = SessionLocal()
    try:
        until = utcnow() + timedelta(seconds=max(float(seconds), 1.0))
        row = db.get(ChannelState, cid)
        if row is None:
            db.add(ChannelState(channel_id=cid, next_allowed_at=until))
        else:
            row.next_allowed_at = until
        db.commit()
    except Exception:
        db.rollback()
    finally:
        db.close()


async def _channel_slowmode(dc: Discord, ch_id) -> float:
    """Slowmode asli channel dari Discord (detik). 0 kalau gagal dibaca."""
    res = await dc.get_channel(ch_id)
    if not isinstance(res, dict) or "error" in res:
        return 0.0
    try:
        return float(res.get("rate_limit_per_user") or 0)
    except (TypeError, ValueError):
        return 0.0


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
            "typing_sim": bool(getattr(q, "typing_sim", False)),
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


_INVALID_TOKEN = "INVALID_TOKEN"  # sentinel return value dari _validate_token


async def _validate_token(acc: dict, qid: int):
    """Cek token masih valid sebelum mulai posting.
    Return True kalau OK, False kalau error sementara (network/429),
    'INVALID_TOKEN' kalau token benar-benar tidak valid (401/403)."""
    try:
        async with Discord(acc["token"], acc["proxy"]) as dc:
            res = await dc.me()
        if "error" in res:
            code = res.get("error")
            msg = res.get("message", "")
            if code == 401:
                _log(qid, "ERROR", f"[{acc['label']}] Token tidak valid (401). Query dihentikan otomatis. Ganti token lewat menu Akun → Edit Token.")
                return _INVALID_TOKEN
            elif code == 403:
                _log(qid, "ERROR", f"[{acc['label']}] Token diblokir (403). Query dihentikan otomatis. Ganti token lewat menu Akun → Edit Token.")
                return _INVALID_TOKEN
            elif code == 429:
                retry = res.get("message", "")
                _log(qid, "ERROR", f"[{acc['label']}] Rate limit saat validasi token (429). {retry}. Coba lagi nanti.")
            elif code == "NETWORK":
                _log(qid, "ERROR", f"[{acc['label']}] Gagal konek ke Discord saat validasi: {msg}. Cek proxy/internet.")
            else:
                _log(qid, "ERROR", f"[{acc['label']}] Validasi token gagal ({code}): {msg}")
            return False
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
        slow = await _channel_slowmode(dc, cfg["channel_id"])
        gap = max(slow + 2.0, MIN_DELAY_SEC)

        # Kalau DB bilang masih cooldown, cek Discord langsung —
        # mungkin slowmode-nya sudah selesai duluan (mis. ganti akun / server reset).
        db_remaining = _channel_db_cooldown_remaining(cfg["channel_id"])
        if db_remaining > 0 and slow == 0.0:
            # Discord bilang ga ada slowmode → reset cooldown DB, boleh kirim sekarang
            _set_channel_cooldown(cfg["channel_id"], 0)
            log.info("Query %s: cooldown DB direset (Discord sudah clear), langsung kirim ke #%s", qid, chan)
        elif db_remaining > 0 and db_remaining > slow + 2.0:
            # Sisa cooldown DB lebih panjang dari slowmode Discord asli → pakai slowmode Discord
            _set_channel_cooldown(cfg["channel_id"], slow + 2.0)
            log.info("Query %s: cooldown DB dipercepat sesuai slowmode Discord (%ds) untuk #%s", qid, int(slow), chan)

        # Anti-dobel: 1 channel cuma boleh dapat 1 post per window slowmode,
        # walau ada query/akun/proses lain yang mau kirim di saat yang sama.
        if not _claim_channel(cfg["channel_id"], gap):
            _log(qid, "INFO", f"#{chan} baru saja dapat post (slowmode {int(slow)}s). Giliran ini dilewati biar ga kena 429.")
            return False

        log.info("Query %s: mencoba kirim ke #%s (slow=%ss)", qid, chan, int(slow))
        res = await dc.send(cfg["channel_id"], txt, cfg["embed"], typing_sim=cfg.get("typing_sim", False))
        log.info("Query %s: hasil kirim -> %s", qid, res.get("error", "OK") if isinstance(res, dict) else res)

        # Kena slowmode: tunggu sesuai retry_after lalu kirim ulang sekali,
        # daripada slot posting-nya kebuang percuma (post baru 6 jam lagi).
        if isinstance(res, dict) and res.get("error") == 429:
            wait = float(res.get("retry_after") or 5) + 1.0
            _set_channel_cooldown(cfg["channel_id"], wait)
            if wait <= RETRY_SLEEP_MAX:
                _log(qid, "INFO", f"[{acc['label']}] Kena slowmode di #{chan}, nunggu {wait:.0f}s lalu kirim ulang.")
                await asyncio.sleep(wait)
                res = await dc.send(cfg["channel_id"], txt, cfg["embed"])

    if "error" in res:
        code = res.get("error")
        detail = res.get("message") or ""
        if code == 401:
            _log(qid, "ERROR", f"[{acc['label']}] Token tidak valid (401). Ganti token akun lewat menu Akun → Edit Token.")
            return _INVALID_TOKEN
        elif code == 429:
            retry_after = float(res.get("retry_after") or 5)
            _set_channel_cooldown(cfg["channel_id"], retry_after)
            _log(qid, "ERROR", f"[{acc['label']}] Rate limit (429): {detail}. Channel #{chan} di-cooldown {retry_after:.0f}s.")
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
    last_token_hash: dict = {}  # {account_id: hash(token)} buat deteksi token berubah

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
                    last_token_hash = {}
                last_status = cfg["status"]
                await asyncio.sleep(5)
                continue
            last_status = "active"

            # Deteksi token berubah saat query sedang aktif (misal user ganti token)
            # Kalau ada token yang berubah, reset validated & first supaya langsung
            # re-validasi dan posting tanpa nunggu cooldown akun lama
            targets = cfg.get("targets", [])
            token_changed = False
            for t in targets:
                aid = t.get("account_id")
                acc = _load_acc(aid)
                if not acc:
                    continue
                cur_hash = hash(acc["token"])
                if last_token_hash.get(aid) is not None and last_token_hash[aid] != cur_hash:
                    token_changed = True
                last_token_hash[aid] = cur_hash
            if token_changed:
                log.info("Query %s: token berubah, re-validasi & reset cooldown", q_id)
                validated = False
                first = True

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
                        if ok == _INVALID_TOKEN or not ok:
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

            wait_sec = _initial_wait(q_id, cfg["delay_sec"]) if first else cfg["delay_sec"]
            if wait_sec > 0:
                # Tidur dalam potongan kecil supaya bisa deteksi reset cooldown / stop
                elapsed = 0.0
                TICK = 10.0
                while elapsed < wait_sec:
                    # Kalau cooldown DB di-reset manual, langsung skip sisa tunggu
                    if _channel_db_cooldown_remaining(cfg["channel_id"]) == 0.0 and elapsed > 0:
                        log.info("Query %s: cooldown direset manual, skip sisa tunggu %.0fs", q_id, wait_sec - elapsed)
                        break
                    cfg = _load_cfg(q_id)
                    if cfg is None:
                        return
                    if cfg["status"] != "active":
                        break
                    sleep_chunk = min(TICK, wait_sec - elapsed)
                    await asyncio.sleep(sleep_chunk)
                    elapsed += sleep_chunk
                cfg = _load_cfg(q_id)
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
            if attempted == _INVALID_TOKEN:
                db = SessionLocal()
                try:
                    q = db.get(Query, q_id)
                    if q:
                        q.status = "stopped"
                        db.commit()
                finally:
                    db.close()
                _log(q_id, "INFO", "Query dihentikan otomatis karena token tidak valid.")
                return
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
# ─────────────────────────── Gateway Manager ───────────────────────────
from app.discord_client import GatewayClient

_gateways: dict = {}  # {acc_id: GatewayClient}

def _load_acc_presence(acc_id: int):
    db = SessionLocal()
    try:
        a = db.get(Account, acc_id)
        if not a:
            return None
        return {
            "token": _dec_token(a.token_enc),
            "proxy": a.proxy or "",
            "status": a.discord_status or "online",
            "custom_text": a.discord_custom_text or "",
            "custom_emoji": a.discord_custom_emoji or "",
            "rpc_json": a.rpc_json or "{}",
            "keep_online": a.keep_online or 0,
        }
    finally:
        db.close()

def _build_activities(rpc_json: str) -> list:
    try:
        rpc = json.loads(rpc_json)
        if not rpc or not rpc.get("enabled"):
            return []
        act = {
            "type": rpc.get("type", 0),
            "name": rpc.get("name", ""),
        }
        if rpc.get("app_id"):
            act["application_id"] = rpc["app_id"]
        if rpc.get("details"):
            act["details"] = rpc["details"]
        if rpc.get("state"):
            act["state"] = rpc["state"]
        assets = {}
        if rpc.get("large_image"):
            assets["large_image"] = rpc["large_image"]
        if rpc.get("large_text"):
            assets["large_text"] = rpc["large_text"]
        if rpc.get("small_image"):
            assets["small_image"] = rpc["small_image"]
        if rpc.get("small_text"):
            assets["small_text"] = rpc["small_text"]
        if assets:
            act["assets"] = assets
        buttons = []
        if rpc.get("btn1_label") and rpc.get("btn1_url"):
            buttons.append({"label": rpc["btn1_label"], "url": rpc["btn1_url"]})
        if rpc.get("btn2_label") and rpc.get("btn2_url"):
            buttons.append({"label": rpc["btn2_label"], "url": rpc["btn2_url"]})
        if buttons:
            act["buttons"] = buttons
        if rpc.get("elapsed"):
            act["timestamps"] = {"start": int(time.time()) - rpc.get("elapsed_sec", 0)}
        return [act]
    except Exception:
        return []

async def start_gateway(acc_id: int):
    await stop_gateway(acc_id)
    data = _load_acc_presence(acc_id)
    if not data:
        return
    gw = GatewayClient(data["token"], data["proxy"])
    activities = _build_activities(data["rpc_json"])
    gw.update_presence(data["status"], data["custom_text"], data["custom_emoji"], activities)
    if data["keep_online"]:
        _gateways[acc_id] = gw
        await gw.start()
        log.info("Gateway started (24/7) for acc_id=%s", acc_id)
    else:
        await gw.start_and_wait_ready(timeout=15)
        await asyncio.sleep(2)
        await gw.stop()
        log.info("Gateway presence sent (one-shot) for acc_id=%s", acc_id)

async def stop_gateway(acc_id: int):
    gw = _gateways.pop(acc_id, None)
    if gw:
        await gw.stop()
        log.info("Gateway stopped for acc_id=%s", acc_id)

async def restart_gateway(acc_id: int):
    await start_gateway(acc_id)

async def start_all_gateways():
    db = SessionLocal()
    try:
        accs = db.query(Account).filter(Account.keep_online == 1).all()
        for a in accs:
            await start_gateway(a.id)
    finally:
        db.close()
