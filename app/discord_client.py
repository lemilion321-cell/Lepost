import asyncio
import json
import logging
from typing import Optional
from urllib.parse import quote

import aiohttp
from aiohttp_socks import ProxyConnector

from config import DISCORD_API

log = logging.getLogger("autopost.discord")

MAX_RETRY_429 = 3
RETRY_INLINE_MAX = 60.0     # FIX-429
RETRY_AFTER_CAP = 21600.0   # FIX-429: slowmode maks 6 jam

_HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "discord/1.0.9026 Chrome/108.0.5359.215 Electron/22.0.0 Safari/537.36"
    ),
    "X-Super-Properties": (
        "eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiRGlzY29yZCBDbGllbnQiLCJkZXZpY2UiOiJEZXNrdG9wIiwic3lzdGVtX2xvY2FsZSI6ImVuLVVTIiwiY2xpZW50X3ZlcnNpb24iOiIxLjAuOTAyNiIsIm9zX3ZlcnNpb24iOiIxMC4wLjE5MDQ1Iiwib3NfYXJjaCI6Ing2NCIsImFwcF92ZXJzaW9uIjoiMS4wLjkwMjYifQ=="
    ),
}


def _color_to_int(value, default: int = 0x8B5CF6) -> int:
    try:
        s = str(value or "").strip().lstrip("#")
        return int(s, 16) if s else default
    except (TypeError, ValueError):
        return default


class Discord:
    def __init__(self, token: str, proxy: str = ""):
        self.token = (token or "").strip()
        self.proxy = (proxy or "").strip()
        self.session: Optional[aiohttp.ClientSession] = None

    async def __aenter__(self):
        connector = ProxyConnector.from_url(self.proxy) if self.proxy else None
        self.session = aiohttp.ClientSession(
            connector=connector,
            headers={**_HEADERS, "Authorization": self.token},
            timeout=aiohttp.ClientTimeout(total=20),
        )
        return self

    async def __aexit__(self, *a):
        if self.session:
            await self.session.close()

    async def _req(self, method: str, path: str, _retry: int = 0, **kw):
        """Return JSON Discord kalau sukses, atau {"error": status, "message": str, "body": str}."""
        try:
            async with self.session.request(method, DISCORD_API + path, **kw) as r:
                txt = await r.text()

                if r.status == 429:
                    wait = 5.0
                    try:
                        wait = float(json.loads(txt).get("retry_after", r.headers.get("Retry-After", 5)))
                    except Exception:
                        try:
                            wait = float(r.headers.get("Retry-After", 5))
                        except (TypeError, ValueError):
                            pass
                    wait = min(max(wait, 1.0), RETRY_AFTER_CAP)
                    if wait <= RETRY_INLINE_MAX and _retry < MAX_RETRY_429:
                        await asyncio.sleep(wait + 0.5)
                        return await self._req(method, path, _retry + 1, **kw)
                    # Habis retry — kembalikan error dengan retry_after supaya worker bisa sleep
                    msg = txt[:200]
                    try:
                        msg = json.loads(txt).get("message", msg)
                    except Exception:
                        pass
                    log.warning("Discord API %s %s -> 429 (habis retry): %s", method, path, msg)
                    return {"error": 429, "message": msg, "retry_after": wait, "body": txt}

                if r.status >= 400:
                    msg = txt[:200]
                    try:
                        msg = json.loads(txt).get("message", msg)
                    except Exception:
                        pass
                    log.warning("Discord API %s %s -> %s: %s", method, path, r.status, msg)
                    return {"error": r.status, "message": msg, "body": txt}

                return json.loads(txt) if txt else {}
        except asyncio.CancelledError:
            raise
        except Exception as e:  # network / proxy / timeout / json
            log.warning("Network error %s %s: %s", method, path, e)
            return {"error": "NETWORK", "message": str(e) or e.__class__.__name__, "body": str(e)}

    async def me(self):
        return await self._req("GET", "/users/@me")

    async def set_custom_status(self, text: str = "", emoji: str = ""):
        """Simpan custom status permanen via user settings (persisten walau gateway disconnect)."""
        payload = {"custom_status": None}
        if text or emoji:
            payload["custom_status"] = {"text": text or None}
            if emoji:
                payload["custom_status"]["emoji_name"] = emoji
        return await self._req("PATCH", "/users/@me/settings", json=payload)

    async def get_guilds(self):
        return await self._req("GET", "/users/@me/guilds")

    async def get_channels(self, gid):
        return await self._req("GET", f"/guilds/{gid}/channels")

    async def get_channel(self, ch):
        """Detail 1 channel (buat baca slowmode asli: rate_limit_per_user)."""
        return await self._req("GET", f"/channels/{ch}")

    async def trigger_typing(self, ch: str):
        """Kirim sinyal 'sedang mengetik...' ke channel. Berlaku 10 detik di Discord."""
        await self._req("POST", f"/channels/{ch}/typing")

    async def send(self, ch: str, content: str, embed: Optional[dict] = None, react: str = "", typing_sim: bool = False):
        payload: dict = {}
        if content:
            payload["content"] = content

        if embed and embed.get("title"):
            e = {
                "title": str(embed.get("title")),
                "description": str(embed.get("desc", "")),
                "color": _color_to_int(embed.get("color")),
            }
            if embed.get("image"):
                e["image"] = {"url": str(embed["image"])}
            payload["embeds"] = [e]

        if not payload:
            return {"error": "EMPTY", "message": "Pesan kosong (isi teks atau embed)", "body": ""}

        # Typing simulation: kirim sinyal mengetik, lalu delay sesuai panjang teks
        if typing_sim and content:
            # ~50 karakter/detik, min 1.5s, max 10s
            typing_delay = min(max(len(content) / 50.0, 1.5), 10.0)
            await self._req("POST", f"/channels/{ch}/typing")
            await asyncio.sleep(typing_delay)

        res = await self._req("POST", f"/channels/{ch}/messages", json=payload)

        if "error" not in res and react and res.get("id"):
            await self._req("PUT", f"/channels/{ch}/messages/{res['id']}/reactions/{quote(react)}/@me")
        return res


