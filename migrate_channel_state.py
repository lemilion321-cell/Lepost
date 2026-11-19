"""
Migration script untuk update ChannelState dari per-channel ke per-account+channel
Run sekali setelah deploy: python migrate_channel_state.py
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))

from sqlalchemy import text
from app.models import engine, SessionLocal

def migrate():
    print("🔄 Migrasi ChannelState: per-channel → per-account+channel")
    
    with engine.connect() as conn:
        # 1. Rename tabel lama
        try:
            conn.execute(text("ALTER TABLE channel_state RENAME TO channel_state_old"))
            conn.commit()
            print("✅ Backup tabel lama → channel_state_old")
        except Exception as e:
            print(f"⚠️  Tabel lama sudah di-rename atau tidak ada: {e}")
            conn.rollback()
        
        # 2. Buat tabel baru dengan struktur baru
        try:
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS channel_state (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_id INTEGER NOT NULL,
                    channel_id VARCHAR(32) NOT NULL,
                    next_allowed_at DATETIME,
                    UNIQUE(account_id, channel_id)
                )
            """))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_channel_state_account_id ON channel_state (account_id)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_channel_state_channel_id ON channel_state (channel_id)"))
            conn.commit()
            print("✅ Tabel baru channel_state dibuat dengan struktur per-account+channel")
        except Exception as e:
            print(f"❌ Gagal buat tabel baru: {e}")
            conn.rollback()
            return
        
        # 3. Drop tabel lama (data lama tidak perlu dimigrate karena logika berubah total)
        try:
            conn.execute(text("DROP TABLE IF EXISTS channel_state_old"))
            conn.commit()
            print("✅ Tabel lama dihapus")
        except Exception as e:
            print(f"⚠️  Gagal hapus tabel lama: {e}")
            conn.rollback()
    
    print("✅ Migrasi selesai! Anti-dobel sekarang per-account+channel, bukan per-channel global.")

if __name__ == "__main__":
    migrate()
