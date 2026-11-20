/* LePost — app.js (merged final)
   UI dari ui_baru, disambungkan ke api.py yang sudah lengkap.
   Perbaikan: /me, /public, /signup, /redeem, /admin/*, broadcast, grafik, undefined. */

const API = '/api';
const TABS = ['dashboard', 'posts', 'bypass', 'logs', 'accounts', 'rpc', 'admin'];
const REFRESH_MS = 10000;

const state = {
  token: localStorage.getItem('token') || '',
  me: null,
  accounts: [],
  queries: [],
  logs: [],
  logFilter: 'ALL',
  logSearch: '',
  channels: { post: [], bypass: [] },
  reqId: { post: 0, bypass: 0, ch: 0 },
  bypassRef: '',
  isAutoAll: false,
  isBypassAll: false,
  sig: {},
  loaded: {},
  bgErr: {},
  openers: {},
  contact: null,
  editEmbed: {},
  refreshTimer: null,   // id setInterval refreshCurrent, dibersihkan saat expired
  countdownTimer: null, // id setInterval tickCountdown
};

/* ───────── util ───────── */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const chn = n => (n ? '#' + String(n).replace(/^#+/, '') : '');
const fixMsg = m => String(m ?? '').replace(/#{2,}/g, '#');
const sum = arr => arr.reduce((a, b) => a + b, 0);
const pad = n => String(n).padStart(2, '0');
const setText = (el, v) => {
  const node = typeof el === 'string' ? $(el) : el;
  if (node && node.textContent !== String(v)) node.textContent = v;
};
// Bug #7 fix: JSON.stringify tidak stable untuk object dengan key urutan berbeda
// (misalnya dari Python dict yang tidak ordered). Pakai replacer yang sort key
// agar object dengan data sama tapi urutan key beda tidak trigger re-render.
function stableStringify(val) {
  if (Array.isArray(val)) return '[' + val.map(stableStringify).join(',') + ']';
  if (val !== null && typeof val === 'object') {
    const keys = Object.keys(val).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(val[k])).join(',') + '}';
  }
  return JSON.stringify(val);
}
const changed = (key, value) => {
  const s = stableStringify(value);
  if (state.sig[key] === s) return false;
  state.sig[key] = s;
  return true;
};
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

const PATHS = {
  play: '<path d="M8 5v14l11-7z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M5 6l1 14h12l1-14M10 11v6M14 11v6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M12 11.5l1.5 1.5L16 10l1.5 1.5"/>',
};
const icon = (name, cls = '') =>
  `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name] || ''}</svg>`;

function shortTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d) ? String(ts) : `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fullTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d) ? String(ts) : d.toLocaleString('sv-SE');
}
function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
  if (h) return `${h}j ${m}m`;
  if (m) return `${m}m ${pad(x)}dtk`;
  return `${x}dtk`;
}
function dayLabel(date) {
  if (!date) return '-';
  const d = new Date(date + 'T00:00:00Z');
  return isNaN(d) ? '-' : d.toLocaleDateString('id-ID', { weekday: 'short', timeZone: 'UTC' });
}
function nextOf(q) {
  if (!q) return '';
  const bypass = q.query_type === 'bypass';
  const n = Math.max((q.bypass_data || []).length, 1);
  // Bug fix: sesuaikan dengan logika worker: delay_sec = delay_min*60/n (untuk bypass)
  // delay_min sekarang = totalSM (menit penuh per siklus), worker bagi n untuk dapat jeda per akun
  const gap = Math.max((q.delay_min * 60) / (bypass ? n : 1), 5) * 1000;
  const last = q.last_run ? new Date(q.last_run).getTime() : 0;
  return last ? last + gap : '';
}

/* ───────── skeleton / empty / error ───────── */
const skeleton = n =>
  `<div class="stack" role="status" aria-label="Memuat data">${Array.from({length:n},()=>'<div class="skel" aria-hidden="true"></div>').join('')}</div>`;
const errorBlock = (title, msg) =>
  `<div class="notice" role="alert"><div><p class="notice-title">${esc(title)}</p><p class="notice-msg">${esc(msg)}</p></div><button type="button" class="btn" data-act="refresh">${icon('refresh')}Coba lagi</button></div>`;
const emptyBlock = (title, text, act, label) =>
  `<div class="empty"><span class="empty-ic" aria-hidden="true">${icon('send')}</span><h3>${esc(title)}</h3><p>${esc(text)}</p>${act?`<button type="button" class="btn btn-primary" data-act="${act}">${icon('plus')}${esc(label)}</button>`:''}</div>`;
const inlineEmpty = (title, sub) =>
  `<div class="inline-empty"><p class="ie-title">${esc(title)}</p><p class="ie-sub">${esc(sub)}</p></div>`;

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.classList.toggle('err', isErr);
  $('toast-msg').textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}
function reportBg(key, msg) {
  if (state.bgErr[key]) return;
  state.bgErr[key] = true;
  toast(msg, true);
}
const clearBg = key => { state.bgErr[key] = false; };

/* ───────── api ───────── */
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  let r;
  try {
    r = await fetch(API + path, { ...opts, headers });
  } catch {
    throw new Error('Tidak bisa terhubung ke server.');
  }
  if (r.status === 401 && path !== '/login') { logout(); throw new Error('Sesi habis, login lagi.'); }
  const txt = await r.text();
  let data = {};
  try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }
  if (!r.ok) {
    let msg = 'Terjadi kesalahan di server.';
    if (typeof data.detail === 'string') msg = data.detail;
    else if (Array.isArray(data.detail)) msg = data.detail.map(d => (d.loc ? d.loc.slice(1).join('.') + ': ' : '') + d.msg).join('; ');
    throw new Error(msg);
  }
  return data;
}

/* ───────── auth ───────── */
async function submitLogin(e) {
  e.preventDefault();
  const btn = $('login-btn'), err = $('login-err');
  err.hidden = true;
  btn.disabled = true; btn.textContent = 'Memproses...';
  try {
    const r = await api('/login', { method: 'POST', body: JSON.stringify({
      username: $('username').value.trim(), password: $('password').value,
    })});
    if (!r.token) throw new Error('Respons login tidak valid.');
    localStorage.setItem('token', r.token);
    state.token = r.token;
    const vl = document.getElementById('view-login');
    if (vl) vl.hidden = true;
    const app = document.getElementById('app');
    if (app) app.hidden = false;
    location.hash = '#dashboard';
    boot();
  } catch (ex) {
    err.textContent = 'Login gagal: ' + ex.message;
    err.hidden = false;
    $('password').focus();
  } finally {
    btn.disabled = false; btn.textContent = 'Masuk';
  }
}

function setAuthTab(tab) {
  const login = tab === 'login';
  $('login-form').hidden = !login;
  $('signup-form').hidden = login;
  document.querySelectorAll('[data-auth]').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.auth === tab)));
}

async function submitSignup(e) {
  e.preventDefault();
  const btn = $('signup-btn'), err = $('signup-err');
  err.hidden = true;
  btn.disabled = true; btn.textContent = 'Memproses...';
  try {
    const r = await api('/signup', { method: 'POST', body: JSON.stringify({
      username: $('su-username').value.trim(),
      password: $('su-password').value,
      key: $('su-key').value.trim(),
    })});
    if (!r.token) throw new Error('Respons daftar tidak valid.');
    localStorage.setItem('token', r.token);
    state.token = r.token;
    const vl = document.getElementById('view-login');
    if (vl) vl.hidden = true;
    const app = document.getElementById('app');
    if (app) app.hidden = false;
    location.hash = '#dashboard';
    boot();
  } catch (ex) {
    err.textContent = 'Daftar gagal: ' + ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = 'Daftar & Masuk';
  }
}

const CONTACT_ICONS = {
  WhatsApp: `<svg class="contact-platform-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.129.558 4.126 1.533 5.857L.057 23.857a.5.5 0 0 0 .619.633l6.19-1.63A11.95 11.95 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.861 0-3.609-.5-5.112-1.374l-.363-.214-3.76.991 1.009-3.68-.234-.381A9.943 9.943 0 0 1 2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg>`,
  Telegram: `<svg class="contact-platform-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.293 13.69l-2.981-.934c-.648-.204-.66-.648.136-.961l11.647-4.491c.54-.194 1.012.13.799.917z"/></svg>`,
  Discord: `<svg class="contact-platform-ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>`,
};

function contactHtml(c) {
  if (!c) return '<p class="hint">Kontak owner belum diatur.</p>';
  const items = [];
  if (c.wa) items.push(['WhatsApp', '+' + c.wa, `https://wa.me/${encodeURIComponent(c.wa)}`, '#25D366']);
  if (c.telegram) items.push(['Telegram', '@' + c.telegram, `https://t.me/${encodeURIComponent(c.telegram)}`, '#229ED9']);
  if (c.discord) {
    // Sanitasi: hanya izinkan URL yang sudah https:// Discord, atau bangun dari value mentah
    // Cegah javascript: / data: / vbscript: injection dari env var
    let discordUrl;
    const dRaw = String(c.discord).trim();
    if (/^https:\/\/(discord\.com|discordapp\.com|discord\.gg)\//i.test(dRaw)) {
      discordUrl = dRaw;
    } else if (dRaw.includes('/')) {
      discordUrl = `https://discord.gg/${encodeURIComponent(dRaw)}`;
    } else {
      discordUrl = `https://discord.com/users/${encodeURIComponent(dRaw)}`;
    }
    items.push(['Discord', c.discord, discordUrl, '#5865F2']);
  }
  if (!items.length) return '<p class="hint">Kontak owner belum diatur.</p>';
  return items.map(([n, v, href, color]) =>
    `<a class="contact-item contact-item-${n.toLowerCase()}" href="${esc(href)}" target="_blank" rel="noopener">
      <span class="contact-platform-icon" style="--platform-color:${color}" aria-hidden="true">${CONTACT_ICONS[n] || ''}</span>
      <div class="contact-item-body"><b>${n}</b><span>${esc(v)}</span></div>
      <svg class="contact-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
    </a>`
  ).join('');
}

async function loadContact() {
  try {
    const c = await api('/public');
    state.contact = c;
  } catch {
    // contact optional, abaikan error
  }
}

function logout() {
  state.token = '';
  localStorage.removeItem('token');
  location.reload();
}

/* ───────── lisensi ───────── */
function fmtLeft(sec) {
  if (sec == null) return 'Tanpa batas';
  if (sec <= 0) return 'Habis';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600);
  return d > 0 ? `${d} hari ${h} jam` : `${h} jam ${Math.floor((sec % 3600) / 60)} menit`;
}
const lim = n => (n ? String(n) : '∞');

function renderMe() {
  const m = state.me; if (!m) return;
  const b = $('hdr-lic');
  if (m.is_admin) {
    if (b) b.hidden = true;
    const navAdmin = $('nav-admin');
    if (navAdmin) navAdmin.hidden = false;
    const navAdminDiv = $('nav-admin-divider');
    if (navAdminDiv) navAdminDiv.hidden = false;
    return;
  }
  if (!b) return;
  b.hidden = false;
  const soon = m.seconds_left != null && m.seconds_left < 3 * 86400;
  b.className = 'pill ' + (m.expired ? 'pill-off' : soon ? 'pill-warn' : 'pill-on');
  b.textContent = m.expired ? 'Masa aktif habis' : fmtLeft(m.seconds_left);
}

function openLicense(opener) {
  const m = state.me; if (!m) return;
  const row = (k, v) =>
    `<div class="acc-row"><div class="acc-text"><p class="acc-meta">${k}</p><p class="acc-name">${v}</p></div></div>`;
  $('lic-info').innerHTML = m.is_admin
    ? row('Akun', esc(m.username) + ' (admin)')
    : row('Akun', esc(m.username))
      + row('Sisa masa aktif', m.expired ? '<span style="color:#ffb4b4">Habis</span>' : esc(fmtLeft(m.seconds_left)))
      + row('Akun Discord', `${m.accounts} / ${lim(m.max_accounts)}`)
      + row('Query', `${m.queries} / ${lim(m.max_queries)}`);
  $('lic-contact').innerHTML = state.contact
    ? '<h3 class="sub-h">Beli / perpanjang key</h3>' + contactHtml(state.contact)
    : '';
  openDialog('dlg-lic', opener);
}

async function submitRedeem(e) {
  e.preventDefault();
  const key = $('redeem-key').value.trim();
  if (!key) return toast('Key wajib diisi.', true);
  const btn = e.submitter || e.target.querySelector('[type=submit]');
  setBusy(btn, true);
  try {
    await api('/redeem', { method: 'POST', body: JSON.stringify({ key }) });
    toast('Key dipakai, masa aktif diperbarui.');
    setTimeout(() => location.reload(), 700);
  } catch (err) { toast(err.message, true); }
  finally { setBusy(btn, false); }
}

/* ───────── broadcast banner ───────── */
async function loadBroadcastBanner() {
  try {
    const bc = await api('/broadcast');
    if (!bc || !bc.message || !bc.message.trim()) return;
    // sisipkan banner di bawah header app
    const existing = document.getElementById('bc-banner');
    if (existing) existing.remove();
    const typeMap = { info: 'notice-info', warn: 'notice-warn', danger: 'notice-danger' };
    const cls = typeMap[bc.type] || 'notice-info';
    const banner = document.createElement('div');
    banner.id = 'bc-banner';
    banner.className = `notice ${cls}`;
    banner.setAttribute('role', 'alert');
    banner.style.cssText = 'margin:0 0 12px;border-radius:10px;';
    // Kalau notif per-user, tampilkan tombol dismiss
    const dismissBtn = bc.user_broadcast_id
      ? `<button onclick="dismissUserBroadcast(${bc.user_broadcast_id})" style="margin-top:8px;padding:4px 12px;border:none;border-radius:6px;cursor:pointer;background:rgba(0,0,0,0.15);color:inherit;font-size:0.85em;">Tutup</button>`
      : '';
    banner.innerHTML = `<div><p class="notice-title">${bc.type === 'danger' ? 'Penting' : bc.type === 'warn' ? 'Perhatian' : 'Info'}</p><p class="notice-msg">${esc(bc.message)}</p>${dismissBtn}</div>`;
    const main = $('main');
    if (main) main.prepend(banner);
  } catch { /* broadcast optional, abaikan error */ }
}

