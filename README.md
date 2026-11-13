# LePost — Final (Merged)

Gabungan UI baru (`ui_baru`) + Backend lengkap (`source_lama`).

## Struktur

```
lepost-final/
├── app/
│   ├── api.py          ← MERGED: endpoint lama + /me /signup /redeem /admin/* /broadcast
│   ├── auth.py
│   ├── discord_client.py
│   ├── models.py
│   ├── worker.py
│   └── __init__.py
├── static/
│   ├── index.html      ← UI baru (landing elegan + app dashboard)
│   ├── app.js          ← MERGED: disambungkan ke semua endpoint baru, grafik fixed
│   └── app.css         ← UI baru (tidak diubah)
├── config.py
├── main.py
├── run.py
└── requirements.txt
```

## Install & Jalankan

```bash
pip install -r requirements.txt
python run.py
# buka http://localhost:8000
```

## Variabel Lingkungan (opsional)

| Env              | Default    | Keterangan                              |
|------------------|------------|-----------------------------------------|
| `ADMIN_PASSWORD` | `admin123` | Password admin awal (ganti sebelum prod)|
| `DB_URL`         | SQLite     | URL database (SQLite / PostgreSQL)      |
| `JWT_SECRET`     | auto       | Secret token JWT                        |
| `OWNER_WA`       | -          | Nomor WA owner (tanpa +), tampil landing|
| `OWNER_TELEGRAM` | -          | Username Telegram owner                 |
| `OWNER_DISCORD`  | -          | Discord tag owner                       |

## Alur daftar user baru

1. **Admin** buat key di Panel Admin > tab Key
2. **User** buka halaman, klik "Daftar pakai key", isi username/password/key
3. Masa aktif langsung aktif sesuai key

## Endpoint baru yang ditambahkan

| Method | Path                       | Siapa      | Fungsi                        |
|--------|----------------------------|------------|-------------------------------|
| GET    | `/api/public`              | Publik     | Kontak owner dari env         |
| POST   | `/api/signup`              | Publik     | Daftar dengan key             |
| GET    | `/api/me`                  | User login | Profil + masa aktif + limit   |
| POST   | `/api/redeem`              | User login | Perpanjang / upgrade key      |
| GET    | `/api/broadcast`           | User login | Baca broadcast aktif dari admin|
| GET    | `/api/admin/keys`          | Admin      | Daftar semua key              |
| POST   | `/api/admin/keys`          | Admin      | Generate key baru             |
| DELETE | `/api/admin/keys/{id}`     | Admin      | Hapus key belum terpakai      |
| GET    | `/api/admin/users`         | Admin      | Daftar semua user             |
| PATCH  | `/api/admin/users/{id}`    | Admin      | Edit masa aktif / password    |
| DELETE | `/api/admin/users/{id}`    | Admin      | Hapus user                    |
| POST   | `/api/admin/users/{id}/stop`| Admin     | Stop semua query user         |
| POST   | `/api/admin/stop_all`      | Admin      | Stop semua query global       |
| GET    | `/api/admin/broadcast`     | Admin      | Lihat broadcast aktif         |
| POST   | `/api/admin/broadcast`     | Admin      | Set broadcast baru            |
| DELETE | `/api/admin/broadcast`     | Admin      | Hapus broadcast               |
