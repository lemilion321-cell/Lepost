# LePost — Catatan Diskusi & Progress

## Info Repo
- GitHub: https://github.com/lemilion321-cell/Lepost
- Branch Railway: `master`
- Production: https://www.lepost.my.id
- Stack: FastAPI + SQLAlchemy + PostgreSQL (Railway) + vanilla JS frontend

---

## Masalah Aktif

### 1. Tambah Akun Tidak Berfungsi
- **Root cause**: Ada dua `<form id="form-acc">` di HTML — satu di section accounts (hidden), satu di dalam dialog modal
- `addEventListener('submit')` hanya bind ke form pertama (yang hidden), bukan yang di dialog
- **Fix yang sudah dilakukan**: Rename form di dialog jadi `form-acc-dlg`, tambah listener terpisah
- **Status**: Sudah di-commit (`e724a41`), sudah push ke GitHub master, Railway sedang deploy

### 2. Foto Profil Akun Tidak Muncul (tampil huruf "A")
- **Root cause**: Akun lama yang sudah ada di DB tidak punya data `dc_id` dan `dc_avatar` (kolom baru, belum terisi)
- Frontend butuh `dc_id` + `dc_avatar` untuk build URL: `cdn.discordapp.com/avatars/{dc_id}/{dc_avatar}.png`
- **Fix yang sudah dilakukan**:
  - Tambah endpoint `POST /accounts/{aid}/sync-profile` — fetch ulang data Discord dan update DB
  - `renderAccountList()` auto-sync akun yang `dc_id`-nya kosong
- **Status**: Sudah di-commit (`c30f2a9`), sudah push ke GitHub master, Railway sedang deploy

### 3. Branch Railway vs GitHub Mismatch
- Railway track branch `master`, GitHub hanya punya branch `main`
- Solusi: Ubah tracked branch Railway ke `main` di Settings → Source → Branch
- **Status**: Belum diubah

---

## Fitur yang Sudah Selesai (History)

| Commit | Fitur |
|--------|-------|
| `9a468d1` | Anti dobel-post per channel + slowmode + retry 429 |
| `00570c1` | Typing simulation toggle di form |
| `b194438` | Typing simulation backend (discord_client, worker, api) |
| `171ecb2` | Cap typing delay 10s max |
| `1851acf` | Fix dc_user field di GET /accounts |
| `37fe926` | Reset Cooldown button per query |
| `1c7a4f3` | Reset CD langsung wake up sleeping worker |
| `6b7c1da` | Debug logging di worker (mencoba kirim / hasil kirim) |
| `e724a41` | Fix form tambah akun + validasi token realtime |
| `c30f2a9` | Revert warna vivid + auto-sync avatar akun lama |

---

## Pending / Belum Dikerjakan

1. **Save form data antara posts** — semua field kecuali pesan (guild, channel, akun, delay, random, typing_sim) harus tersimpan ke localStorage dan restore otomatis waktu buka "Buat Post" lagi
2. **UI countdown setelah Reset CD** — countdown visual tidak update setelah reset, masih tampil waktu lama
3. **Branch master di GitHub** — perlu dibuat supaya Railway auto-deploy berjalan

---

## Arsitektur Penting

### Token
- Disimpan encrypted (Fernet) di DB kolom `token_enc`
- Ada fallback plaintext untuk data lama
- Token Discord invalidate kalau login di device/browser lain

### Worker (app/worker.py)
- Sleep dalam chunk 10 detik, cek cooldown tiap tick
- `_channel_db_cooldown_remaining()` — cek cooldown channel dari DB
- `_post_once()` — auto-reset DB cooldown kalau Discord sudah clear (slowmode = 0)

### Channel Cooldown
- Disimpan di tabel `ChannelState` (kolom `next_allowed_at`)
- Reset manual via `POST /queries/{qid}/reset-cooldown`
- Auto-detect: kalau DB ada cooldown tapi Discord API slowmode = 0, langsung reset

### File Penting
- `app/api.py` — semua endpoint REST
- `app/worker.py` — loop auto-post background
- `app/discord_client.py` — wrapper Discord API
- `app/models.py` — SQLAlchemy models
- `static/app.js` — frontend logic
- `static/index.html` — HTML + CSS inline

---

## Cara Lanjutkan di Claude Lain

1. Upload file `point.md` ini ke Claude baru
2. Kasih akses repo: https://github.com/lemilion321-cell/Lepost
3. Bilang: "lanjutkan dari point.md"