async function triggerExpiryNotify() {
  const r = await api('/admin/trigger-expiry-notify', { method: 'POST' });
  alert('Notif H-3 dikirim ke ' + (r.notified || 0) + ' user.');
}

async function dismissUserBroadcast(id) {
  try {
    await api(`/broadcast/dismiss/${id}`, { method: 'POST' });
    const banner = document.getElementById('bc-banner');
    if (banner) banner.remove();
  } catch { /* abaikan */ }
}

/* ───────── panel admin ───────── */
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = t; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
  }
  toast('Disalin.');
}

function setAdminTab(tab) {
  document.querySelectorAll('[data-atab]').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.atab === tab)));
  $('atab-keys').hidden = tab !== 'keys';
  $('atab-users').hidden = tab !== 'users';
  $('atab-stats').hidden = tab !== 'stats';
  $('atab-broadcast').hidden = tab !== 'broadcast';
  $('atab-blacklist').hidden = tab !== 'blacklist';
  if (tab === 'blacklist') loadBlacklist();
  if (tab === 'users') loadAdminUsers();
  else if (tab === 'stats') loadAdminStats();
  else if (tab === 'broadcast') loadBroadcastCurrent();
  else loadAdminKeys();
}

function openAdmin(opener) { location.hash = '#admin'; }

const fmtDate = iso => iso
  ? new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })
  : '-';

