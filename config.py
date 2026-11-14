import os
import secrets
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DB_URL = os.getenv("DB_URL", f"sqlite:///{BASE_DIR / 'data.db'}")


def _load_secret() -> str:
    """Pakai JWT_SECRET dari env; kalau ga ada, bikin random sekali lalu simpan ke file
    (biar ga pake secret default yang bisa ditebak orang)."""
    env = os.getenv("JWT_SECRET")
    if env:
        return env
    f = BASE_DIR / ".secret"
    try:
        if f.exists():
            s = f.read_text().strip()
            if s:
                return s
        s = secrets.token_hex(32)
        f.write_text(s)
        try:
            f.chmod(0o600)
        except OSError:
            pass
        return s
    except OSError:
        # filesystem read-only: secret random per-start (token login hangus tiap restart)
        return secrets.token_hex(32)


SECRET = _load_secret()
TOKEN_EXP_MIN = 60 * 24
DISCORD_API = "https://discord.com/api/v10"
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

import base64, hashlib
TOKEN_ENC_SECRET = os.getenv("TOKEN_ENC_SECRET", SECRET)
_key_bytes = hashlib.sha256(TOKEN_ENC_SECRET.encode()).digest()
TOKEN_ENC_KEY: bytes = base64.urlsafe_b64encode(_key_bytes)
