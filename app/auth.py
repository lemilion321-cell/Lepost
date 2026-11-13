from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from app.models import User, get_db
from config import SECRET, TOKEN_EXP_MIN

pwd = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")
oauth = OAuth2PasswordBearer(tokenUrl="/api/login")

# itsdangerous serializer buat token login
serializer = URLSafeTimedSerializer(SECRET, salt="auth-token")


def hash_pw(p: str) -> str:
    return pwd.hash(p)


def verify_pw(p: str, h: str) -> bool:
    try:
        return pwd.verify(p, h)
    except Exception:
        return False


def make_token(user: User) -> str:
    return serializer.dumps({"uid": user.id, "u": user.username})


def current_user(token: str = Depends(oauth), db: Session = Depends(get_db)) -> User:
    try:
        data = serializer.loads(token, max_age=TOKEN_EXP_MIN * 60)
        uid = int(data["uid"])
    except (BadSignature, SignatureExpired, KeyError, TypeError, ValueError):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid token")

    user = db.get(User, uid)
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "user not found")
    return user