async function loadAdminStats() {
  const box = $('admin-stats-box');
  try {
    const [users, keys] = await Promise.all([api('/admin/users'), api('/admin/keys')]);
    const active  = users.filter(u => !u.expired && !u.is_admin);
    const expired = users.filter(u =>  u.expired && !u.is_admin);
    const usedKeys  = keys.filter(k => k.used_by);
    const availKeys = keys.filter(k => !k.used_by);
    box.innerHTML = `
      <div class="admin-stat-grid">
        <div class="admin-stat"><p class="admin-stat-n">${active.length}</p><p class="admin-stat-l">User Aktif</p></div>
        <div class="admin-stat"><p class="admin-stat-n">${expired.length}</p><p class="admin-stat-l">User Expired</p></div>
        <div class="admin-stat"><p class="admin-stat-n">${usedKeys.length}</p><p class="admin-stat-l">Key Terpakai</p></div>
        <div class="admin-stat"><p class="admin-stat-n">${availKeys.length}</p><p class="admin-stat-l">Key Tersedia</p></div>
      </div>
      <h3 class="sub-h" style="margin-top:16px">User aktif (masa aktif tersisa)</h3>
      ${active.length
        ? active
            .sort((a, b) => (a.seconds_left || 0) - (b.seconds_left || 0))
            .map(u => `
              <div class="acc-row col">
                <div class="row-top">
                  <p class="acc-name">${esc(u.username)}</p>
                  <span class="badge badge-ok">Aktif</span>
                </div>
                <p class="acc-meta">Sisa ${esc(fmtLeft(u.seconds_left))} · akun ${u.accounts}/${lim(u.max_accounts)} · query ${u.queries}/${lim(u.max_queries)}</p>
                <div class="row-actions">
                  <button type="button" class="btn btn-sm btn-danger" data-act="admin-stop-user" data-id="${u.id}" data-name="${esc(u.username)}">Stop Query</button>
                </div>
              </div>`).join('')
        : '<p class="hint">Belum ada user aktif.</p>'}`;
  } catch (e) { box.innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
}

async function adminStopUserQueries(id, name) {
  if (!(await ask('Stop query?', `Semua query aktif milik "${name}" akan dihentikan.`, 'Stop'))) return;
  try {
    const r = await api(`/admin/users/${id}/stop-queries`, { method: 'POST' });
    toast(`${r.stopped} query milik ${name} dihentikan.`);
    loadAdminStats();
  } catch (e) { toast(e.message, true); }
}

async function adminStopAll() {
  if (!(await ask('Stop semua query global?', 'Semua query dari semua user akan dihentikan paksa.', 'Stop Semua'))) return;
  try {
    await api('/admin/stop_all', { method: 'POST' });
    toast('Semua query dihentikan.');
  } catch (e) { toast(e.message, true); }
}

async function exportUsersCSV() {
  try {
    const users = await api('/admin/users');
    const rows = [['username','status','sisa_hari','max_accounts','max_queries','expires_at']];
    users.forEach(u => rows.push([
      u.username,
      u.is_admin ? 'admin' : u.expired ? 'expired' : 'aktif',
      u.seconds_left != null ? Math.floor(u.seconds_left / 86400) : '∞',
      u.max_accounts || '∞',
      u.max_queries || '∞',
      u.expires_at || '-',
    ]));
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `lepost-users-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('CSV diunduh.');
  } catch (e) { toast(e.message, true); }
}

async function submitBroadcast(e) {
  e.preventDefault();
  const msg = $('bc-msg').value.trim(), type = $('bc-type').value;
  if (!msg) return toast('Pesan wajib diisi.', true);
  const btn = e.submitter || e.target.querySelector('[type=submit]');
  setBusy(btn, true);
  try {
    await api('/admin/broadcast', { method: 'POST', body: JSON.stringify({ message: msg, type }) });
    toast('Broadcast dikirim.');
    $('bc-msg').value = '';
    loadBroadcastCurrent();
  } catch (e) { toast(e.message, true); }
  finally { setBusy(btn, false); }
}

async function loadBroadcastCurrent() {
  const box = $('bc-current');
  try {
    const r = await api('/admin/broadcast');
    if (!r || !r.message) {
      box.innerHTML = '<p class="hint">Tidak ada broadcast aktif.</p>';
      return;
    }
    box.innerHTML = `<div class="notice notice-${esc(r.type||'info')}"><div><p class="notice-title">Broadcast aktif</p><p class="notice-msg">${esc(r.message)}</p></div></div>`;
  } catch { box.innerHTML = '<p class="hint">Gagal memuat broadcast.</p>'; }
}

async function clearBroadcast() {
  try {
    await api('/admin/broadcast', { method: 'DELETE' });
    toast('Broadcast dihapus.');
    loadBroadcastCurrent();
  } catch (e) { toast(e.message, true); }
}

async function loadAdminKeys() {
  try {
    const list = await api('/admin/keys');
    $('key-list').innerHTML = list.length
      ? list.map(k => `
          <div class="acc-row col">
            <div class="row-top">
              <p class="acc-name key-code">${esc(k.key)}</p>
              <span class="badge ${k.used_by ? 'badge-bad' : 'badge-ok'}">${k.used_by ? 'Terpakai' : 'Tersedia'}</span>
            </div>
            <p class="acc-meta">${k.days} hari · akun ${lim(k.max_accounts)} · query ${lim(k.max_queries)}${k.allow_bypass ? ' · <b>Bypass</b>' : ''}${k.allow_dashboard ? ' · <b>Dashboard</b>' : ''}${k.note ? ' · ' + esc(k.note) : ''}${k.used_by ? ' · oleh ' + esc(k.used_by) : ''}</p>
            <div class="row-actions">
              <button type="button" class="btn btn-sm" data-act="copy-key" data-key="${esc(k.key)}">Salin</button>
              ${k.used_by ? `<button type="button" class="btn btn-sm btn-danger" data-act="revoke-key" data-id="${k.id}">Revoke</button>` : `<button type="button" class="btn btn-sm btn-danger" data-act="del-key" data-id="${k.id}">Hapus</button>`}
            </div>
          </div>`).join('')
      : '<p class="hint">Belum ada key.</p>';
  } catch (e) { toast(e.message, true); }
}

async function submitKey(e) {
  e.preventDefault();
  const num = (id, d) => { const v = parseInt($(id).value, 10); return Number.isFinite(v) ? v : d; };
  const body = {
    days: num('key-days', 30), count: num('key-count', 1),
    max_accounts: num('key-acc', 1), max_queries: num('key-ch', 1),
    note: $('key-note').value.trim(),
    allow_bypass: $('key-bypass')?.checked ?? false,
    allow_dashboard: $('key-dashboard')?.checked ?? false,
  };
  const btn = e.submitter || e.target.querySelector('[type=submit]');
  setBusy(btn, true);
  try {
    const keys = await api('/admin/keys', { method: 'POST', body: JSON.stringify(body) });
    const box = $('key-new');
    box.hidden = false;
    box.innerHTML =
      `<p class="acc-meta">${keys.length} key dibuat:</p>`
      + keys.map(k => `<p class="key-code">${esc(k.key)}</p>`).join('')
      + `<button type="button" class="btn btn-sm" data-act="copy-key" data-key="${esc(keys.map(k=>k.key).join('\n'))}">Salin semua</button>`;
    loadAdminKeys();
  } catch (err) { toast(err.message, true); }
  finally { setBusy(btn, false); }
}

async function loadAdminUsers() {
  try {
    const list = await api('/admin/users');
    $('user-list').innerHTML = list.map(u => `
      <div class="acc-row col" data-uid="${u.id}">
        <div class="row-top">
          <p class="acc-name">${esc(u.username)}</p>
          <span class="badge ${u.is_admin ? 'badge-adm' : u.is_suspended ? 'badge-bad' : u.expired ? 'badge-bad' : 'badge-ok'}">${u.is_admin ? 'Admin' : u.is_suspended ? 'Suspended' : u.expired ? 'Habis' : 'Aktif'}</span>
        </div>
        <p class="acc-meta">${u.is_admin ? 'Tanpa batas' : `Sisa ${esc(fmtLeft(u.seconds_left))} (s/d ${fmtDate(u.expires_at)})`} · akun ${u.accounts}/${lim(u.max_accounts)} · query ${u.queries}/${lim(u.max_queries)}</p>
        ${u.is_admin ? '' : `
        <div class="row-actions" style="margin-top:6px">
          <button type="button" class="btn btn-sm btn-ghost" data-act="toggle-user-edit" data-id="${u.id}">Edit</button>
          <button type="button" class="btn btn-sm ${u.is_suspended ? 'btn-primary' : 'btn-warning'}" data-act="suspend-user" data-id="${u.id}">${u.is_suspended ? 'Aktifkan' : 'Suspend'}</button>
          <button type="button" class="btn btn-sm btn-danger" data-act="del-user" data-id="${u.id}" data-name="${esc(u.username)}">Hapus</button>
        </div>
        <div class="user-edit-form" id="user-edit-${u.id}" hidden style="margin-top:8px">
        <div class="two-col">
          <input class="input" data-f="days" type="number" inputmode="numeric" placeholder="+/- hari" aria-label="Tambah hari">
          <input class="input" data-f="pw" type="text" autocomplete="off" placeholder="Password baru" aria-label="Password baru">
          <input class="input" data-f="acc" type="number" min="0" inputmode="numeric" placeholder="Limit akun (${lim(u.max_accounts)})" aria-label="Limit akun">
          <input class="input" data-f="ch" type="number" min="0" inputmode="numeric" placeholder="Limit query (${lim(u.max_queries)})" aria-label="Limit query">
        </div>
        <div class="two-col" style="margin-top:4px">
          <label class="label"><input type="checkbox" data-f="bypass" ${u.allow_bypass ? 'checked' : ''}> Allow Bypass</label>
          <label class="label"><input type="checkbox" data-f="dashboard" ${u.allow_dashboard ? 'checked' : ''}> Allow Dashboard</label>
        </div>
        <div class="row-actions" style="margin-top:6px">
            <button type="button" class="btn btn-sm btn-primary" data-act="save-user" data-id="${u.id}">Simpan</button>
          </div>
        </div>`}
      </div>`).join('');
  } catch (e) { toast(e.message, true); }
}

async function saveUser(id, el) {
  const row = el.closest('[data-uid]');
  const v = f => row.querySelector(`[data-f="${f}"]`).value.trim();
  const body = {};
  if (v('days') !== '') body.add_days = parseInt(v('days'), 10);
  if (v('acc')  !== '') body.max_accounts = parseInt(v('acc'), 10);
  if (v('ch')   !== '') body.max_queries  = parseInt(v('ch'), 10);
  if (v('pw')   !== '') body.new_password  = v('pw');
  const chkBypass = row.querySelector('[data-f="bypass"]');
  const chkDash = row.querySelector('[data-f="dashboard"]');
  if (chkBypass) body.allow_bypass = chkBypass.checked;
  if (chkDash) body.allow_dashboard = chkDash.checked;
  if (!Object.keys(body).length) return toast('Isi minimal satu kolom dulu.', true);
  setBusy(el, true);
  try {
    await api(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
    toast('User diperbarui.');
    loadAdminUsers();
  } catch (e) { toast(e.message, true); }
  finally { setBusy(el, false); }
}

async function suspendUser(id, el) {
  const isSuspended = el.textContent.trim() === 'Suspend';
  const label = isSuspended ? 'Suspend' : 'Aktifkan';
  if (!(await ask(label + ' user?', isSuspended ? 'User tidak bisa login dan semua query-nya akan berhenti.' : 'User bisa login kembali.', label))) return;
  setBusy(el, true);
  try {
    await api('/admin/users/' + id + '/suspend', { method: 'POST' });
    toast('User ' + (isSuspended ? 'disuspend.' : 'diaktifkan.'));
    loadAdminUsers();
  } catch (e) { toast(e.message, true); }
  finally { setBusy(el, false); }
}

async function stopUserQueries(id) {
  if (!(await ask('Stop semua query?', 'Semua query aktif milik user ini akan dihentikan.', 'Stop'))) return;
  try {
    const r = await api('/admin/users/' + id + '/stop-queries', { method: 'POST' });
    toast('Query dihentikan: ' + r.stopped + ' query distop.');
    loadAdminUsers();
  } catch (e) { toast(e.message, true); }
}

function toggleUserEdit(id) {
  const form = document.getElementById('user-edit-' + id);
  if (!form) return;
  form.hidden = !form.hidden;
  const btn = document.querySelector('[data-act="toggle-user-edit"][data-id="' + id + '"]');
  if (btn) btn.textContent = form.hidden ? 'Edit' : 'Tutup';
}

async function delUser(id, name) {
  if (!(await ask('Hapus user?', `User "${name}" beserta akun & query-nya akan dihapus permanen.`, 'Hapus'))) return;
  try { await api(`/admin/users/${id}`, { method: 'DELETE' }); toast('User dihapus.'); loadAdminUsers(); }
  catch (e) { toast(e.message, true); }
}

async function revokeKey(id) {
  if (!(await ask('Revoke key?', 'Key akan dihapus dan lisensi user yang memakai key ini akan dicabut.', 'Revoke'))) return;
  try { await api('/admin/keys/' + id, { method: 'DELETE' }); toast('Key direvoke.'); loadAdminKeys(); loadAdminUsers(); }
  catch (e) { toast(e.message, true); }
}

async function delKey(id) {
  try { await api(`/admin/keys/${id}`, { method: 'DELETE' }); loadAdminKeys(); }
  catch (e) { toast(e.message, true); }
}

function initHeroCounters() {
  document.querySelectorAll('.hstat-n[data-target]').forEach(el => {
    const target = parseInt(el.dataset.target, 10);
    let start = null;
    const dur = 1400;
    function step(ts) {
      if (!start) start = ts;
      const p = Math.min((ts - start) / dur, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(ease * target);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
}

/* ───────── dialog ───────── */
function openDialog(id, opener) {
  // Kalau suspended, hanya boleh buka dialog lisensi & admin
  if (state.me && state.me.is_suspended && id !== 'dlg-lic' && id !== 'dlg-admin' && id !== 'dlg-confirm') {
    toast('Akun kamu disuspend. Hubungi owner.', true);
    return;
  }
  const d = $(id); if (!d) return;
  state.openers[id] = opener || document.activeElement;
  d.hidden = false;
  document.body.classList.add('lock');
  (d.querySelector('[data-autofocus]') || d.querySelector(FOCUSABLE))?.focus();
}
function closeDialog(id) {
  const d = $(id); if (!d || d.hidden) return;
  d.hidden = true;
  if (!document.querySelector('.overlay:not([hidden])')) document.body.classList.remove('lock');
  if (id === 'dlg-post') resetPostForm();
  if (id === 'dlg-bypass') resetBypassForm();
  const back = state.openers[id];
  try { if (back && back.isConnected) back.focus(); } catch { /* ignore */ }
}
function topOverlay() {
  const open = document.querySelectorAll('.overlay:not([hidden])');
  return open[open.length - 1] || null;
}
function trapFocus(e, root) {
  const f = [...root.querySelectorAll(FOCUSABLE)].filter(el => el.getClientRects().length);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
document.addEventListener('keydown', e => {
  const top = topOverlay(); if (!top) return;
  if (e.key === 'Escape') { e.preventDefault(); top._cancel ? top._cancel() : closeDialog(top.id); }
  if (e.key === 'Tab') trapFocus(e, top);
});
document.querySelectorAll('.overlay').forEach(o => {
  o.addEventListener('pointerdown', e => {
    if (e.target !== o) return;
    o._cancel ? o._cancel() : closeDialog(o.id);
  });
});

/* ───────── routing ───────── */
const currentRoute = () => {
  const h = location.hash.replace('#', '');
  return TABS.includes(h) ? h : 'dashboard';
};
function showTab(tab) {
  if (state.me && state.me.is_suspended && tab !== 'accounts' && tab !== 'admin') return;
  document.querySelectorAll('[data-view]').forEach(s => { s.hidden = s.dataset.view !== tab; });
  const main = document.querySelector('main');
  if (main) main.style.visibility = 'visible';
  document.querySelectorAll('[data-tab]').forEach(a => {
    const on = a.dataset.tab === tab;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  loadStats();
  loadView(tab);
}
window.addEventListener('hashchange', () => { const t = currentRoute(); if (t !== 'rpc') window.scrollTo(0, 0); showTab(t); });

function loadView(tab) {
  if (tab === 'dashboard') return Promise.all([loadActivity(), loadDashQueries(), loadDashLogs()]);
  if (tab === 'logs') return loadLogs();
  if (tab === 'rpc') { if (!document.getElementById('btn-save-rpc')) loadAccounts().then(() => loadRpcPage()); return; }
  if (tab === 'accounts') { loadAccounts().then(() => renderAccountList()); return; }
  if (tab === 'admin') { setAdminTab('keys'); return; }
  return loadQueries();
}
function refreshNow() {
  loadStats();
  // Bug #8 fix: loadAccounts tidak dipanggil di refreshNow sehingga daftar akun
  // di state.accounts bisa stale kalau akun diedit dari tab lain atau token diganti.
  // refreshCurrent memanggil refreshNow, jadi loadAccounts ikut terpanggil tiap interval.
  loadAccounts();
  return loadView(currentRoute());
}
function refreshCurrent() {
  if (document.hidden || topOverlay() || !state.token) return;
  refreshNow();
}

/* ───────── dashboard ───────── */
function setHeader(on, n) {
  $('hdr-status').className = `pill ${on ? 'pill-on' : 'pill-off'}`;
  setText('hdr-status-t', on ? `${n} aktif` : 'Tidak aktif');
}
function setRing(rate) {
  const pct = rate == null ? 0 : Math.max(0, Math.min(100, rate));
  const fg = $('ring-fg');
  if (fg) fg.style.strokeDashoffset = String(188.5 * (1 - pct / 100));
  setText('ring-text', rate == null ? '-' : `${rate}%`);
  const ring = $('ring');
  if (!ring) return;
  ring.setAttribute('aria-label', rate == null ? 'Tingkat sukses, belum ada data' : `Tingkat sukses ${rate} persen`);
  ring.classList.remove('ring-good', 'ring-warn', 'ring-bad');
  if (rate != null) {
    if (pct >= 80) ring.classList.add('ring-good');
    else if (pct >= 50) ring.classList.add('ring-warn');
    else ring.classList.add('ring-bad');
  }
}

async function loadStats() {
  try {
    const s = await api('/stats');
    const on = (s.active || 0) > 0;
    setText('stat-total', s.total_posts ?? 0);
    setText('stat-sub-total', `+${s.posts_24h ?? 0} dalam 24 jam`);
    setText('stat-active', s.active ?? 0);
    setText('stat-sub-active', `dari ${s.scheduled ?? 0} query`);
    setText('stat-failed', s.failed ?? 0);
    setText('stat-sub-failed', s.success_rate == null ? 'Belum ada data' : `${100 - s.success_rate}% dari semua post`);
    setText('stat-accounts', state.accounts.length);
    setText('stat-sub-accounts', `${state.accounts.filter(a => a.proxy).length} pakai proxy`);
    const cardFailed = $('card-failed');
    if (cardFailed) cardFailed.classList.toggle('is-alert', (s.failed || 0) > 0);
    const cardActive = $('card-active');
    if (cardActive) cardActive.classList.toggle('is-live', on);
    const hero = $('hero');
    if (hero) hero.classList.toggle('is-live', on);
    setText('hero-date', new Date().toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' }));
    setText('hero-title', on ? `${s.active} query sedang berjalan` : 'Semua query sedang berhenti');
    setText('hero-sub', on
      ? `${s.posts_24h ?? 0} post sukses dalam 24 jam terakhir`
      : (s.scheduled ? 'Buka Auto Post atau Bypass, lalu tekan Start.' : 'Belum ada query. Mulai dari Auto Post.'));
    const retryBtn = $('hero-retry');
    if (retryBtn) retryBtn.hidden = true;
    setRing(s.success_rate ?? null);
    setHeader(on, s.active ?? 0);
    clearBg('stats');
  } catch (e) {
    setText('hero-title', 'Data belum bisa dimuat');
    setText('hero-sub', e.message);
    const retryBtn = $('hero-retry');
    if (retryBtn) retryBtn.hidden = false;
    reportBg('stats', e.message);
  }
}

/* ───────── grafik aktivitas (canvas) ───────── */
function drawLineChart(canvas, rows) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 320, H = canvas.clientHeight || 180;
  if (W === 0 || H === 0) return;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  const PAD = { top: 20, right: 20, bottom: 36, left: 40 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top  - PAD.bottom;
  if (cW <= 0 || cH <= 0) return;

  const safeRows = Array.isArray(rows) ? rows : [];
  const okV  = safeRows.map(r => (r && typeof r.success === 'number') ? r.success : 0);
  const errV = safeRows.map(r => (r && typeof r.error   === 'number') ? r.error   : 0);
  const maxVal = Math.max(1, ...okV, ...errV);
  const labels = safeRows.map(r => dayLabel(r && r.date ? r.date : ''));
  const n = safeRows.length;
  if (n === 0) return;

  const xOf = i => PAD.left + (n < 2 ? cW / 2 : i * cW / (n - 1));
  const yOf = v => PAD.top + cH - (v / maxVal * cH);

  // background area subtle
  const bgGrad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + cH);
  bgGrad.addColorStop(0, 'rgba(200,122,74,0.03)');
  bgGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(PAD.left, PAD.top, cW, cH);

  // grid lines horizontal
  const gridSteps = [0, 0.25, 0.5, 0.75, 1];
  gridSteps.forEach((t, idx) => {
    const y = PAD.top + cH * (1 - t);
    // main grid line
    ctx.strokeStyle = idx === 0 ? 'rgba(200,122,74,0.18)' : 'rgba(255,255,255,0.055)';
    ctx.lineWidth = idx === 0 ? 1.5 : 1;
    ctx.setLineDash(idx === 0 ? [] : [3, 4]);
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + cW, y); ctx.stroke();
    ctx.setLineDash([]);
  });

  // vertical grid lines
  labels.forEach((_, i) => {
    if (i === 0 || i === n - 1) return;
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xOf(i), PAD.top); ctx.lineTo(xOf(i), PAD.top + cH); ctx.stroke();
  });

  // y-labels
  ctx.fillStyle = 'rgba(200,122,74,0.6)';
  ctx.font = '600 10px Inter,system-ui,sans-serif';
  ctx.textAlign = 'right';
  [0, 0.5, 1].forEach(t => {
    const val = Math.round(maxVal * t);
    ctx.fillText(val, PAD.left - 8, PAD.top + cH * (1 - t) + 4);
  });

  function drawLine(vals, color, fillColor, glowColor) {
    if (!vals.some(v => v > 0)) return;
    // smooth curve via bezier
    ctx.beginPath();
    vals.forEach((v, i) => {
      const x = xOf(i), y = yOf(v);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        const px = xOf(i - 1), py = yOf(vals[i - 1]);
        const cpx = (px + x) / 2;
        ctx.bezierCurveTo(cpx, py, cpx, y, x, y);
      }
    });
    // glow shadow
    ctx.save();
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = color; ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
    ctx.restore();

    // area fill under curve
    ctx.beginPath();
    vals.forEach((v, i) => {
      const x = xOf(i), y = yOf(v);
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        const px = xOf(i - 1), py = yOf(vals[i - 1]);
        const cpx = (px + x) / 2;
        ctx.bezierCurveTo(cpx, py, cpx, y, x, y);
      }
    });
    ctx.lineTo(xOf(vals.length - 1), PAD.top + cH);
    ctx.lineTo(xOf(0), PAD.top + cH);
    ctx.closePath();
    const areaGrad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + cH);
    areaGrad.addColorStop(0, fillColor);
    areaGrad.addColorStop(0.7, 'transparent');
    ctx.fillStyle = areaGrad; ctx.fill();

    // dots with ring
    ctx.save();
    vals.forEach((v, i) => {
      if (v > 0) {
        const x = xOf(i), y = yOf(v);
        // outer ring
        ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fill();
        // inner dot
        ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
        // value label above dot
        ctx.fillStyle = color;
        ctx.font = '700 9px Inter,system-ui,sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(v, x, Math.max(y - 10, PAD.top + 8));
      }
    });
    ctx.restore();
  }

  drawLine(errV, '#ff6b6b', 'rgba(255,107,107,0.18)', 'rgba(255,107,107,0.4)');
  drawLine(okV,  '#c87a4a', 'rgba(200,122,74,0.22)', 'rgba(200,122,74,0.5)');

  // x-labels styled
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = '600 10px Inter,system-ui,sans-serif';
  ctx.textAlign = 'center';
  labels.forEach((l, i) => {
    const x = xOf(i);
    // active day tick
    ctx.fillStyle = 'rgba(200,122,74,0.4)';
    ctx.fillRect(x - 0.5, PAD.top + cH + 4, 1, 4);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(l, x, H - 6);
  });
}

let _chartAnim = null;
async function loadActivity() {
  const box = $('chart');
  if (!box) return;
  try {
    const rows = await api('/stats/activity?days=7');
    if (!changed('chart', rows)) return;
    const safeRows = Array.isArray(rows) ? rows : [];
    const ok  = sum(safeRows.map(r => r.success || 0));
    const bad = sum(safeRows.map(r => r.error   || 0));
    setText('chart-sum', ok + bad ? `${ok} sukses, ${bad} gagal dalam 7 hari` : 'Belum ada aktivitas');
    if (!ok && !bad) {
      box.innerHTML = '<p class="chart-empty">Belum ada aktivitas dalam 7 hari terakhir.</p>';
      return;
    }
    box.innerHTML = '<canvas id="chart-canvas" style="width:100%;height:180px;display:block"></canvas>';
    const canvas = $('chart-canvas');
    if (!canvas) return;
    let frame = 0; const totalFrames = 40;
    if (_chartAnim) cancelAnimationFrame(_chartAnim);
    function animate() {
      frame++;
      const ease = 1 - Math.pow(1 - Math.min(frame / totalFrames, 1), 3);
      drawLineChart(canvas, safeRows.map(r => ({
        date: r.date,
        success: Math.round((r.success || 0) * ease),
        error:   Math.round((r.error   || 0) * ease),
      })));
      if (ease < 1) _chartAnim = requestAnimationFrame(animate);
    }
    requestAnimationFrame(animate);
  } catch (e) {
    box.innerHTML = errorBlock('Grafik belum bisa dimuat.', e.message);
  }
}

async function fetchQueries() {
  const list = await api('/queries');
  state.queries = Array.isArray(list) ? list : [];
  return state.queries;
}

async function loadDashQueries() {
  const box = $('dash-running');
  if (!box) return;
  try {
    const list = await fetchQueries();
    const act = list.filter(q => q.status === 'active');
    if (!changed('run', act)) { tickCountdown(); return; }
    box.innerHTML = act.length
      ? `<ul class="run-flat">${act.map(q => {
          const bypass = q.query_type === 'bypass';
          return `<li class="run-flat-item">
            <span class="run-flat-name">${esc(chn(q.channel_name) || '#channel')}</span>
            <span class="tag ${bypass ? 'tag-bypass' : 'tag-auto'}">${bypass ? 'Bypass' : 'Auto'}</span>
            <span class="cd js-count run-flat-cd" data-active="1" data-next="${nextOf(q)}"></span>
          </li>`;
        }).join('')}</ul>`
      : inlineEmpty('Belum ada yang berjalan.', 'Tekan Start di Auto Post atau Bypass.');
    tickCountdown();
  } catch (e) {
    box.innerHTML = errorBlock('Status query belum bisa dimuat.', e.message);
  }
}

const logItem = l => {
  const err = l.level === 'ERROR', ok = l.level === 'SUCCESS';
  const cls = err ? 'lvl-err' : ok ? 'lvl-ok' : 'lvl-info';
  const label = err ? 'Error' : ok ? 'Sukses' : 'Info';
  return `<li>
    <time class="log-time" datetime="${esc(l.ts)}">${esc(shortTime(l.ts))}</time>
    <span class="lvl ${cls}">${label}</span>
    <p class="log-msg${err ? ' is-err' : ''}">${esc(fixMsg(l.message))}</p>
  </li>`;
};

async function loadDashLogs() {
  const box = $('dash-log-list');
  if (!box) return;
  try {
    const list = await api('/logs?limit=5');
    if (!changed('dlog', list)) return;
    box.innerHTML = list.length
      ? `<ul class="loglist">${list.map(logItem).join('')}</ul>`
      : inlineEmpty('Belum ada aktivitas.', 'Log akan muncul setelah query dijalankan.');
  } catch (e) {
    box.innerHTML = errorBlock('Log belum bisa dimuat.', e.message);
  }
}

function tickCountdown() {
  const now = Date.now();
  document.querySelectorAll('.js-count').forEach(el => {
    if (el.dataset.active === '0') {
      const last = el.dataset.last;
      setText(el, last ? `Terakhir jalan ${fmtDur((now - new Date(last)) / 1000)} lalu` : 'Belum pernah jalan');
      return;
    }
    const n = Number(el.dataset.next);
    if (!n) { setText(el, 'Menunggu post pertama'); return; }
    const diff = (n - now) / 1000;
    setText(el, diff > 0 ? `Post berikutnya dalam ${fmtDur(diff)}` : 'Sedang diproses');
  });
}

/* ───────── accounts ───────── */
function setSelect(sel, items, placeholder) {
  sel.innerHTML = '';
  sel.append(new Option(placeholder, ''));
  items.forEach(([v, t]) => sel.append(new Option(t, v)));
}

async function loadAccounts() {
  try {
    state.accounts = await api('/accounts');
    const sel = $('post-acc');
    const cur = sel ? sel.value : '';
    if (sel) {
      setSelect(sel, state.accounts.map(a => [a.id, `${a.label} (@${a.dc_user || '?'})`]), 'Pilih akun');
      if (cur) sel.value = cur;
    }
    renderBypassAccounts();
    clearBg('accounts');
    
    // Auto-validate accounts di background (non-blocking)
    validateAccountsInBackground();
  } catch (e) {
    reportBg('accounts', 'Akun belum bisa dimuat: ' + e.message);
  }
}

async function validateAccountsInBackground() {
  // Validate tiap akun satu per satu, update UI progressively
  for (const acc of state.accounts) {
    try {
      const result = await api(`/accounts/${acc.id}/validate`);
      // Update data akun di state
      const idx = state.accounts.findIndex(a => a.id === acc.id);
      if (idx !== -1) {
        state.accounts[idx].token_valid = result.token_valid;
        state.accounts[idx].discord_username = result.discord_username;
        state.accounts[idx].dc_id = result.dc_id;
        state.accounts[idx].dc_avatar = result.dc_avatar;
        // Re-render list setiap akun selesai validasi
        renderAccountList();
      }
    } catch (e) {
      console.warn(`Failed to validate account ${acc.id}:`, e);
    }
  }
}

const statusBadge = (a) => {
  const s = a.discord_status || 'online';
  const colors = {online:'#23a55a',idle:'#f0b232',dnd:'#f23f43',invisible:'#80848e'};
  const labels = {online:'Online',idle:'Idle',dnd:'DND',invisible:'Invisible'};
  const ko = a.keep_online ? '<span class="badge badge-ok" style="margin-left:4px;font-size:0.75em">24/7</span>' : '';
  return '<span style="display:inline-flex;align-items:center;gap:4px;font-size:0.78em;background:rgba(255,255,255,0.07);padding:2px 8px;border-radius:20px"><span style="width:8px;height:8px;border-radius:50%;background:' + colors[s] + ';display:inline-block"></span>' + labels[s] + '</span>' + ko;
};

function renderAccountList() {
  const box = $('acc-list');
  if (!box) return;
  if (!state.accounts.length) {
    box.innerHTML = '<p class="hint">Belum ada akun. Tambahkan akun pertamamu di bawah.</p>';
    return;
  }
  box.innerHTML = state.accounts.map(a => {
    const avatarUrl = a.dc_id && a.dc_avatar
      ? `https://cdn.discordapp.com/avatars/${a.dc_id}/${a.dc_avatar}.png?size=64`
      : null;
    const avatarHtml = avatarUrl
      ? `<img src="${avatarUrl}" class="acc-avatar-img" alt="${esc(a.label)}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      : '';
    const avatarFallback = `<span class="avatar" aria-hidden="true" ${avatarUrl ? 'style="display:none"' : ''}>${esc((a.discord_username || a.label||'?').charAt(0).toUpperCase())}</span>`;
    const statusColors = {online:'#23a55a',idle:'#f0b232',dnd:'#f23f43',invisible:'#80848e'};
    const statusLabels = {online:'Online',idle:'Idle',dnd:'DND',invisible:'Invisible'};
    const s = a.discord_status || 'online';
    
    // Token status badge
    let tokenBadge = '';
    if (a.token_valid === true) {
      tokenBadge = '<span class="badge badge-ok">TOKEN VALID</span>';
    } else if (a.token_valid === false) {
      tokenBadge = '<span class="badge badge-danger">TOKEN INVALID</span>';
    } else {
      tokenBadge = '<span class="badge" style="background:rgba(255,255,255,0.08);color:#ccc">TOKEN UNKNOWN</span>';
    }
    
    return `
    <div class="acc-card">
      <div class="acc-card-top">
        <div class="acc-avatar-wrap">
          ${avatarHtml}${avatarFallback}
          <span class="acc-status-dot" style="background:${statusColors[s]}" title="${statusLabels[s]}"></span>
        </div>
        <div class="acc-card-info">
          <div class="acc-card-name">${esc(a.label)}</div>
          <div class="acc-card-user">@${esc(a.discord_username || '?')}</div>
          <div class="acc-card-badges">
            ${tokenBadge}
            <span class="badge" style="background:${statusColors[s]}22;color:${statusColors[s]};border:1px solid ${statusColors[s]}55">${statusLabels[s]}</span>
            ${a.keep_online ? '<span class="badge badge-ok">Online 24/7</span>' : ''}
            ${a.proxy ? '<span class="badge" style="background:rgba(255,255,255,0.08);color:#ccc">Proxy</span>' : ''}
          </div>
        </div>
      </div>
      <div class="acc-card-actions" style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr 36px;gap:6px;align-items:center">
        <button type="button" class="btn btn-sm" data-act="edit-label" data-id="${a.id}" data-label="${esc(a.label)}"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Edit Nama</button>
        <button type="button" class="btn btn-sm" data-act="open-status" data-id="${a.id}">Atur status</button>
        <button type="button" class="btn btn-sm" data-act="open-webhook" data-id="${a.id}" data-label="${esc(a.label)}">Webhook</button>
        <button type="button" class="btn btn-sm" data-act="edit-token" data-id="${a.id}" data-label="${esc(a.label)}"><svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M12 11l8-8m-3 0l2 2m-4 1l2 2"/></svg> Perbarui token</button>
        <button type="button" class="btn btn-icon btn-sm" style="border:1px solid rgba(255,255,255,0.15);border-radius:6px;" data-act="del-acc" data-id="${a.id}" aria-label="Hapus akun ${esc(a.label)}">${icon('trash')}</button>
      </div>
    </div>`;
  }).join('');
}

function renderBypassAccounts() {
  const box = $('bypass-accounts');
  if (!box) return;
  if (!state.accounts.length) {
    box.innerHTML = '<p class="hint">Belum ada akun. Tambahkan dulu lewat menu Akun.</p>';
    return;
  }
  box.innerHTML = state.accounts.map(a => `
    <div class="pick">
      <label class="check">
        <input type="checkbox" class="bypass-check" value="${a.id}">
        <span>${esc(a.label)} <span class="muted">@${esc(a.dc_user || '?')}</span></span>
      </label>
      <textarea class="textarea bypass-text" rows="2" hidden aria-label="Pesan untuk ${esc(a.label)}" placeholder="Pesan untuk akun ini"></textarea>
    </div>`).join('');
}

async function hapusAkun(id) {
  const acc = state.accounts.find(a => a.id === id);
  if (!(await ask('Hapus akun ini?', `${acc ? acc.label : 'Akun'}. Query yang memakai akun ini bisa gagal jalan.`, 'Hapus'))) return;
  try {
    await api(`/accounts/${id}`, { method: 'DELETE' });
    await loadAccounts();
    renderAccountList();
    loadStats();
    toast('Akun dihapus.');
  } catch (e) { toast(e.message, true); }
}

async function editLabel(id, currentLabel) {
  const newLabel = prompt('Edit nama akun:', currentLabel);
  if (!newLabel || newLabel === currentLabel) return;
  try {
    await api(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify({ label: newLabel }) });
    await loadAccounts();
    renderAccountList();
    toast('Nama akun berhasil diubah.');
  } catch (e) { toast(e.message, true); }
}

function openEditToken(id, label, opener) {
  const dlg = $('dlg-edit-token');
  if (!dlg) return;
  $('edit-token-label').textContent = label || 'Akun';
  $('edit-token-input').value = '';
  dlg.dataset.accId = id;
  openDialog('dlg-edit-token', opener);
}

async function submitEditToken(e) {
  e.preventDefault();
  const dlg = $('dlg-edit-token');
  const id = Number(dlg?.dataset.accId);
  const token = $('edit-token-input')?.value.trim();
  if (!token) return toast('Token baru wajib diisi.', true);
  const btn = e.submitter || e.target.querySelector('[type=submit]');
  setBusy(btn, true);
  try {
    await api(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify({ token }) });
    closeDialog('dlg-edit-token');
    await loadAccounts();
    renderAccountList();
    toast('Token berhasil diganti. Query yang pakai akun ini akan pakai token baru.');
  } catch (err) { toast(err.message, true); }
  finally { setBusy(btn, false); }
}

function openAccounts(opener) {
  location.hash = '#accounts';
}

async function submitAccount(e) {
  e.preventDefault();
  const label = $('acc-label').value.trim();
  const token = $('acc-token').value.trim();
  const proxy = $('acc-proxy').value.trim();
  if (!label || !token) return toast('Nama akun dan token wajib diisi.', true);
  const btn = e.submitter || e.target.querySelector('[type=submit]');
  setBusy(btn, true);
  try {
    await api('/accounts', { method: 'POST', body: JSON.stringify({ label, token, proxy }) });
    e.target.reset();
    closeDialog('dlg-add-acc');
    await loadAccounts();
    renderAccountList();
    loadStats();
    toast('Akun ditambahkan.');
  } catch (err) { toast(err.message, true); }
  finally { setBusy(btn, false); }
}

/* ───────── channel ───────── */
function resetChannels(mode) {
  state.channels[mode] = [];
  const search = $(`${mode}-ch-search`);
  if (search) search.value = '';
  const chSel = $(`${mode}-channel`);
  if (chSel) { setSelect(chSel, [], 'Pilih server dulu'); chSel.disabled = true; }
}

async function loadGuilds(accId, mode, keepChannel = false) {
  const sel = $(`${mode}-guild`);
  if (!sel) return [];
  const req = ++state.reqId[mode];
  if (!keepChannel) resetChannels(mode);
  if (!accId) {
    setSelect(sel, [], 'Pilih akun dulu');
    sel.disabled = true;
    return [];
  }
  setSelect(sel, [], 'Memuat server...');
  sel.disabled = true;
  try {
    const guilds = await api(`/fetch/guilds/${accId}`);
    if (req !== state.reqId[mode]) return [];
    setSelect(sel, guilds.map(g => [g.id, g.name]), 'Pilih server');
    sel.disabled = false;
    return guilds;
  } catch (e) {
    if (req !== state.reqId[mode]) return [];
    setSelect(sel, [], 'Gagal memuat server');
    sel.disabled = false;
    toast(e.message, true);
    return [];
  }
}

async function loadChannels(accId, gid, mode, keep = null) {
  const sel = $(`${mode}-channel`);
  if (!sel) return;
  // Bug fix: pakai state.reqId[mode] bukan state.reqId.ch yang di-share semua mode.
  // Kalau post dan bypass load channel bersamaan, reqId.ch yang shared bisa cancel
  // request yang salah, membuat channel salah satu form tidak muncul.
  const req = ++state.reqId[mode];
  state.channels[mode] = [];
  if (!gid || !accId) { resetChannels(mode); return; }
  setSelect(sel, [], 'Memuat channel...');
  sel.disabled = true;
  try {
    const chans = await api(`/fetch/channels/${accId}/${gid}`);
    if (req !== state.reqId[mode]) return;
    if (keep && keep.id && !chans.some(c => c.id === keep.id)) {
      chans.unshift({ id: keep.id, name: String(keep.name).replace(/^#/, ''), slowmode: 0 });
    }
    state.channels[mode] = chans;
    const search = $(`${mode}-ch-search`);
    if (search) search.value = '';
    renderChannelOptions(mode, keep?.id);
    sel.disabled = false;
  } catch (e) {
    if (req !== state.reqId[mode]) return;
    setSelect(sel, [], 'Gagal memuat channel');
    sel.disabled = false;
    toast(e.message, true);
  }
}

function renderChannelOptions(mode, selectId) {
  const sel = $(`${mode}-channel`);
  if (!sel) return;
  const all = state.channels[mode];
  const current = selectId ?? sel.value;
  const searchEl = $(`${mode}-ch-search`);
  const kw = searchEl ? searchEl.value.trim().toLowerCase().replace(/^#/, '') : '';
  const list = all.filter(c => c.name.toLowerCase().includes(kw));
  const items = list.map(c => [c.id, chn(c.name)]);
  setSelect(sel, items, all.length ? (items.length ? 'Pilih channel' : 'Channel tidak ketemu') : 'Pilih server dulu');
  if (current && items.some(([v]) => v === current)) sel.value = current;
  sel.disabled = !all.length;
}

function channelOf(mode) {
  const sel = $(`${mode}-channel`);
  if (!sel) return { id: '', name: '' };
  const id = sel.value;
  const name = sel.options[sel.selectedIndex]?.text || '';
  return { id, name: id ? name : '' };
}

function onPickChannel(mode) {
  const id = $(`${mode}-channel`)?.value;
  const c = state.channels[mode].find(x => x.id === id);
  if (!c) return;
  const mins = c.slowmode > 0 ? Math.ceil(c.slowmode / 60) : 1;
  if (mode === 'post') {
    const pd = $('post-delay');
    if (pd) pd.value = mins;
  } else {
    const bts = $('bypass-total-slowmode');
    if (bts) { bts.value = mins; recalcBypassDelay(); }
  }
}

/* ───────── post dialog ───────── */
function resetPostForm() {
  state.editEmbed = {};
  const f = $('form-post'); if (f) f.reset();
  const pid = $('post-id'); if (pid) pid.value = '';
  const title = $('dlg-post-title'); if (title) title.textContent = 'Buat Post';
  const webhook = $('post-webhook-url');
  if (webhook) webhook.value = localStorage.getItem('lepost_webhook') || '';
  const guild = $('post-guild');
  if (guild) { setSelect(guild, [], 'Pilih akun dulu'); guild.disabled = true; }
  resetChannels('post');
  // Load last settings
  try {
    const last = JSON.parse(localStorage.getItem('lepost_last_post') || '{}');
    if (last.acc) { const a = $('post-acc'); if (a) a.value = last.acc; }
    if (last.delay) { const d = $('post-delay'); if (d) d.value = last.delay; }
    if (last.random) { const r = $('post-delay-random'); if (r) r.value = last.random; }
  } catch(e) {}
}

function openPost(opener) {
  if (!state.accounts.length) return toast('Tambah akun dulu lewat menu Akun.', true);
  resetPostForm();
  const accSel = $('post-acc');
  if (accSel && state.accounts[0]) {
    accSel.value = state.accounts[0].id;
    loadGuilds(state.accounts[0].id, 'post');
  }
  openDialog('dlg-post', opener);
}

async function submitPost(e) {
  e.preventDefault();
  const id = $('post-id')?.value || '';
  const accId = Number($('post-acc')?.value || 0);
  const ch = channelOf('post');
  const content = $('post-content')?.value || '';
  const delay = Math.ceil(Number($('post-delay')?.value || 5));
  if (!accId) return toast('Pilih akun dulu.', true);
  if (!ch.id) return toast('Pilih server dan channel dulu.', true);
  if (!content.trim()) return toast('Isi pesan dulu.', true);
  if (!(delay >= 1)) return toast('Delay minimal 1 menit.', true);
  const webhook = $('post-webhook-url')?.value.trim() || '';
  if (webhook) localStorage.setItem('lepost_webhook', webhook);
  const payload = {
    query_type: 'auto',
    bypass_data: [{ account_id: accId, content }],
    guild_id: $('post-guild')?.value || '',
    channel_id: ch.id, channel_name: ch.name,
    content, embed: state.editEmbed || {}, webhook_url: webhook, delay_min: delay,
    delay_random_min: Number($('post-delay-random')?.value) || 0,
    typing_sim: $('post-typing-sim')?.checked || false,
  };
  // Save last settings
  try {
    localStorage.setItem('lepost_last_post', JSON.stringify({
      acc: $('post-acc')?.value,
      delay: $('post-delay')?.value,
      random: $('post-delay-random')?.value,
    }));
  } catch(e) {}
  await saveQuery(e.target, id, payload, 'Post disimpan.', 'dlg-post');
}

/* ───────── bypass dialog ───────── */
const firstChecked = () => document.querySelector('.bypass-check:checked')?.value || '';

function recalcBypassDelay() {
  const totalEl = $('bypass-total-slowmode');
  const total = Math.max(1, parseInt(totalEl?.value || '1', 10) || 1);
  const n = document.querySelectorAll('.bypass-check:checked').length;
  // Bug fix: bypass-delay hanya untuk tampilan info (menit per akun = total/n).
  // Nilai yang dikirim ke API adalah totalSM langsung (bukan per-akun),
  // karena worker sudah bagi sendiri. Jadi field ini read-only/display only.
  const delayEl = $('bypass-delay');
  if (delayEl) delayEl.value = n > 0 ? Math.ceil(total / n) : total;
  setText('bypass-count', `${n} akun dipilih`);
}

function syncBypassRef() {
  const ref = firstChecked();
  if (ref === state.bypassRef) return;
  state.bypassRef = ref;
  if (ref) loadGuilds(ref, 'bypass');
  else {
    const bg = $('bypass-guild');
    if (bg) { setSelect(bg, [], 'Pilih akun dulu'); bg.disabled = true; }
    resetChannels('bypass');
  }
}

function onBypassPick(e) {
  const cb = e.target;
  if (!cb.matches('.bypass-check')) return;
  const pick = cb.closest('.pick');
  pick.classList.toggle('is-on', cb.checked);
  pick.querySelector('.bypass-text').hidden = !cb.checked;
  recalcBypassDelay();
  syncBypassRef();
}

function selectAllBypass() {
  document.querySelectorAll('.bypass-check').forEach(cb => {
    cb.checked = true;
    const pick = cb.closest('.pick');
    pick.classList.add('is-on');
    pick.querySelector('.bypass-text').hidden = false;
  });
  recalcBypassDelay();
  syncBypassRef();
}

function resetBypassForm() {
  const f = $('form-bypass'); if (f) f.reset();
  const bid = $('bypass-id'); if (bid) bid.value = '';
  const title = $('dlg-bypass-title'); if (title) title.textContent = 'Buat Bypass';
  document.querySelectorAll('.pick').forEach(p => {
    p.classList.remove('is-on');
    p.querySelector('.bypass-text').hidden = true;
  });
  state.bypassRef = '';
  const bg = $('bypass-guild');
  if (bg) { setSelect(bg, [], 'Pilih akun dulu'); bg.disabled = true; }
  resetChannels('bypass');
  recalcBypassDelay();
  // Load last bypass settings
  try {
    const last = JSON.parse(localStorage.getItem('lepost_last_bypass') || '{}');
    if (last.accs && Array.isArray(last.accs)) {
      last.accs.forEach(accId => {
        const cb = document.querySelector(`.bypass-check[value="${accId}"]`);
        if (cb) { cb.checked = true; cb.closest('.pick').classList.add('is-on'); cb.closest('.pick').querySelector('.bypass-text').hidden = false; }
      });
      recalcBypassDelay();
    }
  } catch(e) {}
}

function openBypass(opener) {
  if (state.accounts.length < 2) return toast('Bypass butuh minimal 2 akun.', true);
  resetBypassForm();
  openDialog('dlg-bypass', opener);
}

async function submitBypass(e) {
  e.preventDefault();
  const id = $('bypass-id')?.value || '';
  const data = [...document.querySelectorAll('.bypass-check:checked')].map(c => ({
    account_id: Number(c.value),
    content: c.closest('.pick').querySelector('.bypass-text').value,
  }));
  const ch = channelOf('bypass');
  if (data.length < 2) return toast('Pilih minimal 2 akun.', true);
  if (data.some(d => !d.content.trim())) return toast('Isi pesan untuk setiap akun yang dipilih.', true);
  if (!ch.id) return toast('Pilih server dan channel dulu.', true);
  const totalSM = Math.max(1, Math.ceil(parseFloat($('bypass-total-slowmode')?.value) || 120));
  // Bug fix: kirim totalSM langsung ke API sebagai delay_min.
  // Worker sudah bagi sendiri (delay_min * 60 / nAcc) supaya tiap akun dapat jatah waktunya.
  // Dulu frontend bagi dulu (totalSM/nAcc) lalu worker bagi lagi = double-division, bypass jalan nAcc² lebih cepat.
  const payload = {
    query_type: 'bypass', bypass_data: data,
    guild_id: $('bypass-guild')?.value || '',
    channel_id: ch.id, channel_name: ch.name,
    delay_min: totalSM,
  };
  // Save last bypass settings
  try {
    const checkedAccs = [...document.querySelectorAll('.bypass-check:checked')].map(c => c.value);
    localStorage.setItem('lepost_last_bypass', JSON.stringify({ accs: checkedAccs }));
  } catch(e) {}
  await saveQuery(e.target, id, payload, 'Bypass disimpan.', 'dlg-bypass');
}

async function saveQuery(form, id, payload, okMsg, dialogId) {
  const btn = form.querySelector('[type=submit]');
  setBusy(btn, true);
  try {
    const body = JSON.stringify(payload);
    if (id) await api(`/queries/${id}`, { method: 'PATCH', body });
    else await api('/queries', { method: 'POST', body });
    toast(okMsg);
    closeDialog(dialogId);
    refreshNow();
  } catch (err) { toast(err.message, true); }
  finally { setBusy(btn, false); }
}

function setBusy(el, busy) {
  if (!el) return;
  el.disabled = busy;
  el.setAttribute('aria-busy', busy ? 'true' : 'false');
}

/* ───────── edit query ───────── */
async function editQ(id) {
  const q = state.queries.find(x => x.id === id);
  if (!q) return toast('Query tidak ditemukan, muat ulang daftar.', true);
  const keep = { id: q.channel_id, name: q.channel_name || q.channel_id };
  const opener = document.activeElement;

  if (q.query_type === 'auto') {
    resetPostForm();
    state.editEmbed = q.embed || {};
    const accId = q.bypass_data?.[0]?.account_id || '';
    const title = $('dlg-post-title'); if (title) title.textContent = 'Edit Post';
    const pid = $('post-id'); if (pid) pid.value = q.id;
    const pacc = $('post-acc'); if (pacc) pacc.value = accId;
    const pc = $('post-content'); if (pc) pc.value = q.content || q.bypass_data?.[0]?.content || '';
    const pd = $('post-delay'); if (pd) pd.value = q.delay_min;
    const pdr = $('post-delay-random'); if (pdr) pdr.value = q.delay_random_min || 0;
    const pts = $('post-typing-sim'); if (pts) pts.checked = !!q.typing_sim;
    const pw = $('post-webhook-url'); if (pw) pw.value = q.webhook_url || '';
    openDialog('dlg-post', opener);
    const guilds = await loadGuilds(accId, 'post', true);
    if (q.guild_id && guilds.some(g => g.id === q.guild_id)) {
      const pg = $('post-guild'); if (pg) pg.value = q.guild_id;
      await loadChannels(accId, q.guild_id, 'post', keep);
    }
  } else {
    resetBypassForm();
    const title = $('dlg-bypass-title'); if (title) title.textContent = 'Edit Bypass';
    const bid = $('bypass-id'); if (bid) bid.value = q.id;
    // Hitung total slowmode: delay_min (tersimpan = totalSM langsung sejak bug fix)
    // Untuk data lama (sebelum fix) yang menyimpan per-akun, coba deteksi:
    // kalau delay_min kecil dan nAcc > 1, kemungkinan data lama → kalikan nAcc sebagai fallback
    const nAccQ = (q.bypass_data || []).length || 1;
    const totalSlowQ = q.delay_min;
    const bts = $('bypass-total-slowmode'); if (bts) bts.value = totalSlowQ;
    // Bug fix: akun yang sudah dihapus dulu di-skip diam-diam tanpa peringatan ke user.
    // Sekarang hitung dulu akun yang hilang, tampilkan toast peringatan.
    let missingAccs = 0;
    (q.bypass_data || []).forEach(d => {
      const cb = document.querySelector(`.bypass-check[value="${d.account_id}"]`);
      if (!cb) { missingAccs++; return; }
      cb.checked = true;
      const pick = cb.closest('.pick');
      pick.classList.add('is-on');
      const t = pick.querySelector('.bypass-text');
      t.hidden = false; t.value = d.content;
    });
    if (missingAccs > 0) {
      toast(`⚠️ ${missingAccs} akun di bypass ini sudah dihapus dan tidak bisa dipulihkan. Simpan ulang untuk memperbarui.`, true);
    }
    recalcBypassDelay();
    openDialog('dlg-bypass', opener);
    state.bypassRef = firstChecked();
    if (!state.bypassRef) return;
    const guilds = await loadGuilds(state.bypassRef, 'bypass', true);
    if (q.guild_id && guilds.some(g => g.id === q.guild_id)) {
      const bg = $('bypass-guild'); if (bg) bg.value = q.guild_id;
      await loadChannels(state.bypassRef, q.guild_id, 'bypass', keep);
    }
  }
}

/* ───────── query list ───────── */
const countLabel = arr =>
  arr.length ? `${arr.length} query, ${arr.filter(q => q.status === 'active').length} berjalan` : 'Belum ada query';

function toggleBtn(id, on) {
  const b = $(id); if (!b) return;
  b.innerHTML = on ? `${icon('stop')}Stop semua` : `${icon('play')}Start semua`;
  b.className = `btn ${on ? 'btn-stop' : 'btn-start'}`;
}

const msgBlock = text => {
  const t = String(text ?? '');
  if (t.length > 140) {
    return `<details class="more"><summary>Lihat pesan (${t.length} karakter)</summary><p class="msg msg-full">${esc(t)}</p></details>`;
  }
  return `<p class="msg msg-short">${esc(t)}</p>`;
};

function cardHtml(q, n) {
  const bypass = q.query_type === 'bypass';
  const on = q.status === 'active';
  const accs = Array.isArray(q.bypass_data) ? q.bypass_data : [];
  const cnt = accs.length;
  const per = bypass && cnt ? ` · ${Math.ceil(q.delay_min / cnt)}m/akun` : '';
  const title = esc(chn(q.channel_name) || '#channel');
  let body;
  if (bypass) {
    body = `<ul class="acc-msgs">${accs.map(d => {
      const a = state.accounts.find(x => x.id === d.account_id);
      return `<li class="acc-line"><span class="chip"><span>${esc(a ? a.label : 'Akun tidak dikenal')}</span></span>${msgBlock(d.content)}</li>`;
    }).join('')}</ul>`;
  } else {
    body = msgBlock(q.content);
  }
  let accChip;
  if (bypass) accChip = `${icon('users')}<span>${cnt} akun</span>`;
  else {
    const a = state.accounts.find(x => x.id === accs[0]?.account_id);
    accChip = `${icon('users')}<span>${esc(a ? a.label : 'Akun ?')}</span>`;
  }
  return `<article class="qcard${on ? ' is-on' : ''}">
    <div class="qhead">
      <h3 class="qtitle">${title}</h3>
      <span class="pill ${on ? 'pill-on' : 'pill-off'}">${on ? 'Berjalan' : 'Berhenti'}</span>
    </div>
    ${body}
    <div class="meta">
      <span class="chip ${bypass ? 'chip-bypass' : 'chip-auto'}">${bypass ? 'Bypass' : 'Auto'} #${n}</span>
      <span class="chip">${icon('clock')}<span>${q.delay_min}m${per}</span></span>
      <span class="chip">${accChip}</span>
    </div>
    <p class="cd js-count" data-active="${on ? 1 : 0}" data-next="${on ? nextOf(q) : ''}" data-last="${esc(q.last_run || '')}"></p>
    <div class="qfoot">
      <button type="button" class="btn ${on ? 'btn-stop' : 'btn-start'}" data-act="toggle" data-id="${q.id}" data-status="${esc(q.status)}">${icon(on ? 'stop' : 'play')}<span>${on ? 'Stop' : 'Start'}</span></button>
      <button type="button" class="btn" data-act="edit" data-id="${q.id}">${icon('edit')}<span>Edit</span></button>
      <button type="button" class="btn" data-act="clone" data-id="${q.id}">${icon('copy')}<span>Clone</span></button>
      <button type="button" class="btn btn-danger" data-act="delete" data-id="${q.id}" ${q.status==='active'?'disabled title="Stop query dulu sebelum menghapus"':''} >${icon('trash')}<span>Hapus</span></button>
    </div>
  </article>`;
}

function renderQueryFilter(auto) {
  const box = $('filter-auto');
  if (!box) return;
  const accMap = {};
  auto.forEach(q => {
    const acc = q.bypass_data?.[0];
    if (acc) accMap[String(acc.account_id)] = acc.label || ('Akun ' + acc.account_id);
  });
  const ids = Object.keys(accMap);
  // selalu tampilkan tombol filter meski tidak ada akun berbeda
  console.log('renderQueryFilter called, auto.length=', auto.length, 'box=', box);

  const cur = state.filterAcc || 'all';
  const totalAll = auto.length;
  const accCount = {};
  ids.forEach(id => { accCount[id] = auto.filter(q => String(q.bypass_data?.[0]?.account_id) === id).length; });
  const selectedLabel = cur === 'all' ? 'Semua akun' : (accMap[cur] || 'Semua akun');

  const discordSvg = `<svg class="acc-filter-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.03.056a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" fill="currentColor"/></svg>`;

  // render tombol filter
  box.innerHTML = `
    <div class="acc-filter-wrap">
      <div class="acc-filter-btn" id="acc-filter-btn" role="button" tabindex="0">
        ${discordSvg}
        <span class="acc-filter-label" id="acc-filter-label">${selectedLabel}</span>
      </div>
    </div>`;

  // render isi dialog
  const dlgList = $('acc-filter-dlg-list');
  if (dlgList) {
    const tabs = [
      { val: 'all', label: 'Semua akun', count: totalAll },
      ...ids.map(id => ({ val: id, label: accMap[id], count: accCount[id] || 0 }))
    ];
    dlgList.innerHTML = tabs.map(t => `
      <div class="acc-dlg-tab${t.val === cur ? ' active' : ''}" data-val="${t.val}">
        <svg class="acc-dlg-tab-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.002.022.015.043.03.056a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" fill="currentColor"/></svg>
        <span class="acc-dlg-tab-label">${t.label}</span>
        <span class="acc-dlg-tab-badge">${t.count}</span>
      </div>`).join('');

    dlgList.querySelectorAll('.acc-dlg-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const val = tab.dataset.val;
        state.filterAcc = val;
        const lbl = $('acc-filter-label');
        if (lbl) lbl.textContent = val === 'all' ? 'Semua akun' : (accMap[val] || 'Semua akun');
        dlgList.querySelectorAll('.acc-dlg-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        closeDialog('dlg-acc-filter');
        renderQueries(state.queries || []);
      });
    });
  }

  // buka dialog saat tombol diklik
  const btn = $('acc-filter-btn');
  if (btn) {
    btn.onclick = () => {
      const dlg = $('dlg-acc-filter');
      if (dlg && dlg.hidden === false) { closeDialog('dlg-acc-filter'); return; }
      openDialog('dlg-acc-filter', btn);
    };
    btn.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); btn.onclick(); }};
  }
}

function renderQueries(list) {
  const auto   = list.filter(q => q.query_type === 'auto');
  const bypass = list.filter(q => q.query_type === 'bypass');
  const num = {};
  auto.forEach((q, i)   => { num[q.id] = i + 1; });
  bypass.forEach((q, i) => { num[q.id] = i + 1; });
  state.isAutoAll   = auto.length   > 0 && auto.every(q   => q.status === 'active');
  state.isBypassAll = bypass.length > 0 && bypass.every(q => q.status === 'active');
  setText('count-auto',   countLabel(auto));
  setText('count-bypass', countLabel(bypass));
  toggleBtn('btn-toggle-auto',   state.isAutoAll);
  toggleBtn('btn-toggle-bypass', state.isBypassAll);
  renderQueryFilter(auto);
  const filteredAuto = state.filterAcc && state.filterAcc !== 'all'
    ? auto.filter(q => String(q.bypass_data?.[0]?.account_id) === state.filterAcc)
    : auto;
  const autoBox = $('q-list-auto');
  if (autoBox) autoBox.innerHTML = filteredAuto.length
    ? filteredAuto.map(q => cardHtml(q, num[q.id])).join('')
    : auto.length
      ? '<p class="hint" style="padding:1rem">Tidak ada query untuk akun ini.</p>'
      : emptyBlock('Belum ada Auto Post', 'Buat post otomatis pertama. Pesan dikirim berkala ke channel yang kamu pilih.', 'new-post', '+ Tambah Post');
  const bypassBox = $('q-list-bypass');
  if (bypassBox) bypassBox.innerHTML = bypass.length
    ? bypass.map(q => cardHtml(q, num[q.id])).join('')
    : emptyBlock('Belum ada Bypass', 'Gabungkan minimal dua akun untuk posting bergiliran di satu channel.', 'new-bypass', '+ Tambah Bypass');
}


async function loadQueries() {
  const boxes = [$('q-list-auto'), $('q-list-bypass')];
  if (!state.loaded.queries) boxes.forEach(b => { if (b) b.innerHTML = skeleton(2); });
  try {
    const list = await fetchQueries();
    state.loaded.queries = true;
    clearBg('queries');
    if (changed('queries', [list, state.accounts])) renderQueries(list);
    tickCountdown();
  } catch (e) {
    if (state.loaded.queries) return reportBg('queries', e.message);
    boxes.forEach(b => { if (b) b.innerHTML = errorBlock('Daftar query belum bisa dimuat.', e.message); });
  }
}

async function toggleQ(id, status, btn) {
  const isActive = status === 'active';
  if (!isActive) {
    const q = state.queries.find(x => x.id === id);
    if (!(await ask('Start query ini?', chn(q?.channel_name), 'Start', false))) return;
  }
  setBusy(btn, true);
  try {
    await api(`/queries/${id}`, { method: 'PATCH', body: JSON.stringify({ status: isActive ? 'stopped' : 'active' }) });
    toast(isActive ? 'Query dihentikan.' : 'Query dijalankan.');
    refreshNow();
  } catch (e) { toast(e.message, true); setBusy(btn, false); }
}

async function delQ(id) {
  const q = state.queries.find(x => x.id === id);
  if (!(await ask('Hapus query ini?', chn(q?.channel_name), 'Hapus'))) return;
  try { await api(`/queries/${id}`, { method: 'DELETE' }); toast('Query dihapus.'); refreshNow(); } catch(e) { toast(e.message || 'Gagal hapus query.', true); return; }
}

async function toggleAll(type) {
  try {
    const list = await fetchQueries();
    const targets = list.filter(q => q.query_type === type);
    if (!targets.length) return toast('Belum ada query di daftar ini.', true);
    const wasOn = targets.length > 0 && targets.every(q => q.status === 'active');
    const next  = wasOn ? 'stopped' : 'active';
    const label = type === 'auto' ? 'Auto Post' : 'Bypass';
    if (!(await ask(
      `${wasOn ? 'Stop' : 'Start'} semua ${label}?`,
      `${targets.length} query akan ${wasOn ? 'dihentikan' : 'dijalankan'}.`,
      wasOn ? 'Stop' : 'Start', wasOn))) return;
    const results = await Promise.allSettled(
      targets.filter(q => q.status !== next)
        .map(q => api(`/queries/${q.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) }))
    );
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed) toast(`${failed} query gagal di${next === 'active' ? 'jalankan' : 'hentikan'}.`, true);
    else toast(`Semua ${label} ${next === 'active' ? 'dijalankan' : 'dihentikan'}.`);
    refreshNow();
  } catch (e) { toast(e.message, true); }
}

