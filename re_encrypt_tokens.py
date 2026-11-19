"""
Script untuk auto re-encrypt semua token plaintext di database.
Run sekali: python re_encrypt_tokens.py

Fungsi:
- Deteksi token yang masih plaintext (belum encrypted)
- Re-encrypt otomatis pakai Fernet
- Warning token plaintext akan hilang permanent
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from cryptography.fernet import Fernet
from app.models import SessionLocal, Account
from config import TOKEN_ENC_KEY

_fernet = Fernet(TOKEN_ENC_KEY)

def _is_plaintext(token_enc: str) -> bool:
    """Cek apakah token masih plaintext atau sudah encrypted."""
    try:
        # Coba decrypt, kalau berhasil berarti sudah encrypted
        _fernet.decrypt(token_enc.encode()).decode()
        return False
    except Exception:
        # Gagal decrypt = masih plaintext
        return True

def _enc_token(raw: str) -> str:
    """Enkripsi token."""
    return _fernet.encrypt(raw.encode()).decode()

def re_encrypt_all():
    print("🔐 Auto Re-Encrypt Token Plaintext\n")
    
    db = SessionLocal()
    try:
        accounts = db.query(Account).all()
        total = len(accounts)
        plaintext_count = 0
        encrypted_count = 0
        
        print(f"📊 Total akun: {total}")
        print("🔍 Scanning...\n")
        
        for acc in accounts:
            if _is_plaintext(acc.token_enc):
                plaintext_count += 1
                # Re-encrypt token plaintext
                acc.token_enc = _enc_token(acc.token_enc)
                print(f"✅ Re-encrypted: {acc.label} (ID: {acc.id})")
            else:
                encrypted_count += 1
                print(f"✓  Already encrypted: {acc.label} (ID: {acc.id})")
        
        if plaintext_count > 0:
            db.commit()
            print(f"\n🎉 SELESAI!")
            print(f"   Re-encrypted: {plaintext_count} akun")
            print(f"   Sudah encrypted sebelumnya: {encrypted_count} akun")
            print(f"\n✅ Semua token sekarang AMAN & ENCRYPTED!")
            print(f"⚠️  WARNING token plaintext akan HILANG setelah restart!")
        else:
            print(f"\n✅ Semua token sudah encrypted! Tidak perlu re-encrypt.")
    
    except Exception as e:
        db.rollback()
        print(f"\n❌ Error: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    re_encrypt_all()