import time

GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json"

class GatewayClient:
    def __init__(self, token: str, proxy: str = ""):
        self.token = token.strip()
        self.proxy = proxy.strip()
        self.ws = None
        self.session_id = None
        self.sequence = None
        self._heartbeat_interval = None
        self._running = False
        self._task = None
        self.status = "online"
        self.custom_text = ""
        self.custom_emoji = ""
        self.activities = []

    async def start(self):
        self._running = True
        self._task = asyncio.create_task(self._run())

    async def start_and_wait_ready(self, timeout=15):
        self._ready = asyncio.Event()
        self._running = True
        self._task = asyncio.create_task(self._run())
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            log.warning("Gateway ready timeout")

    async def stop(self):
        self._running = False
        if self.ws:
            await self.ws.close()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    def update_presence(self, status, custom_text, custom_emoji, activities):
        self.status = status
        self.custom_text = custom_text
        self.custom_emoji = custom_emoji
        self.activities = activities

    def _build_presence(self):
        acts = list(self.activities)
        if self.custom_text or self.custom_emoji:
            custom = {"type": 4, "name": "Custom Status", "state": self.custom_text or ""}
            if self.custom_emoji:
                custom["emoji"] = {"name": self.custom_emoji}
            acts.insert(0, custom)
        return {"op": 3, "d": {"since": 0, "activities": acts, "status": self.status, "afk": False}}

    async def _run(self):
        while self._running:
            try:
                await self._connect()
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.warning("Gateway error, reconnect in 10s: %s", e)
                await asyncio.sleep(10)

    async def _connect(self):
        connector = None
        if self.proxy:
            from aiohttp_socks import ProxyConnector
            connector = ProxyConnector.from_url(self.proxy)
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9026 Chrome/108.0.5359.215 Electron/22.0.0 Safari/537.36",
            "Origin": "https://discord.com",
        }
        async with aiohttp.ClientSession(connector=connector) as session:
            async with session.ws_connect(GATEWAY_URL, headers=headers) as ws:
                self.ws = ws
                async for msg in ws:
                    if not self._running:
                        break
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        data = json.loads(msg.data)
                        await self._handle(ws, data)
                    elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                        break

    async def _handle(self, ws, data):
        op = data.get("op")
        d = data.get("d")
        s = data.get("s")
        if s:
            self.sequence = s
        if op == 10:
            self._heartbeat_interval = d["heartbeat_interval"] / 1000
            asyncio.create_task(self._heartbeat_loop(ws))
            await self._identify(ws)
        elif op == 0:
            t = data.get("t")
            if t == "READY":
                self.session_id = d.get("session_id")
                log.info("Gateway READY: %s", d.get("user", {}).get("username"))
                await asyncio.sleep(1)
                await ws.send_str(json.dumps(self._build_presence()))
                await asyncio.sleep(2)
                await ws.send_str(json.dumps(self._build_presence()))
                if hasattr(self, '_ready'):
                    self._ready.set()
                await self.send_presence()
        elif op == 1:
            await ws.send_str(json.dumps({"op": 1, "d": self.sequence}))

    async def _heartbeat_loop(self, ws):
        await asyncio.sleep(self._heartbeat_interval * 0.9)
        while self._running and not ws.closed:
            try:
                await ws.send_str(json.dumps({"op": 1, "d": self.sequence}))
                await asyncio.sleep(self._heartbeat_interval)
            except Exception:
                break

    async def _identify(self, ws):
        p = self._build_presence()["d"]
        payload = {
            "op": 2,
            "d": {
                "token": self.token,
                "capabilities": 16381,
                "properties": {
                    "os": "Windows",
                    "browser": "Discord Client",
                    "device": "Desktop",
                    "system_locale": "en-US",
                    "browser_version": "22.0.0",
                    "os_version": "10",
                },
                "presence": {
                    "status": p.get("status", "online"),
                    "since": 0,
                    "activities": p.get("activities", []),
                    "afk": False,
                },
                "compress": False,
                "client_state": {
                    "guild_versions": {},
                    "highest_last_message_id": "0",
                    "read_state_version": 0,
                    "user_guild_settings_version": -1,
                    "user_settings_version": -1,
                    "private_channels_version": "0",
                    "api_code_version": 0,
                },
            }
        }
        await ws.send_str(json.dumps(payload))

    async def send_presence(self):
        if self.ws and not self.ws.closed:
            await self.ws.send_str(json.dumps(self._build_presence()))