async function cloneQ(id) {
  const q = state.queries.find(x => x.id === id);
  if (!q) return toast('Query tidak ditemukan, muat ulang daftar.', true);
  const p = {
    query_type: q.query_type, bypass_data: q.bypass_data || [],
    guild_id: q.guild_id || '', channel_id: q.channel_id,
    channel_name: q.channel_name, delay_min: q.delay_min,
    content: q.content || '',
    embed: q.embed || {},
    webhook_url: q.webhook_url || '',
  };
  try {
    await api('/queries', { method: 'POST', body: JSON.stringify(p) });
    toast('Query berhasil di-clone!');
    refreshNow();
  } catch (e) { toast(e.message, true); }
}

/* ───────── confirm dialog ───────── */
function ask(title, msg, okLabel = 'OK', danger = true) {
  return new Promise(resolve => {
    const d = $('dlg-confirm');
    $('confirm-title').textContent = title;
    $('confirm-msg').textContent = msg || '';
    const ok = $('confirm-ok');
    ok.textContent = okLabel;
    ok.className = `btn ${danger ? 'btn-stop' : 'btn-start'}`;
    const done = v => {
      d._cancel = null; ok.onclick = null;
      closeDialog('dlg-confirm'); resolve(v);
    };
    ok.onclick = () => done(true);
    $('confirm-no').onclick = () => done(false);
    d._cancel = () => done(false);
    openDialog('dlg-confirm', document.activeElement);
  });
}

