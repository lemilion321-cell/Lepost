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

                if r.status == 429 and _retry < MAX_RETRY_429:
                    wait = 5.0
                    try:
                        wait = float(json.loads(txt).get("retry_after", r.headers.get("Retry-After", 5)))
                    except Exception:
                        try:
                            wait = float(r.headers.get("Retry-After", 5))
                        except (TypeError, ValueError):
                            pass
                    await asyncio.sleep(min(max(wait, 1.0), 120.0) + 0.5)
                    return await self._req(method, path, _retry + 1, **kw)

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

    async def get_guilds(self):
        return await self._req("GET", "/users/@me/guilds")

    async def get_channels(self, gid):
        return await self._req("GET", f"/guilds/{gid}/channels")

    async def send(self, ch: str, content: str, embed: Optional[dict] = None, react: str = ""):
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

        res = await self._req("POST", f"/channels/{ch}/messages", json=payload)

        if "error" not in res and react and res.get("id"):
            await self._req("PUT", f"/channels/{ch}/messages/{res['id']}/reactions/{quote(react)}/@me")
        return res
