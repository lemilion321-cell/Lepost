from app.models import engine
from sqlalchemy import text, inspect

def migrate():
    insp = inspect(engine)
    if "accounts" not in insp.get_table_names():
        print("Tabel accounts tidak ditemukan!")
        return
    cols = {c["name"] for c in insp.get_columns("accounts")}
    with engine.begin() as con:
        if "discord_status" not in cols:
            con.execute(text("ALTER TABLE accounts ADD COLUMN discord_status VARCHAR(16) NOT NULL DEFAULT 'online'"))
            print("+ discord_status")
        if "discord_custom_text" not in cols:
            con.execute(text("ALTER TABLE accounts ADD COLUMN discord_custom_text VARCHAR(128) NOT NULL DEFAULT ''"))
            print("+ discord_custom_text")
        if "discord_custom_emoji" not in cols:
            con.execute(text("ALTER TABLE accounts ADD COLUMN discord_custom_emoji VARCHAR(64) NOT NULL DEFAULT ''"))
            print("+ discord_custom_emoji")
        if "rpc_json" not in cols:
            con.execute(text("ALTER TABLE accounts ADD COLUMN rpc_json TEXT NOT NULL DEFAULT '{}'"))
            print("+ rpc_json")
        if "keep_online" not in cols:
            con.execute(text("ALTER TABLE accounts ADD COLUMN keep_online INTEGER NOT NULL DEFAULT 0"))
            print("+ keep_online")
    print("Migrasi selesai.")

if __name__ == "__main__":
    migrate()