/* ───────── logs ───────── */
function renderLogs() {
  const box = $('log-body');
  if (!box) return;
  const kw = state.logSearch.trim().toLowerCase();
  const rows = state.logs.filter(l =>
    (state.logFilter === 'ALL' || l.level === state.logFilter) &&
    (!kw || fixMsg(l.message).toLowerCase().includes(kw)));
  setText('log-count', `${rows.length} dari ${state.logs.length} log`);
  if (!rows.length) {
    box.innerHTML = state.logs.length
      ? emptyBlock('Tidak ada log yang cocok.', 'Coba ubah filter atau kata kunci.', '', '')
      : emptyBlock('Belum ada log.', 'Log akan muncul saat query berjalan.', '', '');
    return;
  }
  box.innerHTML = `<ul class="loglist">${rows.map(logItem).join('')}</ul>`;
}

async function loadLogs() {
  const box = $('log-body');
  if (!state.loaded.logs && box) box.innerHTML = skeleton(1);
  try {
    const list = await api('/logs?limit=200');
    state.loaded.logs = true;
    clearBg('logs');
    if (changed('logs', list)) { state.logs = list; renderLogs(); }
  } catch (e) {
    if (state.loaded.logs) return reportBg('logs', e.message);
    if (box) box.innerHTML = errorBlock('Log belum bisa dimuat.', e.message);
  }
}

function exportLogs() {
  if (!state.logs.length) return toast('Belum ada log untuk diunduh.', true);
  const q = s => '"' + String(s ?? '').replace(/"/g, '""') + '"';
  const csv = ['time,level,message',
    ...state.logs.map(l => [fullTime(l.ts), l.level, fixMsg(l.message)].map(q).join(','))
  ].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lepost-logs.csv';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ───────── event delegation ───────── */
document.addEventListener('click', e => {
  // Filter akun pills
  const pill = e.target.closest('[data-filter-acc]');
  if (pill) {
    state.filterAcc = pill.dataset.filterAcc;
    renderQueries(state.queries || []);
    return;
  }
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const id = Number(el.dataset.id);
  switch (el.dataset.act) {
    case 'logout':           ask('Logout', 'Yakin mau logout?', 'Logout', false).then(ok => { if (ok) logout(); }); return;
    case 'open-admin':       return openAdmin(el);
    case 'open-lic':         return openLicense(el);
    case 'copy-key':         return copyText(el.dataset.key);
    case 'del-key':          return delKey(id);
    case 'revoke-key':       return revokeKey(id);
    case 'save-user':        return saveUser(id, el);
    case 'del-user':         return delUser(id, el.dataset.name);
    case 'toggle-user-edit': return toggleUserEdit(id);
    case 'suspend-user':     return suspendUser(id, el);
    case 'stop-queries':     return stopUserQueries(id);
    case 'refresh':          return refreshNow();
    case 'toggle':           return toggleQ(id, el.dataset.status, el);
    case 'edit':             return editQ(id);
    case 'clone':            { const q = state.queries.find(x => x.id === id); ask('Clone Query', q ? `Clone "${q.channel_name}"?` : 'Clone query ini?', 'Clone', false).then(ok => { if (ok) cloneQ(id); }); return; }
    case 'delete':           return delQ(id);
    case 'toggle-all':       return toggleAll(el.dataset.type);
    case 'new-post':         return openPost(el);
    case 'new-bypass':       return openBypass(el);
    case 'open-acc':         return openAccounts(el);
    case 'del-acc':          return hapusAkun(id);
    case 'edit-label':       return editLabel(id, el.dataset.label);
    case 'open-status': {
      const acc = state.accounts.find(a => a.id === parseInt(el.dataset.id));
      if (acc) openStatusDialog(acc);
      break;
    }
    case 'edit-token':       return openEditToken(id, el.dataset.label, el);
    case 'open-webhook':     return openWebhookDialog(id, el.dataset.label);
    case 'close-edit-token': return closeDialog('dlg-edit-token');
    case 'select-all':       return selectAllBypass();
    case 'export-csv':       return exportLogs();
    case 'close':            return closeDialog(el.dataset.dialog);
    case 'admin-stop-user':  return adminStopUserQueries(id, el.dataset.name);
    case 'ban-ip': banIP(); break;
    case 'admin-stop-all':   return adminStopAll();
    case 'export-users-csv': return exportUsersCSV();
    case 'clear-broadcast':  return clearBroadcast();
  }
});

/* ───────── wiring form & nav ───────── */
$('login-form')?.addEventListener('submit', submitLogin);
$('signup-form')?.addEventListener('submit', submitSignup);
$('form-key')?.addEventListener('submit', submitKey);
$('form-redeem')?.addEventListener('submit', submitRedeem);
$('form-broadcast')?.addEventListener('submit', submitBroadcast);
document.querySelectorAll('[data-auth]').forEach(b =>
  b.addEventListener('click', () => setAuthTab(b.dataset.auth)));
document.querySelectorAll('[data-atab]').forEach(b =>
  b.addEventListener('click', () => setAdminTab(b.dataset.atab)));
$('form-post')?.addEventListener('submit', submitPost);
$('form-bypass')?.addEventListener('submit', submitBypass);
$('form-acc')?.addEventListener('submit', submitAccount);
$('form-edit-token')?.addEventListener('submit', submitEditToken);
$('post-acc')?.addEventListener('change', e => loadGuilds(e.target.value, 'post'));
$('post-guild')?.addEventListener('change', e => loadChannels($('post-acc').value, e.target.value, 'post'));
$('bypass-guild')?.addEventListener('change', e => loadChannels(state.bypassRef, e.target.value, 'bypass'));
$('bypass-accounts')?.addEventListener('change', onBypassPick);
$('bypass-total-slowmode')?.addEventListener('input', recalcBypassDelay);
['post', 'bypass'].forEach(mode => {
  $(`${mode}-ch-search`)?.addEventListener('input', () => renderChannelOptions(mode));
  $(`${mode}-channel`)?.addEventListener('change', () => onPickChannel(mode));
});
$('log-seg')?.addEventListener('click', e => {
  const b = e.target.closest('button[data-l]');
  if (!b) return;
  state.logFilter = b.dataset.l;
  document.querySelectorAll('#log-seg button').forEach(x =>
    x.setAttribute('aria-pressed', String(x === b)));
  renderLogs();
});
$('log-q')?.addEventListener('input', e => { state.logSearch = e.target.value; renderLogs(); });

/* ───────── boot ───────── */
async function boot() {
  loadContact();
  if (!state.token) state.token = localStorage.getItem('token') || '';
  if (!state.token) {
    const vl = $('view-login');
    if (vl) vl.hidden = false;
    initHeroCounters();
    return;
  }
  const app = $('app');
  if (app) app.hidden = false;
  if (!TABS.includes(location.hash.replace('#', ''))) history.replaceState(null, '', '#dashboard');
  showTab(currentRoute());
  try { state.me = await api('/me'); } catch { return; }
  renderMe();
  if (!state.me.is_admin) {
    // Blokir semua kalau suspended
    if (state.me.is_suspended) {
      const main = $('main');
      if (main) main.innerHTML =
        '<div class="notice exp-banner" style="border-color:#ef4444">' +
        '<p class="notice-title" style="color:#ef4444">⛔ Akun Disuspend</p>' +
        '<p class="notice-msg">Akun kamu telah dikunci oleh admin. Hubungi owner untuk informasi lebih lanjut.</p>' +
        '</div>';
    }
    // Bypass: tab tetap muncul, lock konten kalau tidak allow
    if (!state.me.allow_bypass) {
      const sec = document.querySelector('[data-view="bypass"]');
      if (sec) sec.innerHTML =
        '<div class="notice exp-banner" style="margin:24px 16px;border-color:#f59e0b">' +
        '<p class="notice-title" style="color:#f59e0b">Fitur Terkunci</p>' +
        '<p class="notice-msg">Fitur Bypass belum aktif. Hubungi owner untuk upgrade.</p>' +
        '</div>';
    }
    // Dashboard stats: lock kalau tidak allow_dashboard
    if (!state.me.allow_dashboard) {
      const elStats = document.querySelector('.stats');
      const elChart = document.querySelector('#chart')?.closest('.panel');
      const lockHtml =
        '<div class="notice exp-banner" style="margin:8px 0;border-color:#f59e0b">' +
        '<p class="notice-title" style="color:#f59e0b">Fitur Terkunci</p>' +
        '<p class="notice-msg">Statistik belum aktif. Hubungi owner untuk upgrade.</p>' +
        '</div>';
      if (elStats) elStats.innerHTML = lockHtml;
      if (elChart) elChart.innerHTML = lockHtml;
    }
  }
  if (state.me && state.me.expired) {
    const main = $('main');
    if (main) main.innerHTML =
      '<div class="notice exp-banner"><p class="notice-title">Masa aktif habis</p>' +
      '<p class="notice-msg">Masukkan key baru atau hubungi owner buat perpanjang.</p>' +
      '<button type="button" class="btn btn-primary" data-act="open-lic" style="margin-top:10px">Perpanjang sekarang</button></div>';
    openLicense();
    return;
  }
  await loadAccounts();
  showTab(currentRoute());
  loadBroadcastBanner();
  state.refreshTimer   = setInterval(refreshCurrent, REFRESH_MS);
  state.countdownTimer = setInterval(tickCountdown, 1000);
  setInterval(() => api('/me').then(m => {
    const wasExpired = state.me?.expired;
    state.me = m;
    renderMe();
    // Akun baru saja di-suspend saat user sedang aktif
    if (m.is_suspended) {
      clearInterval(state.refreshTimer);
      clearInterval(state.countdownTimer);
      const main = $('main');
      if (main) main.innerHTML =
        '<div class="notice exp-banner" style="border-color:#ef4444">' +
        '<p class="notice-title" style="color:#ef4444">⛔ Akun Disuspend</p>' +
        '<p class="notice-msg">Akun kamu telah dikunci oleh admin. Hubungi owner untuk informasi lebih lanjut.</p>' +
        '</div>';
      return;
    }
    // Lisensi baru saja habis saat user sedang aktif pakai — tampilkan layar expired
    if (m.expired && !wasExpired) {
      clearInterval(state.refreshTimer);
      clearInterval(state.countdownTimer);
      const main = $('main');
      if (main) main.innerHTML =
        '<div class="notice exp-banner"><p class="notice-title">Masa aktif habis</p>' +
        '<p class="notice-msg">Masukkan key baru atau hubungi owner buat perpanjang.</p>' +
        '<button type="button" class="btn btn-primary" data-act="open-lic" style="margin-top:10px">Perpanjang sekarang</button></div>';
      openLicense();
    }
  }).catch(() => {
    // api() sudah handle 401 dengan memanggil logout() langsung, abaikan error lain
  }), 15000);
  setInterval(loadBroadcastBanner, 15000);
}
boot();

// === BLACKLIST IP ===
async function loadBlacklist() {
  const box = $('blacklist-list');
  if (!box) return;
  try {
    const data = await api('/admin/blacklist');
    if (!data.length) { box.innerHTML = '<p class="hint">Belum ada IP yang di-ban.</p>'; return; }
    box.innerHTML = data.map(r => `
      <div class="acc-item" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div>
          <strong>${esc(r.ip)}</strong>
          ${r.reason ? `<span class="hint" style="margin-left:8px">${esc(r.reason)}</span>` : ''}
          <span class="hint" style="margin-left:8px">${r.created_at ? r.created_at.slice(0,10) : ''}</span>
        </div>
        <button class="btn btn-sm btn-danger" onclick="unbanIP(${r.id}, '${esc(r.ip)}')">Unban</button>
      </div>
    `).join('');
  } catch(e) {
    box.innerHTML = '<p class="hint">Gagal memuat blacklist.</p>';
  }
}

async function unbanIP(id, ip) {
  if (!await ask('Unban IP ini?', ip, 'Unban')) return;
  try {
    await api('/admin/blacklist/' + id, { method: 'DELETE' });
    toast('IP ' + ip + ' berhasil di-unban.');
    loadBlacklist();
  } catch(e) {
    toast('Gagal unban: ' + e.message, true);
  }
}

async function banIP() {
  const ip = $('bl-ip').value.trim();
  const reason = $('bl-reason').value.trim();
  if (!ip) { toast('IP tidak boleh kosong', true); return; }
  try {
    await api('/admin/blacklist', { method: 'POST', body: JSON.stringify({ ip, reason }) });
    toast('IP ' + ip + ' berhasil di-ban.');
    $('bl-ip').value = '';
    $('bl-reason').value = '';
    loadBlacklist();
  } catch(e) {
    toast('Gagal ban: ' + e.message, true);
  }
}

/* ── Sidebar ── */
(function(){
  function openSidebar(){
    document.getElementById('sidebar')?.classList.add('open');
    document.getElementById('sidebar-backdrop')?.classList.add('open');
    document.body.style.overflow='hidden';
  }
  function closeSidebar(){
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebar-backdrop')?.classList.remove('open');
    document.body.style.overflow='';
  }
  document.addEventListener('DOMContentLoaded',function(){
    document.getElementById('sidebar-toggle-btn')?.addEventListener('click',openSidebar);
    document.getElementById('sidebar-close-btn')?.addEventListener('click',closeSidebar);
    document.getElementById('sidebar-backdrop')?.addEventListener('click',closeSidebar);
    document.querySelectorAll('.sidebar-item').forEach(function(el){
      el.addEventListener('click',closeSidebar);
    });
  });
})();
/* ───────── Status Discord ───────── */
function openStatusDialog(acc) {
  $('status-acc-id').value = acc.id;
  $('dlg-status-sub').textContent = 'Status untuk ' + acc.label + '. Perubahan diterapkan ke akun Discord ini.';
  document.querySelectorAll('#status-seg [data-s]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.s === (acc.discord_status || 'online')));
  });
  $('status-emoji').value = acc.discord_custom_emoji || '';
  $('status-text').value = acc.discord_custom_text || '';
  $('status-keep-online').checked = !!(acc.keep_online);
  openDialog('dlg-status');
}

document.addEventListener('click', e => {
  const sb = e.target.closest('#status-seg [data-s]');
  if (sb) {
    document.querySelectorAll('#status-seg [data-s]').forEach(b => b.setAttribute('aria-pressed', 'false'));
    sb.setAttribute('aria-pressed', 'true');
  }
});

let _statusLastSave = 0;
const STATUS_COOLDOWN_MS = 5000; // 5 detik cooldown
$('btn-save-status') && ($('btn-save-status').onclick = async () => {
  const now = Date.now();
  const sisa = STATUS_COOLDOWN_MS - (now - _statusLastSave);
  if (sisa > 0) {
    toast(`Tunggu ${Math.ceil(sisa/1000)} detik sebelum mengubah status lagi (menghindari rate limit Discord).`, true);
    return;
  }
  const aid = $('status-acc-id').value;
  const status = document.querySelector('#status-seg [aria-pressed="true"]')?.dataset.s || 'online';
  const btn = $('btn-save-status');
  setBusy(btn, true);
  try {
    await api(`/accounts/${aid}/presence`, {
      method: 'PATCH',
      body: JSON.stringify({
        discord_status: status,
        discord_custom_text: $('status-text').value.trim(),
        discord_custom_emoji: $('status-emoji').value.trim(),
        keep_online: $('status-keep-online').checked ? 1 : 0,
      })
    });
      const accIdx = state.accounts.findIndex(a => String(a.id) === String(aid));
      if (accIdx !== -1) Object.assign(state.accounts[accIdx], {discord_status: status, discord_custom_text: $('status-text').value.trim(), discord_custom_emoji: $('status-emoji').value.trim(), keep_online: $('status-keep-online').checked ? 1 : 0});
    _statusLastSave = Date.now();
    renderAccountList();
    toast('Status disimpan.');
    closeDialog('dlg-status');
  } catch (err) {
    toast(err.message, true);
  } finally {
    setBusy(btn, false);
  }
});

/* ───────── Bulk Webhook ───────── */
function openWebhookDialog(aid, label) {
  $('webhook-acc-id').value = aid;
  $('dlg-webhook-sub').textContent = 'Ganti webhook semua channel milik akun ' + label + '.';
  $('webhook-url-input').value = '';
  openDialog('dlg-webhook');
}

$('btn-save-webhook') && ($('btn-save-webhook').onclick = async () => {
  const aid = $('webhook-acc-id').value;
  const webhook_url = $('webhook-url-input').value.trim();
  const btn = $('btn-save-webhook');
  setBusy(btn, true);
  try {
    const res = await api(`/accounts/${aid}/webhook`, {
      method: 'PATCH',
      body: JSON.stringify({ webhook_url })
    });
    toast(`Webhook diperbarui. ${res.updated} channel diupdate.`);
    closeDialog('dlg-webhook');
  } catch (err) {
    toast(err.message, true);
  } finally {
    setBusy(btn, false);
  }
});

/* ───────── Custom RPC ───────── */
let _rpcAccId = null;

async function loadRpcPage() {
  const tabs = $('rpc-tabs');
  const content = $('rpc-content');
  if (!tabs || !content) return;
  const accs = state.accounts;
  if (!accs.length) {
    content.innerHTML = '<p class="hint">Belum ada akun. Tambah akun dulu di menu Akun.</p>';
    return;
  }
  if (!_rpcAccId) _rpcAccId = accs[0].id;
  tabs.innerHTML = accs.map(a =>
    `<button type="button" data-rpc-tab="${a.id}" aria-pressed="${a.id === _rpcAccId}">${esc(a.label)}</button>`
  ).join('');
  tabs.querySelectorAll('[data-rpc-tab]').forEach(b => {
    b.addEventListener('click', () => {
      _rpcAccId = parseInt(b.dataset.rpcTab);
      loadRpcPage();
    });
  });
  const acc = accs.find(a => a.id === _rpcAccId);
  if (!acc) return;
  let rpc = {};
  try { rpc = JSON.parse(acc.rpc_json || '{}'); } catch {}
  content.innerHTML = `
    <div class="acc-form">
      <h3>Pengaturan RPC untuk ${esc(acc.label)}</h3>
      <div class="field"><label class="label">Activity type</label>
        <select id="rpc-type" class="select">
          <option value="0" ${rpc.type==0?'selected':''}>Playing (Bermain)</option>
          <option value="1" ${rpc.type==1?'selected':''}>Streaming</option>
          <option value="2" ${rpc.type==2?'selected':''}>Listening</option>
          <option value="3" ${rpc.type==3?'selected':''}>Watching</option>
          <option value="5" ${rpc.type==5?'selected':''}>Competing</option>
        </select>
      </div>
      <div class="field"><label class="label">Activity name</label><input id="rpc-name" class="input" placeholder="Contoh: LePost" value="${esc(rpc.name||'')}"></div>
      <div class="field"><label class="label">Application ID</label><input id="rpc-appid" class="input" placeholder="Angka dari Developer Portal" value="${esc(rpc.app_id||'')}"></div>
      <div class="field"><label class="label">Details</label><input id="rpc-details" class="input" placeholder="Baris pertama" value="${esc(rpc.details||'')}"></div>
      <div class="field"><label class="label">State</label><input id="rpc-state" class="input" placeholder="Baris kedua" value="${esc(rpc.state||'')}"></div>
      <div class="field"><label class="label">Gambar besar (URL atau nama asset)</label><input id="rpc-large-img" class="input" placeholder="https://..." value="${esc(rpc.large_image||'')}"></div>
      <div class="field"><label class="label">Large tooltip</label><input id="rpc-large-text" class="input" placeholder="Teks saat gambar besar disorot" value="${esc(rpc.large_text||'')}"></div>
      <div class="field"><label class="label">Small image URL</label><input id="rpc-small-img" class="input" placeholder="https://..." value="${esc(rpc.small_image||'')}"></div>
      <div class="field"><label class="label">Small tooltip</label><input id="rpc-small-text" class="input" placeholder="Teks saat gambar kecil disorot" value="${esc(rpc.small_text||'')}"></div>
      <div class="field"><label class="label">Tombol 1 label</label><input id="rpc-btn1-label" class="input" placeholder="Contoh: Order sekarang" value="${esc(rpc.btn1_label||'')}"></div>
      <div class="field"><label class="label">Tombol 1 URL</label><input id="rpc-btn1-url" class="input" placeholder="https://..." value="${esc(rpc.btn1_url||'')}"></div>
      <div class="field"><label class="label">Tombol 2 label</label><input id="rpc-btn2-label" class="input" placeholder="Contoh: Gabung Discord" value="${esc(rpc.btn2_label||'')}"></div>
      <div class="field"><label class="label">Tombol 2 URL</label><input id="rpc-btn2-url" class="input" placeholder="https://..." value="${esc(rpc.btn2_url||'')}"></div>
      <div class="field">
        <label class="label" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="rpc-elapsed" ${rpc.elapsed?'checked':''}> Elapsed time (waktu berjalan)
        </label>
        <div id="rpc-elapsed-fields" style="margin-top:8px;flex-direction:column;gap:6px;display:${rpc.elapsed?'flex':'none'}">
          <div style="display:flex;align-items:center;gap:8px">
            <input id="rpc-elapsed-h" class="input" type="number" min="0" placeholder="0" value="${rpc.elapsed_h||0}" style="flex:1"> <span style="min-width:40px">jam</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <input id="rpc-elapsed-m" class="input" type="number" min="0" max="59" placeholder="0" value="${rpc.elapsed_m||0}" style="flex:1"> <span style="min-width:40px">menit</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <input id="rpc-elapsed-s" class="input" type="number" min="0" max="59" placeholder="0" value="${rpc.elapsed_s||0}" style="flex:1"> <span style="min-width:40px">detik</span>
          </div>
          <button type="button" class="btn btn-sm" style="width:fit-content" onclick="$('rpc-elapsed-h').value=0;$('rpc-elapsed-m').value=0;$('rpc-elapsed-s').value=0">&#x21BA; Reset ke 0</button>
          <p class="hint" style="margin:0">Isi waktu yang sudah berjalan saat ini, misalnya 2 jam. Tombol reset mengulang dari 00:00:00.</p>
        </div>
      </div>
      <div class="acc-form" style="margin-top:16px;border-top:1px solid rgba(255,255,255,0.08);padding-top:16px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
          <b>Pratinjau</b>
          <span class="badge ${rpc.enabled?'badge-ok':'badge-bad'}">${rpc.enabled?'Aktif':'Nonaktif'}</span>
        </div>
        <div style="background:#1e2029;border-radius:8px;padding:12px;display:flex;gap:12px;align-items:center">
          ${rpc.large_image?`<img src="${esc(rpc.large_image)}" style="width:60px;height:60px;border-radius:8px;object-fit:cover">` : '<div style="width:60px;height:60px;border-radius:8px;background:#2e3038"></div>'}
          <div>
            <p style="font-size:0.8em;color:#b0b4c1;margin:0">${rpc.type==1?'Streaming':rpc.type==2?'Listening to':rpc.type==3?'Watching':rpc.type==5?'Competing in':'Sedang bermain'}</p>
            <p style="margin:2px 0;font-weight:600">${esc(rpc.name||'Nama aktivitas')}</p>
            ${rpc.details?`<p style="font-size:0.85em;margin:0;color:#b0b4c1">${esc(rpc.details)}</p>`:''}
            ${rpc.state?`<p style="font-size:0.85em;margin:0;color:#b0b4c1">${esc(rpc.state)}</p>`:''}
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:16px"><button type="button" id="btn-save-rpc" class="btn btn-primary">Simpan dan aktifkan RPC</button><button type="button" id="btn-disable-rpc" class="btn btn-danger">Nonaktifkan</button></div>
      <p class="hint" style="margin-top:8px">Tombol RPC tidak terlihat di profilmu sendiri, hanya oleh orang lain. Gambar dari URL didaftarkan otomatis lewat Application ID. Status online, idle, atau jangan ganggu diatur di menu Akun Discord, tombol Atur status.</p>
    </div>
  `;
  // Pratinjau realtime
  function updatePreview() {
    const type = parseInt($('rpc-type').value)||0;
    const name = $('rpc-name').value.trim()||'Nama aktivitas';
    const details = $('rpc-details').value.trim();
    const state = $('rpc-state').value.trim();
    const img = $('rpc-large-img').value.trim();
    const typeLabel = type==1?'Streaming':type==2?'Listening to':type==3?'Watching':type==5?'Competing in':'Sedang bermain';
    const preview = document.getElementById('rpc-preview');
    if (!preview) return;
    preview.innerHTML = `
      <div style="background:#1e2029;border-radius:8px;padding:12px;display:flex;gap:12px;align-items:center">
        ${img ? `<img src="${img}" style="width:60px;height:60px;border-radius:8px;object-fit:cover" onerror="this.style.display='none'">` : '<div style="width:60px;height:60px;border-radius:8px;background:#2e3038;flex-shrink:0"></div>'}
        <div>
          <p style="font-size:0.8em;color:#b0b4c1;margin:0">${typeLabel}</p>
          <p style="margin:2px 0;font-weight:600">${name}</p>
          ${details ? `<p style="font-size:0.85em;margin:0;color:#b0b4c1">${details}</p>` : ''}
          ${state ? `<p style="font-size:0.85em;margin:0;color:#b0b4c1">${state}</p>` : ''}
        </div>
      </div>`;
  }
  const elapsedCb = $('rpc-elapsed');
  const elapsedFields = document.getElementById('rpc-elapsed-fields');
  if (elapsedCb && elapsedFields) {
    elapsedFields.style.display = elapsedCb.checked ? 'flex' : 'none';
    elapsedCb.addEventListener('change', () => {
      elapsedFields.style.display = elapsedCb.checked ? 'flex' : 'none';
    });
  }
  ['rpc-type','rpc-name','rpc-details','rpc-state','rpc-large-img'].forEach(id => {
    const el = $(id); if (el) el.addEventListener('input', updatePreview);
  });
  updatePreview();

  const btnDis = $('btn-disable-rpc');
  if (btnDis) btnDis.addEventListener('click', async () => {
    setBusy(btnDis, true);
    try {
      await api(`/accounts/${_rpcAccId}/rpc`, { method: 'PATCH', body: JSON.stringify({ rpc_json: JSON.stringify({enabled:false}) }) });
      toast('RPC dinonaktifkan.');
      await loadAccounts();
      loadRpcPage();
    } catch(err) { toast(err.message, true); }
    finally { setBusy(btnDis, false); }
  });
  $('btn-save-rpc').addEventListener('click', async () => {
    const btn = $('btn-save-rpc');
    const eh = parseInt($('rpc-elapsed-h').value)||0;
    const em = parseInt($('rpc-elapsed-m').value)||0;
    const es = parseInt($('rpc-elapsed-s').value)||0;
    const rpcData = {
      enabled: true,
      type: parseInt($('rpc-type').value)||0,
      name: $('rpc-name').value.trim(),
      app_id: $('rpc-appid').value.trim(),
      details: $('rpc-details').value.trim(),
      state: $('rpc-state').value.trim(),
      large_image: $('rpc-large-img').value.trim(),
      large_text: $('rpc-large-text').value.trim(),
      small_image: $('rpc-small-img').value.trim(),
      small_text: $('rpc-small-text').value.trim(),
      btn1_label: $('rpc-btn1-label').value.trim(),
      btn1_url: $('rpc-btn1-url').value.trim(),
      btn2_label: $('rpc-btn2-label').value.trim(),
      btn2_url: $('rpc-btn2-url').value.trim(),
      elapsed: $('rpc-elapsed').checked,
      elapsed_h: eh, elapsed_m: em, elapsed_s: es,
      elapsed_sec: eh*3600 + em*60 + es,
    };
    setBusy(btn, true);
    try {
      await api(`/accounts/${_rpcAccId}/rpc`, {
        method: 'PATCH',
        body: JSON.stringify({ rpc_json: JSON.stringify(rpcData) })
      });
      toast('RPC disimpan dan diaktifkan.');
      await loadAccounts();
      loadRpcPage();
    } catch (err) {
      toast(err.message, true);
    } finally {
      setBusy(btn, false);
    }
  });
}
