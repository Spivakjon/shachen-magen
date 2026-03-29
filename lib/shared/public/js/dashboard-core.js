// ═══════════════════════════════════════════
// Shared Dashboard — Core Framework
// ═══════════════════════════════════════════

// ─── Auth state ───

const AUTH_KEY = 'sd_auth_token';

function getToken() {
  return localStorage.getItem(AUTH_KEY);
}

function setToken(token) {
  localStorage.setItem(AUTH_KEY, token);
}

function clearToken() {
  localStorage.removeItem(AUTH_KEY);
}

function authHeaders() {
  const token = getToken();
  return token ? { 'Authorization': 'Bearer ' + token } : {};
}

// ─── Utilities (exported for custom pages) ───

export async function api(path, opts = {}) {
  const headers = { ...authHeaders(), ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    showLoginScreen();
    throw new Error('Unauthorized');
  }
  return res.json();
}

export function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

export function trunc(str, max = 80) {
  if (!str) return '<span style="color:var(--text-dim)">\u2014</span>';
  const safe = esc(str);
  return str.length > max ? safe.slice(0, max) + '...' : safe;
}

export function timeAgo(dateStr) {
  if (!dateStr) return '\u2014';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '\u05e2\u05db\u05e9\u05d9\u05d5';
  if (mins < 60) return mins + ' \u05d3\u05f3 \u05dc\u05e4\u05e0\u05d9';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + ' \u05e9\u05f3 \u05dc\u05e4\u05e0\u05d9';
  return Math.floor(hrs / 24) + ' \u05d9\u05f3 \u05dc\u05e4\u05e0\u05d9';
}

export function formatTime(dateStr) {
  if (!dateStr) return '\u2014';
  return new Date(dateStr).toLocaleString('he-IL', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export function badge(type, text) {
  return `<span class="badge ${esc(type)}">${esc(text)}</span>`;
}

export function emptyRow(cols, msg) {
  return `<tr><td colspan="${cols}" class="empty-row">${esc(msg || '\u05d0\u05d9\u05df \u05e0\u05ea\u05d5\u05e0\u05d9\u05dd')}</td></tr>`;
}

// ─── Internal state ───
let _config = null;
let _refreshTimer = null;

export function getConfig() { return _config; }

// ─── Settings helpers ───

function _prefix() {
  return (_config?.features?.storagePrefix || 'sd_');
}

function _settingsKey(key) {
  return _prefix() + 'settings_' + key;
}

function _loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(_settingsKey(key))); }
  catch { return null; }
}

function _saveJSON(key, val) {
  localStorage.setItem(_settingsKey(key), JSON.stringify(val));
  _syncSettingsToDb();
}

// ─── DB persistence layer ───

let _dbAvailable = false;
let _dbSaveTimer = null;
const _DB_DEBOUNCE = 1500;

const _SETTINGS_KEYS = [
  'tab_groups', 'tab_groups_collapsed', 'hidden_tabs', 'tab_labels', 'tab_icons',
  'project_name', 'logo', 'project_icon', 'footer_labels', 'font_size',
  'stat_labels', 'table_headers', 'skill_names'
];

const _PROJECT_SPECIFIC_KEYS = ['project_name', 'logo', 'project_icon'];
let _settingsFlushBound = false;

// Shared system tabs — renaming requires password and auto-broadcasts to all projects
const _SHARED_SYSTEM_TABS = [
  'dashboard-categories', 'dashboard-settings',
];
const _SHARED_TAB_PASSWORD = '8945';

async function _fetchSettingsFromDb() {
  try {
    const res = await api('/admin/api/dashboard-settings');
    if (res.ok && res.settings) { _dbAvailable = true; return res.settings; }
  } catch { _dbAvailable = false; }
  return null;
}

function _collectAllSettings() {
  const blob = {};
  for (const k of _SETTINGS_KEYS) {
    const v = _loadJSON(k);
    if (v !== null) blob[k] = v;
  }
  try {
    const nav = localStorage.getItem(_prefix() + 'nav_order');
    if (nav) blob.nav_order = JSON.parse(nav);
  } catch {}
  // Preserve broadcast timestamp so it survives round-trips
  const storedTs = localStorage.getItem(_prefix() + '_broadcast_ts');
  if (storedTs) blob._broadcast_ts = parseInt(storedTs, 10);
  return blob;
}

function _hasAnyLocalSettings() {
  for (const k of _SETTINGS_KEYS) {
    if (localStorage.getItem(_settingsKey(k)) !== null) return true;
  }
  return localStorage.getItem(_prefix() + 'nav_order') !== null;
}

function _applyDbSettings(dbSettings) {
  if (!dbSettings || typeof dbSettings !== 'object') return;
  for (const k of _SETTINGS_KEYS) {
    if (dbSettings[k] !== undefined) {
      localStorage.setItem(_settingsKey(k), JSON.stringify(dbSettings[k]));
    }
  }
  if (dbSettings.nav_order) {
    localStorage.setItem(_prefix() + 'nav_order', JSON.stringify(dbSettings.nav_order));
  }
  // Store broadcast timestamp so we can detect newer broadcasts on next load
  if (dbSettings._broadcast_ts) {
    localStorage.setItem(_prefix() + '_broadcast_ts', String(dbSettings._broadcast_ts));
  }
}

function _syncSettingsToDb(broadcast = true) {
  clearTimeout(_dbSaveTimer);
  _dbSaveTimer = setTimeout(async () => {
    try {
      await api('/admin/api/dashboard-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(_collectAllSettings()),
      });
      _dbAvailable = true;
      if (broadcast) _broadcastSettingsToHub();
    } catch {
      _dbAvailable = false;
    }
  }, _DB_DEBOUNCE);
}

async function _syncSettingsToDbNow(broadcast = false) {
  try {
    await api('/admin/api/dashboard-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(_collectAllSettings()),
    });
    _dbAvailable = true;
    if (broadcast) _forcebroadcast();
  } catch {
    _dbAvailable = false;
  }
}

// ─── Broadcast settings to all projects via Hub ───

let _broadcastTimer = null;
const _BROADCAST_DEBOUNCE = 2500;

function _broadcastSettingsToHub() {
  const currentPort = parseInt(location.port, 10);
  if (currentPort === 3000) return; // Hub itself — skip
  clearTimeout(_broadcastTimer);
  _broadcastTimer = setTimeout(async () => {
    const hubUrl = _config?.hubUrl || 'http://localhost:3000';
    try {
      await fetch(`${hubUrl}/api/broadcast-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: _collectAllSettings(), senderPort: currentPort }),
        signal: AbortSignal.timeout(5000),
      });
    } catch { /* Hub down — silently fail */ }
  }, _BROADCAST_DEBOUNCE);
}

// ─── Poll for broadcast updates from other projects ───

let _lastBroadcastTs = 0;
let _pollTimer = null;

function _startSettingsPoll() {
  const currentPort = parseInt(location.port, 10);
  if (currentPort === 3000) return; // Hub doesn't poll
  // Clear session guard on fresh tab so future broadcasts trigger reloads
  sessionStorage.removeItem('_sd_broadcast_reload');
  _pollTimer = setInterval(async () => {
    try {
      const res = await api('/admin/api/dashboard-settings');
      if (!res.ok || !res.settings) return;
      const ts = res.settings._broadcast_ts || 0;
      if (ts > _lastBroadcastTs) {
        _lastBroadcastTs = ts;
        // Apply shared keys to localStorage (skip project-specific)
        const shared = { ...res.settings };
        for (const k of _PROJECT_SPECIFIC_KEYS) delete shared[k];
        _applyDbSettings(shared);
        // Reload to reflect changes
        location.reload();
      }
    } catch { /* polling failed — retry next cycle */ }
  }, 30_000);
}

async function _backgroundDbSync() {
  const dbSettings = await _fetchSettingsFromDb();
  if (!dbSettings || !_dbAvailable) return;

  const dbTs = dbSettings._broadcast_ts || 0;
  const localTs = parseInt(localStorage.getItem(_prefix() + '_broadcast_ts') || '0', 10) || 0;
  _lastBroadcastTs = dbTs;
  const hasLocal = _hasAnyLocalSettings();

  // First run on a clean browser: hydrate from DB.
  if (!hasLocal && Object.keys(dbSettings).length > 0) {
    _applyDbSettings(dbSettings);
    location.reload();
    return;
  }

  // Never auto-push local cache on load; stale cache must not overwrite DB.
  if (hasLocal) {
    if (dbTs > localTs) {
      _applyDbSettings(dbSettings);
      location.reload();
    }
    return;
  }
}

function _showToast(msg) {
  let toast = document.getElementById('sd-settings-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'sd-settings-toast';
    toast.className = 'settings-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

let _hubStatusCache = null;
let _hubStatusTs = 0;

async function _getHubStatus(force = false) {
  if (!force && _hubStatusCache && (Date.now() - _hubStatusTs) < 3000) return _hubStatusCache;

  // Prefer project backend endpoint when available.
  try {
    const res = await api('/admin/api/hub/status');
    if (res && typeof res.hubUp === 'boolean') {
      _hubStatusCache = res;
      _hubStatusTs = Date.now();
      return _hubStatusCache;
    }
  } catch { /* fallback below */ }

  // Fallback: direct Hub health probe (works even on older project backend).
  const hubUrl = _config?.hubUrl || 'http://localhost:3000';
  try {
    const r = await fetch(hubUrl + '/health', { signal: AbortSignal.timeout(1200) });
    _hubStatusCache = { ok: true, hubUrl, hubUp: r.ok };
  } catch {
    _hubStatusCache = { ok: true, hubUrl, hubUp: false };
  }
  _hubStatusTs = Date.now();
  return _hubStatusCache;
}

async function _showHubSaveNotice() {
  const st = await _getHubStatus();
  if (!st?.hubUp) {
    _showToast("\u26A0 HUB \u05E1\u05D2\u05D5\u05E8 \u2014 \u05E0\u05E9\u05DE\u05E8 \u05DE\u05E7\u05D5\u05DE\u05D9\u05EA \u05D1\u05DC\u05D1\u05D3");
  }
}

async function _refreshHubStatusUi() {
  const badge = document.getElementById("sd-hub-status-badge");
  const btn = document.getElementById("sd-hub-start-btn");
  if (!badge) return;
  const st = await _getHubStatus(true);
  if (st?.hubUp) {
    badge.textContent = "HUB \u05E4\u05E2\u05D9\u05DC \u2014 \u05E9\u05DE\u05D9\u05E8\u05D4 \u05DC\u05BEDB \u05DE\u05E8\u05DB\u05D6\u05D9";
    badge.style.color = "var(--green)";
    if (btn) btn.style.display = "none";
  } else {
    badge.textContent = "HUB \u05E1\u05D2\u05D5\u05E8 \u2014 \u05E9\u05DE\u05D9\u05E8\u05D4 \u05DE\u05E7\u05D5\u05DE\u05D9\u05EA \u05D1\u05DC\u05D1\u05D3";
    badge.style.color = "var(--yellow)";
    if (btn) btn.style.display = "";
  }
}

async function _startHubFromSettings() {
  const btn = document.getElementById("sd-hub-start-btn");
  if (btn) { btn.disabled = true; btn.textContent = "\u05DE\u05D3\u05DC\u05D9\u05E7 HUB..."; }
  try {
    const r = await fetch("/admin/api/hub/start", { method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: "{}" });
    if (r.status === 404) {
      const st = await _getHubStatus(true);
      if (st?.hubUp) {
        _showToast("HUB ��� ����");
      } else {
        _showToast("�� ���� ������ HUB ����� ��� (���� ������� �������)");
      }
      return;
    }
    const res = await r.json().catch(() => ({}));
    if (r.ok && res?.ok) _showToast("\u05D1\u05E7\u05E9\u05EA \u05D4\u05D3\u05DC\u05E7\u05EA HUB \u05E0\u05E9\u05DC\u05D7\u05D4");
    else _showToast("\u05DC\u05D0 \u05D4\u05E6\u05DC\u05D7\u05EA\u05D9 \u05DC\u05D4\u05D3\u05DC\u05D9\u05E7 HUB");
  } catch {
    _showToast("\u05E9\u05D2\u05D9\u05D0\u05D4 \u05D1\u05D4\u05D3\u05DC\u05E7\u05EA HUB");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "\u05D4\u05D3\u05DC\u05E7 HUB"; }
    await _refreshHubStatusUi();
  }
}

// ─── Emoji Picker ───

const _EMOJI_PALETTE = [
  { label: '\u05e2\u05e1\u05e7\u05d9\u05dd', emojis: ['\uD83D\uDCC1','\uD83D\uDCC2','\uD83D\uDCCA','\uD83D\uDCC8','\uD83D\uDCC9','\uD83D\uDCCB','\uD83D\uDCCC','\uD83D\uDCDD','\uD83D\uDCCE','\uD83D\uDCD1','\uD83D\uDCD3','\uD83D\uDCD6','\uD83D\uDCD4','\uD83D\uDCDA','\uD83D\uDCDC','\u2709\uFE0F','\uD83D\uDCE7','\uD83D\uDCE8','\uD83D\uDCE9','\uD83D\uDCEE'] },
  { label: '\u05e9\u05d9\u05d5\u05d5\u05e7', emojis: ['\uD83D\uDCE2','\uD83D\uDCE3','\uD83D\uDCF0','\uD83D\uDCF1','\uD83D\uDCF2','\uD83D\uDCBB','\uD83D\uDDA5\uFE0F','\uD83C\uDF10','\uD83D\uDD17','\uD83D\uDCF9','\uD83C\uDFA5','\uD83C\uDFAC','\uD83D\uDCFA','\uD83D\uDCFB','\uD83C\uDF99\uFE0F','\uD83D\uDCF8','\uD83D\uDDBC\uFE0F','\uD83C\uDFA8','\uD83C\uDFAF','\uD83D\uDCA1'] },
  { label: '\u05D0\u05E0\u05E9\u05D9\u05DD', emojis: ['\uD83D\uDC64','\uD83D\uDC65','\uD83D\uDC68\u200D\uD83D\uDCBB','\uD83D\uDC69\u200D\uD83D\uDCBB','\uD83E\uDD1D','\uD83D\uDCAC','\uD83D\uDDE3\uFE0F','\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66','\u260E\uFE0F','\uD83D\uDCDE'] },
  { label: '\u05DB\u05E1\u05E3', emojis: ['\uD83D\uDCB0','\uD83D\uDCB3','\uD83D\uDCB5','\uD83D\uDCB8','\uD83D\uDCB9','\uD83D\uDCE6','\uD83D\uDED2','\uD83D\uDED2','\uD83C\uDFE6','\uD83C\uDFE2'] },
  { label: '\u05db\u05dc\u05d9\u05dd', emojis: ['\u2699\uFE0F','\uD83D\uDD27','\uD83D\uDD28','\uD83D\uDEE0\uFE0F','\u26A1','\uD83D\uDD25','\u2B50','\uD83C\uDF1F','\u2764\uFE0F','\uD83D\uDC8E','\uD83C\uDFC6','\uD83C\uDF89','\uD83C\uDF88','\uD83C\uDF81','\uD83D\uDCA3','\uD83D\uDD14','\uD83D\uDD12','\uD83D\uDD13','\uD83D\uDEA9','\uD83C\uDFF7\uFE0F'] },
  { label: '\u05e1\u05de\u05dc\u05d9\u05dd', emojis: ['\u2705','\u274C','\u26A0\uFE0F','\u2139\uFE0F','\u2753','\u2757','\uD83D\uDD34','\uD83D\uDFE0','\uD83D\uDFE1','\uD83D\uDFE2','\uD83D\uDD35','\uD83D\uDFE3','\u25AA\uFE0F','\u25AB\uFE0F','\uD83D\uDD36','\uD83D\uDD37','\u25B6\uFE0F','\u23EA','\uD83D\uDD04','\u2795'] }
];

const _EMOJI_KEYWORDS = {
  '\uD83D\uDCE2': ['marketing','\u05e9\u05d9\u05d5\u05d5\u05e7','\u05e4\u05e8\u05e1\u05d5\u05dd','\u05e4\u05e8\u05e1\u05d5\u05de\u05ea','\u05e7\u05d9\u05d3\u05d5\u05dd','\u05de\u05d1\u05e6\u05e2\u05d9\u05dd'],
  '\uD83D\uDCE3': ['announce','\u05d4\u05db\u05e8\u05d6\u05d4','\u05d4\u05d5\u05d3\u05e2\u05d4','\u05d4\u05d5\u05d3\u05e2\u05d5\u05ea','\u05e2\u05d3\u05db\u05d5\u05df'],
  '\uD83D\uDCB0': ['money','\u05db\u05e1\u05e3','\u05db\u05e1\u05e4\u05d9\u05dd','\u05ea\u05e7\u05e6\u05d9\u05d1','\u05ea\u05e7\u05e6\u05d9\u05d1\u05d9\u05dd','\u05e4\u05d9\u05e0\u05e0\u05e1\u05d9'],
  '\uD83D\uDCB3': ['payment','\u05ea\u05e9\u05dc\u05d5\u05dd','\u05ea\u05e9\u05dc\u05d5\u05de\u05d9\u05dd','\u05d0\u05e9\u05e8\u05d0\u05d9','\u05db\u05e8\u05d8\u05d9\u05e1'],
  '\uD83D\uDCB5': ['\u05d4\u05db\u05e0\u05e1\u05d5\u05ea','\u05d4\u05db\u05e0\u05e1\u05d4','\u05e8\u05d5\u05d5\u05d7','\u05e8\u05d5\u05d5\u05d7\u05d9\u05dd','\u05de\u05db\u05d9\u05e8\u05d5\u05ea','sales'],
  '\uD83D\uDCCA': ['analytics','\u05e0\u05ea\u05d5\u05e0\u05d9\u05dd','\u05d3\u05d5\u05d7\u05d5\u05ea','\u05d3\u05d5\u05d7','\u05e1\u05d8\u05d8\u05d9\u05e1\u05d8\u05d9\u05e7\u05d4','\u05e0\u05d9\u05ea\u05d5\u05d7'],
  '\uD83D\uDCC8': ['growth','\u05e6\u05de\u05d9\u05d7\u05d4','\u05e2\u05dc\u05d9\u05d9\u05d4','\u05de\u05d2\u05de\u05d5\u05ea','\u05d2\u05e8\u05e3'],
  '\uD83D\uDCC9': ['decline','\u05d9\u05e8\u05d9\u05d3\u05d4','\u05d4\u05d5\u05e6\u05d0\u05d5\u05ea'],
  '\uD83D\uDCC1': ['folder','\u05ea\u05d9\u05e7\u05d9\u05d4','\u05ea\u05d9\u05e7\u05d9\u05d5\u05ea','\u05e7\u05d1\u05e6\u05d9\u05dd','\u05de\u05e1\u05de\u05db\u05d9\u05dd','\u05d0\u05e8\u05db\u05d9\u05d5\u05df'],
  '\uD83D\uDCC2': ['open folder','\u05ea\u05d9\u05e7\u05d9\u05d4 \u05e4\u05ea\u05d5\u05d7\u05d4'],
  '\uD83D\uDCCB': ['tasks','\u05de\u05e9\u05d9\u05de\u05d5\u05ea','\u05e8\u05e9\u05d9\u05de\u05d4','\u05e8\u05e9\u05d9\u05de\u05d5\u05ea','\u05de\u05d8\u05dc\u05d5\u05ea'],
  '\uD83D\uDCDD': ['notes','\u05d4\u05e2\u05e8\u05d5\u05ea','\u05e8\u05e9\u05d9\u05de\u05d5\u05ea','\u05ea\u05d5\u05db\u05df','\u05ea\u05db\u05e0\u05d5\u05df','\u05db\u05ea\u05d9\u05d1\u05d4'],
  '\uD83D\uDCCC': ['pin','\u05e0\u05e7\u05d5\u05d3\u05d5\u05ea','\u05d7\u05e9\u05d5\u05d1','\u05de\u05d5\u05e6\u05de\u05d3','\u05de\u05d5\u05e6\u05de\u05d3\u05d9\u05dd'],
  '\uD83D\uDCDA': ['library','\u05e1\u05e4\u05e8\u05d9\u05d9\u05d4','\u05e1\u05e4\u05e8\u05d9\u05dd','\u05dc\u05d9\u05de\u05d5\u05d3','\u05d4\u05d3\u05e8\u05db\u05d4','\u05de\u05d3\u05e8\u05d9\u05db\u05d9\u05dd'],
  '\uD83D\uDCBB': ['code','\u05e4\u05d9\u05ea\u05d5\u05d7','\u05ea\u05db\u05e0\u05d5\u05ea','\u05d8\u05db\u05e0\u05d5\u05dc\u05d5\u05d2\u05d9\u05d4','\u05de\u05d7\u05e9\u05d1'],
  '\uD83D\uDDA5\uFE0F': ['desktop','\u05de\u05e1\u05da','\u05de\u05d7\u05e9\u05d1\u05d9\u05dd'],
  '\uD83C\uDF10': ['web','\u05d0\u05d9\u05e0\u05d8\u05e8\u05e0\u05d8','\u05d0\u05ea\u05e8','\u05d0\u05ea\u05e8\u05d9\u05dd','\u05e8\u05e9\u05ea'],
  '\uD83D\uDD17': ['link','\u05e7\u05d9\u05e9\u05d5\u05e8','\u05e7\u05d9\u05e9\u05d5\u05e8\u05d9\u05dd','\u05d7\u05d9\u05d1\u05d5\u05e8'],
  '\uD83D\uDCF1': ['mobile','\u05e0\u05d9\u05d9\u05d3','\u05de\u05d5\u05d1\u05d9\u05d9\u05dc','\u05d8\u05dc\u05e4\u05d5\u05df','\u05e1\u05dc\u05d5\u05dc\u05e8\u05d9'],
  '\uD83D\uDCF0': ['news','\u05d7\u05d3\u05e9\u05d5\u05ea','\u05e2\u05d9\u05ea\u05d5\u05e0\u05d5\u05ea','\u05de\u05d0\u05de\u05e8\u05d9\u05dd','\u05d1\u05dc\u05d5\u05d2'],
  '\uD83D\uDCF9': ['video','\u05d5\u05d9\u05d3\u05d0\u05d5','\u05e1\u05e8\u05d8\u05d5\u05e0\u05d9\u05dd','\u05e6\u05d9\u05dc\u05d5\u05dd'],
  '\uD83C\uDFA5': ['film','\u05e1\u05e8\u05d8','\u05e1\u05e8\u05d8\u05d9\u05dd','\u05e7\u05d5\u05dc\u05e0\u05d5\u05e2'],
  '\uD83D\uDCF8': ['photo','\u05ea\u05de\u05d5\u05e0\u05d5\u05ea','\u05ea\u05de\u05d5\u05e0\u05d4','\u05e6\u05d9\u05dc\u05d5\u05de\u05d9\u05dd','\u05d2\u05dc\u05e8\u05d9\u05d4'],
  '\uD83C\uDFA8': ['design','\u05e2\u05d9\u05e6\u05d5\u05d1','\u05d2\u05e8\u05e4\u05d9\u05e7\u05d4','\u05d3\u05d9\u05d6\u05d9\u05d9\u05df','\u05d9\u05e6\u05d9\u05e8\u05ea\u05d9'],
  '\uD83C\uDFAF': ['target','\u05d9\u05e2\u05d3\u05d9\u05dd','\u05de\u05d8\u05e8\u05d5\u05ea','\u05de\u05d8\u05e8\u05d4'],
  '\uD83D\uDCA1': ['idea','\u05e8\u05e2\u05d9\u05d5\u05e0\u05d5\u05ea','\u05e8\u05e2\u05d9\u05d5\u05df','\u05d4\u05e9\u05e8\u05d0\u05d4','\u05d7\u05d3\u05e9\u05e0\u05d5\u05ea'],
  '\uD83D\uDC64': ['user','\u05de\u05e9\u05ea\u05de\u05e9','\u05de\u05e9\u05ea\u05de\u05e9\u05d9\u05dd','\u05e4\u05e8\u05d5\u05e4\u05d9\u05dc','\u05dc\u05e7\u05d5\u05d7'],
  '\uD83D\uDC65': ['team','\u05e6\u05d5\u05d5\u05ea','\u05e2\u05d5\u05d1\u05d3\u05d9\u05dd','\u05e7\u05d1\u05d5\u05e6\u05d4','\u05d0\u05e0\u05e9\u05d9\u05dd'],
  '\uD83E\uDD1D': ['deal','\u05e2\u05e1\u05e7\u05d0\u05d5\u05ea','\u05e2\u05e1\u05e7\u05d4','\u05e9\u05d5\u05ea\u05e4\u05d9\u05dd','\u05e9\u05d9\u05ea\u05d5\u05e3 \u05e4\u05e2\u05d5\u05dc\u05d4'],
  '\uD83D\uDCAC': ['chat','\u05e6\u05d0\u05d8','\u05d4\u05d5\u05d3\u05e2\u05d5\u05ea','\u05e9\u05d9\u05d7\u05d5\u05ea','\u05ea\u05e7\u05e9\u05d5\u05e8\u05ea'],
  '\u260E\uFE0F': ['phone','\u05d8\u05dc\u05e4\u05d5\u05df','\u05e9\u05d9\u05d7\u05d5\u05ea','\u05ea\u05de\u05d9\u05db\u05d4'],
  '\uD83D\uDCE6': ['package','\u05de\u05e9\u05dc\u05d5\u05d7\u05d9\u05dd','\u05d7\u05d1\u05d9\u05dc\u05d5\u05ea','\u05de\u05d5\u05e6\u05e8\u05d9\u05dd','\u05de\u05dc\u05d0\u05d9'],
  '\uD83D\uDED2': ['shop','\u05d7\u05e0\u05d5\u05ea','\u05de\u05db\u05d9\u05e8\u05d5\u05ea','\u05e7\u05e0\u05d9\u05d5\u05ea','\u05e7\u05e0\u05d9\u05d4'],
  '\uD83C\uDFE6': ['bank','\u05d1\u05e0\u05e7','\u05d1\u05e0\u05e7\u05d0\u05d5\u05ea','\u05d7\u05e9\u05d1\u05d5\u05df'],
  '\uD83C\uDFE2': ['office','\u05de\u05e9\u05e8\u05d3','\u05de\u05e9\u05e8\u05d3\u05d9\u05dd','\u05d7\u05d1\u05e8\u05d4'],
  '\u2699\uFE0F': ['settings','\u05d4\u05d2\u05d3\u05e8\u05d5\u05ea','\u05db\u05dc\u05d9\u05dd','\u05de\u05e2\u05e8\u05db\u05ea','\u05ea\u05e6\u05d5\u05e8\u05d4'],
  '\uD83D\uDD27': ['tools','\u05db\u05dc\u05d9\u05dd','\u05ea\u05d9\u05e7\u05d5\u05e0\u05d9\u05dd','\u05ea\u05d7\u05d6\u05d5\u05e7\u05d4'],
  '\u26A1': ['fast','\u05de\u05d4\u05d9\u05e8','\u05d0\u05d5\u05d8\u05d5\u05de\u05e6\u05d9\u05d4','\u05d0\u05d5\u05d8\u05d5\u05de\u05d8\u05d9','\u05d1\u05d5\u05d8'],
  '\uD83D\uDD25': ['hot','\u05d7\u05dd','\u05d8\u05e8\u05e0\u05d3\u05d9','\u05e4\u05d5\u05e4\u05d5\u05dc\u05e8\u05d9'],
  '\u2B50': ['star','\u05de\u05d5\u05e2\u05d3\u05e4\u05d9\u05dd','\u05d3\u05d9\u05e8\u05d5\u05d2','\u05d1\u05d9\u05e7\u05d5\u05e8\u05d5\u05ea','\u05de\u05e9\u05d5\u05d1'],
  '\u2764\uFE0F': ['love','\u05de\u05d5\u05e2\u05d3\u05e4\u05d9\u05dd','\u05d0\u05d4\u05d5\u05d1\u05d9\u05dd','\u05d7\u05d1\u05e8\u05ea\u05d9'],
  '\uD83C\uDFC6': ['trophy','\u05d4\u05d9\u05e9\u05d2\u05d9\u05dd','\u05d4\u05e6\u05dc\u05d7\u05d4','\u05ea\u05d7\u05e8\u05d5\u05d9\u05d5\u05ea','\u05e4\u05e8\u05e1\u05d9\u05dd'],
  '\uD83C\uDF89': ['party','\u05d0\u05d9\u05e8\u05d5\u05e2\u05d9\u05dd','\u05d0\u05d9\u05e8\u05d5\u05e2','\u05d7\u05d2\u05d9\u05d2\u05d4','\u05de\u05e1\u05d9\u05d1\u05d4'],
  '\uD83D\uDD14': ['bell','\u05d4\u05ea\u05e8\u05d0\u05d5\u05ea','\u05ea\u05d6\u05db\u05d5\u05e8\u05d5\u05ea','\u05d4\u05ea\u05e8\u05e2\u05d4'],
  '\uD83D\uDD12': ['lock','\u05d0\u05d1\u05d8\u05d7\u05d4','\u05de\u05d0\u05d5\u05d1\u05d8\u05d7','\u05e4\u05e8\u05d8\u05d9','\u05e1\u05d9\u05e1\u05de\u05d0\u05d5\u05ea'],
  '\uD83D\uDEA9': ['flag','\u05d3\u05d2\u05dc','\u05d3\u05d2\u05dc\u05d9\u05dd','\u05de\u05e2\u05e7\u05d1','\u05d9\u05e2\u05d3\u05d9\u05dd'],
  '\u2709\uFE0F': ['email','\u05de\u05d9\u05d9\u05dc','\u05de\u05d9\u05d9\u05dc\u05d9\u05dd','\u05d3\u05d5\u05d0\u05e8','\u05d3\u05d5\u05d0\u05dc'],
  '\uD83D\uDCE7': ['email','\u05de\u05d9\u05d9\u05dc','\u05d3\u05d5\u05d0\u05e8','\u05d3\u05d5\u05d0\u05dc','\u05ea\u05e7\u05e9\u05d5\u05e8\u05ea'],
  '\uD83C\uDF99\uFE0F': ['podcast','\u05e4\u05d5\u05d3\u05e7\u05d0\u05e1\u05d8','\u05d4\u05e7\u05dc\u05d8\u05d4','\u05e9\u05de\u05e2'],
  '\uD83D\uDDBC\uFE0F': ['image','\u05ea\u05de\u05d5\u05e0\u05d4','\u05d2\u05dc\u05e8\u05d9\u05d4','\u05de\u05d3\u05d9\u05d4'],
  '\uD83D\uDCDC': ['docs','\u05de\u05e1\u05de\u05db\u05d9\u05dd','\u05de\u05e1\u05de\u05da','\u05d7\u05d5\u05d6\u05d4','\u05d7\u05d5\u05d6\u05d9\u05dd'],
  '\uD83D\uDCB8': ['expense','\u05d4\u05d5\u05e6\u05d0\u05d5\u05ea','\u05d4\u05d5\u05e6\u05d0\u05d4','\u05e2\u05dc\u05d5\u05d9\u05d5\u05ea'],
  '\uD83D\uDCB9': ['chart','\u05de\u05e0\u05d9\u05d5\u05ea','\u05d4\u05e9\u05e7\u05e2\u05d5\u05ea','\u05d1\u05d5\u05e8\u05e1\u05d4'],
  '\uD83D\uDCCE': ['attach','\u05e7\u05d1\u05e6\u05d9\u05dd','\u05e7\u05d1\u05e6\u05d9\u05dd \u05de\u05e6\u05d5\u05e8\u05e4\u05d9\u05dd','\u05e6\u05e8\u05d5\u05e4\u05d5\u05ea'],
  '\uD83D\uDC8E': ['premium','\u05e4\u05e8\u05de\u05d9\u05d5\u05dd','\u05d9\u05d5\u05e7\u05e8\u05d4','\u05d0\u05d9\u05db\u05d5\u05ea\u05d9'],
  '\uD83D\uDDE3\uFE0F': ['speak','\u05e9\u05d9\u05d7\u05d5\u05ea','\u05e4\u05d9\u05d3\u05d1\u05e7','\u05de\u05e9\u05d5\u05d1']
};

function _suggestEmojis(name) {
  if (!name) return [];
  const lower = name.toLowerCase().trim();
  const results = [];
  for (const [emoji, keywords] of Object.entries(_EMOJI_KEYWORDS)) {
    for (const kw of keywords) {
      if (lower.includes(kw) || kw.includes(lower)) {
        results.push(emoji);
        break;
      }
    }
  }
  return results.slice(0, 7);
}

function _showEmojiPicker(anchorEl, onSelect, suggestName) {
  // Remove any existing picker
  document.querySelectorAll('.emoji-picker-popup').forEach(p => p.remove());

  const popup = document.createElement('div');
  popup.className = 'emoji-picker-popup';

  let html = '';

  // Suggested section
  const suggested = _suggestEmojis(suggestName);
  if (suggested.length > 0) {
    html += `<div class="emoji-picker-cat-label emoji-picker-suggested-label">\u2728 \u05de\u05d5\u05de\u05dc\u05e6\u05d9\u05dd</div>`;
    html += '<div class="emoji-picker-grid">';
    suggested.forEach(em => {
      html += `<button type="button" class="emoji-picker-btn emoji-picker-suggested" data-emoji="${esc(em)}">${em}</button>`;
    });
    html += '</div>';
  }

  _EMOJI_PALETTE.forEach(cat => {
    html += `<div class="emoji-picker-cat-label">${esc(cat.label)}</div>`;
    html += '<div class="emoji-picker-grid">';
    cat.emojis.forEach(em => {
      html += `<button type="button" class="emoji-picker-btn" data-emoji="${esc(em)}">${em}</button>`;
    });
    html += '</div>';
  });
  popup.innerHTML = html;

  // Position near anchor
  document.body.appendChild(popup);
  const rect = anchorEl.getBoundingClientRect();
  const popH = popup.offsetHeight;
  const popW = popup.offsetWidth;

  let top = rect.bottom + 4;
  let left = rect.left;

  // Flip up if not enough space below
  if (top + popH > window.innerHeight - 10) {
    top = rect.top - popH - 4;
  }
  // Keep within screen
  if (left + popW > window.innerWidth - 10) {
    left = window.innerWidth - popW - 10;
  }
  if (left < 10) left = 10;

  popup.style.top = top + 'px';
  popup.style.left = left + 'px';

  // Wire clicks
  popup.addEventListener('click', (e) => {
    const btn = e.target.closest('.emoji-picker-btn');
    if (!btn) return;
    onSelect(btn.dataset.emoji);
    popup.remove();
  });

  // Close on outside click
  setTimeout(() => {
    function outsideClick(e) {
      if (!popup.contains(e.target) && e.target !== anchorEl) {
        popup.remove();
        document.removeEventListener('mousedown', outsideClick);
      }
    }
    document.addEventListener('mousedown', outsideClick);
  }, 0);
}

// ─── Tab Groups helpers ───

function _getTabGroups() {
  return _loadJSON('tab_groups') || [];
}

function _saveTabGroups(groups) {
  _saveJSON('tab_groups', groups);
}

function _getCollapsedGroups() {
  return _loadJSON('tab_groups_collapsed') || [];
}

function _saveCollapsedGroups(collapsed) {
  _saveJSON('tab_groups_collapsed', collapsed);
}

// ─── Tab Groups CRUD ───

function _createGroup(name, icon) {
  const groups = _getTabGroups();
  const id = 'grp_' + Date.now();
  groups.push({ id, name, icon: icon || '📁', children: [] });
  _saveTabGroups(groups);
  _rebuildSidebarNav(_config);
  return id;
}

function _deleteGroup(groupId) {
  let groups = _getTabGroups();
  groups = groups.filter(g => g.id !== groupId);
  _saveTabGroups(groups);
  // Remove from collapsed list too
  let collapsed = _getCollapsedGroups();
  collapsed = collapsed.filter(id => id !== groupId);
  _saveCollapsedGroups(collapsed);
  _rebuildSidebarNav(_config);
}

function _renameGroup(groupId, newName, newIcon) {
  const groups = _getTabGroups();
  const g = groups.find(g => g.id === groupId);
  if (!g) return;
  if (newName != null) g.name = newName;
  if (newIcon != null) g.icon = newIcon;
  _saveTabGroups(groups);
  _rebuildSidebarNav(_config);
}

function _assignTabToGroup(tabId, groupId) {
  const groups = _getTabGroups();
  // Remove from any existing group first
  groups.forEach(g => { g.children = g.children.filter(c => c !== tabId); });
  // Add to target group
  const target = groups.find(g => g.id === groupId);
  if (target) target.children.push(tabId);
  _saveTabGroups(groups);
  _rebuildSidebarNav(_config);
}

function _removeTabFromGroup(tabId, groupId) {
  const groups = _getTabGroups();
  const g = groups.find(g => g.id === groupId);
  if (g) {
    g.children = g.children.filter(c => c !== tabId);
    // Clear defaultChild if it was the removed tab
    if (g.defaultChild === tabId) delete g.defaultChild;
  }
  _saveTabGroups(groups);
  _rebuildSidebarNav(_config);
}

function _setGroupDefaultChild(groupId, tabId) {
  const groups = _getTabGroups();
  const g = groups.find(g => g.id === groupId);
  if (!g) return;
  if (tabId) {
    g.defaultChild = tabId;
  } else {
    delete g.defaultChild;
  }
  _saveTabGroups(groups);
  _rebuildSidebarNav(_config);
}

// ─── Login Screen ───

function showLoginScreen() {
  // Stop any running refresh timer
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }

  const root = document.getElementById('dashboard-root');
  if (!root) return;

  const projectName = _config?.projectName || 'Dashboard';
  const logoHtml = _config?.logoUrl
    ? `<img src="${esc(_config.logoUrl)}" class="login-logo-img" alt="">`
    : `<span class="login-logo">${esc(_config?.logoText || projectName[0])}</span>`;

  root.innerHTML = `
    <div class="login-screen">
      <div class="login-box">
        ${logoHtml}
        <h2 class="login-title">${esc(projectName)}</h2>
        <p class="login-subtitle">\u05db\u05e0\u05d9\u05e1\u05d4 \u05dc\u05dc\u05d5\u05d7 \u05d1\u05e7\u05e8\u05d4</p>
        <div class="login-form">
          <input type="password" id="sd-login-secret" class="login-input" placeholder="\u05e1\u05d9\u05e1\u05de\u05d4" autocomplete="current-password" />
          <button type="button" id="sd-login-btn" class="login-btn">\u05d4\u05ea\u05d7\u05d1\u05e8</button>
        </div>
        <div id="sd-login-error" class="login-error"></div>
      </div>
    </div>`;

  const input = document.getElementById('sd-login-secret');
  const btn = document.getElementById('sd-login-btn');
  const errEl = document.getElementById('sd-login-error');

  async function doLogin() {
    const secret = input.value.trim();
    if (!secret) { errEl.textContent = '\u05d4\u05d6\u05df \u05e1\u05d9\u05e1\u05de\u05d4'; return; }
    btn.disabled = true;
    btn.textContent = '\u05de\u05ea\u05d7\u05d1\u05e8...';
    errEl.textContent = '';

    try {
      const res = await fetch('/admin/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret }),
      });
      const data = await res.json();
      if (data.ok && data.token) {
        setToken(data.token);
        // Re-initialize the dashboard
        initDashboard(_config);
      } else {
        errEl.textContent = '\u05e1\u05d9\u05e1\u05de\u05d4 \u05e9\u05d2\u05d5\u05d9\u05d4';
        btn.disabled = false;
        btn.textContent = '\u05d4\u05ea\u05d7\u05d1\u05e8';
        input.value = '';
        input.focus();
      }
    } catch {
      errEl.textContent = '\u05e9\u05d2\u05d9\u05d0\u05ea \u05e8\u05e9\u05ea';
      btn.disabled = false;
      btn.textContent = '\u05d4\u05ea\u05d7\u05d1\u05e8';
    }
  }

  btn.addEventListener('click', doLogin);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  input.focus();
}

// ─── Main Init ───

export function initDashboard(config) {
  _config = config;

  // ─── Auth check — verify token before rendering dashboard ───
  const token = getToken();
  if (token) {
    // Verify token is still valid
    fetch('/admin/auth/check', { headers: { 'Authorization': 'Bearer ' + token } })
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          _initDashboardInternal(config);
        } else {
          clearToken();
          // Check if auth is required (try a public endpoint)
          _checkAuthRequired(config);
        }
      })
      .catch(() => {
        // Network error — try to load anyway (auth might not be enabled)
        _initDashboardInternal(config);
      });
  } else {
    _checkAuthRequired(config);
  }
}

function _checkAuthRequired(config) {
  // Try hitting an admin endpoint without auth — if 401, show login
  fetch('/admin/api/stats')
    .then(r => {
      if (r.status === 401) {
        showLoginScreen();
      } else {
        // Auth not enabled — proceed without token
        _initDashboardInternal(config);
      }
    })
    .catch(() => {
      // Network error — try loading anyway
      _initDashboardInternal(config);
    });
}

async function _initDashboardInternal(config) {
  // Store original labels/icons for settings page (before overrides)
  config.pages.forEach(p => {
    if (!p._origLabel) p._origLabel = p.label;
    if (!p._origIcon) p._origIcon = p.icon;
  });

  // ─── Apply localStorage overrides ───
  const savedLogo = _loadJSON('logo');
  if (savedLogo) {
    if (savedLogo.type === 'url' && savedLogo.value) {
      config.logoUrl = savedLogo.value;
      delete config.logoText;
    } else if (savedLogo.type === 'text' && savedLogo.value) {
      config.logoText = savedLogo.value;
      delete config.logoUrl;
    }
  }

  const savedProjectIcon = _loadJSON('project_icon');
  if (savedProjectIcon) {
    config.logoText = savedProjectIcon;
    delete config.logoUrl;
  }

  const savedProjectName = _loadJSON('project_name');
  if (savedProjectName) {
    config._origProjectName = config._origProjectName || config.projectName;
    config.projectName = savedProjectName;
  }

  const savedLabels = _loadJSON('tab_labels');
  if (savedLabels) {
    config.pages.forEach(p => {
      if (savedLabels[p.id]) {
        p.label = savedLabels[p.id];
        if (!p._origTitle) p._origTitle = p.title;
        p.title = savedLabels[p.id];
      }
    });
  }

  const savedIcons = _loadJSON('tab_icons');
  if (savedIcons) {
    config.pages.forEach(p => {
      if (savedIcons[p.id]) {
        if (!p._origIcon) p._origIcon = p.icon;
        p.icon = savedIcons[p.id];
      }
    });
  }

  // ─── Apply saved footer labels ───
  const savedFooterLabels = _loadJSON('footer_labels');
  if (savedFooterLabels && config.footerLinks) {
    config.footerLinks.forEach((f, i) => {
      if (!f._origLabel) f._origLabel = f.label;
      if (savedFooterLabels[i]) f.label = savedFooterLabels[i];
    });
  }

  // ─── Apply saved font size (zoom) ───
  const savedFontSize = _loadJSON('font_size');
  if (savedFontSize && savedFontSize !== 100) {
    requestAnimationFrame(() => _applyZoom(savedFontSize));
  }

  // ─── Auto-inject standard tabs from config ───
  try {
    const res = await fetch('/shared/data/standard-tabs.json?v=' + Date.now());
    if (res.ok) {
      const { tabs = [] } = await res.json();
      for (const tab of tabs) {
        if (!tab.enabled) continue;
        if (config.pages.find(p => p.id === tab.id)) continue;
        if (tab.source === 'module') {
          let _mod = null;
          config.pages.push({
            id: tab.id, icon: tab.icon, label: tab.label, title: tab.title,
            type: 'custom',
            render(el) {
              import(tab.modulePath).then(m => { _mod = m; m.render(el); })
                .catch(() => { el.innerHTML = '<div style="color:var(--text-dim);padding:20px">\u05D8\u05D0\u05D1 \u05DC\u05D0 \u05D6\u05DE\u05D9\u05DF</div>'; });
            },
            async onActivate() { if (_mod?.onActivate) await _mod.onActivate(); },
          });
        } else if (tab.source === 'builtin') {
          config.pages.push({
            id: tab.id, icon: tab.icon, label: tab.label, title: tab.title,
            type: 'builtin', builtinType: tab.builtinType,
          });
        }
      }
    }
  } catch { /* continue without standard tabs */ }

  // ─── Auto-inject categories page ───
  if (!config.pages.find(p => p.id === 'dashboard-categories')) {
    config.pages.push({
      id: 'dashboard-categories',
      icon: '\uD83D\uDDC2\uFE0F',
      label: '\u05e7\u05d8\u05d2\u05d5\u05e8\u05d9\u05d5\u05ea',
      title: '\u05e7\u05d8\u05d2\u05d5\u05e8\u05d9\u05d5\u05ea',
      type: 'builtin',
      builtinType: 'dashboard-categories',
    });
  }

  // ─── Auto-inject settings page ───
  if (!config.pages.find(p => p.id === 'dashboard-settings')) {
    config.pages.push({
      id: 'dashboard-settings',
      icon: '\u2699\uFE0F',
      label: '\u05d4\u05d2\u05d3\u05e8\u05d5\u05ea \u05d3\u05e9\u05d1\u05d5\u05e8\u05d3',
      title: '\u05d4\u05d2\u05d3\u05e8\u05d5\u05ea \u05d3\u05e9\u05d1\u05d5\u05e8\u05d3',
      type: 'builtin',
      builtinType: 'dashboard-settings',
    });
  }

  // ─── Enforce ordering: categories second-to-last, settings last ───
  const catIdx = config.pages.findIndex(p => p.id === 'dashboard-categories');
  const setIdx = config.pages.findIndex(p => p.id === 'dashboard-settings');
  const catPage = catIdx !== -1 ? config.pages.splice(catIdx, 1)[0] : null;
  const setIdx2 = config.pages.findIndex(p => p.id === 'dashboard-settings');
  const setPage = setIdx2 !== -1 ? config.pages.splice(setIdx2, 1)[0] : null;
  if (catPage) config.pages.push(catPage);
  if (setPage) config.pages.push(setPage);

  document.title = config.projectName + ' \u2014 \u05dc\u05d5\u05d7 \u05d1\u05e7\u05e8\u05d4';

  // Apply theme overrides
  if (config.themeOverrides) {
    const root = document.documentElement;
    for (const [prop, val] of Object.entries(config.themeOverrides)) {
      root.style.setProperty(prop, val);
    }
  }

  const root = document.getElementById('dashboard-root');
  if (!root) return;

  // Build layout
  root.innerHTML = buildSidebar(config) + buildMain(config);

  // Build modals + sidebar restore button
  document.body.insertAdjacentHTML('beforeend', buildThreadModal());
  document.body.insertAdjacentHTML('beforeend', _buildIntegrationsModal());
  document.body.insertAdjacentHTML('beforeend', '<button class="sidebar-restore-btn" id="sd-sidebar-restore" title="\u05d4\u05e6\u05d2 \u05e1\u05e8\u05d2\u05dc">&#x25C4;</button>');

  // Restore sidebar collapsed state
  if (_loadJSON('sidebar_collapsed')) document.body.classList.add('sidebar-collapsed');

  // Wire navigation
  wireNavigation(config);

  // Wire sidebar collapse/restore
  document.getElementById('sd-sidebar-collapse')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _toggleSidebar();
  });
  document.getElementById('sd-sidebar-restore')?.addEventListener('click', _toggleSidebar);

  // Wire sidebar header click → integrations modal (skip collapse button)
  document.querySelector('.sidebar-header')?.addEventListener('click', (e) => {
    if (e.target.closest('#sd-sidebar-collapse')) return;
    _openIntegrationsModal(e);
  });

  // Wire group toggles (collapse/expand)
  _wireGroupToggles();

  // Wire collapse-all / expand-all buttons
  const collapseAllBtn = document.getElementById('sd-collapse-all');
  const expandAllBtn = document.getElementById('sd-expand-all');
  if (collapseAllBtn) {
    collapseAllBtn.addEventListener('click', () => {
      const groups = _getTabGroups();
      const allIds = groups.map(g => g.id);
      _saveCollapsedGroups(allIds);
      document.querySelectorAll('#sd-nav .nav-group-children').forEach(ch => ch.classList.add('collapsed'));
      document.querySelectorAll('#sd-nav .nav-group-arrow').forEach(a => a.textContent = '\u25C0');
    });
  }
  if (expandAllBtn) {
    expandAllBtn.addEventListener('click', () => {
      _saveCollapsedGroups([]);
      document.querySelectorAll('#sd-nav .nav-group-children').forEach(ch => ch.classList.remove('collapsed'));
      document.querySelectorAll('#sd-nav .nav-group-arrow').forEach(a => a.textContent = '\u25BC');
    });
  }

  // Wire footer pinned tabs (click + right-click rename)
  _wireFooterPinnedTabs(config);

  // Wire global right-click inline editing for all text elements
  _wireGlobalInlineEdit(config);

  // Wire mobile menu
  wireMobileMenu();

  // Wire draggable tabs (always enabled)
  wireDraggableTabs(config);

  // Render builtin pages
  config.pages.forEach(page => {
    const body = document.getElementById('page-body-' + page.id);
    if (!body) return;
    if (page.type === 'builtin') {
      renderBuiltinPage(page, body);
    } else if (page.type === 'custom' && page.render) {
      page.render(body);
    }
    // Restore saved table headers for this page
    _restoreTableHeaders(page.id);
  });

  // Render widgets
  if (config.widgets) {
    config.widgets.forEach(w => {
      if (w.render) {
        const container = document.createElement('div');
        container.id = 'widget-' + w.id;
        document.body.appendChild(container);
        w.render(container);
      }
    });
  }

  // Activate page from URL hash, or first visible page as fallback
  const hashPage = location.hash.replace('#', '');
  const _hiddenTabs = _loadJSON('hidden_tabs') || [];
  const hashPageObj = config.pages.find(p => p.id === hashPage && !_hiddenTabs.includes(p.id));
  const startPage = hashPageObj || config.pages.find(p => !_hiddenTabs.includes(p.id)) || config.pages[0];
  if (startPage) {
    activatePage(startPage.id, config);
  }

  // Listen for browser back/forward navigation
  window.addEventListener('hashchange', () => {
    const id = location.hash.replace('#', '');
    if (id && config.pages.find(p => p.id === id)) {
      activatePage(id, config);
    }
  });

  // Auto-refresh
  if (_refreshTimer) clearInterval(_refreshTimer);
  const interval = config.refreshInterval;
  if (interval !== false && interval > 0) {
    _refreshTimer = setInterval(() => {
      refreshActivePage(config);
      runHealthChecks(config);
    }, interval);
  }

  // Initial health checks
  runHealthChecks(config);

  // Load project switcher
  loadProjectSwitcher(config);

  // Hebrew date picker (replaces native date inputs)
  document.head.insertAdjacentHTML('beforeend', '<link rel="stylesheet" href="/shared/css/he-datepicker.css">');
  import('/shared/js/components/he-datepicker.js').then(m => m.initHeDatePicker());

  // Background DB sync — hydrate from DB if localStorage is empty
  _backgroundDbSync();

  // Flush pending debounced settings writes when user refreshes/closes tab.
  if (!_settingsFlushBound) {
    _settingsFlushBound = true;
    const flushNow = () => {
      if (_dbSaveTimer) {
        clearTimeout(_dbSaveTimer);
        _dbSaveTimer = null;
        const payload = JSON.stringify(_collectAllSettings());
        try {
          if (navigator.sendBeacon) {
            const blob = new Blob([payload], { type: 'application/json' });
            navigator.sendBeacon('/admin/api/dashboard-settings', blob);
          } else {
            _syncSettingsToDbNow(false);
          }
        } catch {
          _syncSettingsToDbNow(false);
        }
      }
    };
    window.addEventListener('beforeunload', flushNow);
    window.addEventListener('pagehide', flushNow);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushNow();
    });
  }

  // Start polling for broadcast updates from other projects
  _startSettingsPoll();

  // Clear reload guard after 5s so future broadcasts can trigger reload
  setTimeout(() => sessionStorage.removeItem('_sd_broadcast_reload'), 5000);
}

// ─── Project Switcher ───

async function loadProjectSwitcher(config) {
  const container = document.getElementById('sd-project-switcher');
  if (!container) return;

  const hubUrl = config.hubUrl || `http://localhost:3000`;
  let projects = [];

  try {
    const res = await fetch(`${hubUrl}/api/projects`, { signal: AbortSignal.timeout(3000) });
    projects = await res.json();
  } catch {
    container.style.display = 'none';
    return;
  }

  if (!projects.length) { container.style.display = 'none'; return; }

  const currentPort = parseInt(location.port, 10);

  container.innerHTML =
    `<a href="${esc(hubUrl)}/" class="switcher-chip switcher-hub" title="\u05E8\u05D0\u05E9\u05D9">
      <span class="switcher-chip-logo" style="background:linear-gradient(135deg,#6366f1,#00d4ff)">\u2302</span>
      <span class="switcher-chip-name">\u05E8\u05D0\u05E9\u05D9</span>
    </a>` +
    projects.map(p => {
      const isCurrent = p.port === currentPort;
      if (isCurrent) {
        return `<div class="switcher-chip active" data-port="${p.port}" title="${esc(p.name)} :${p.port}">
          <span class="switcher-chip-logo" style="background:${esc(p.color)}">${esc(p.logo)}</span>
          <span class="switcher-chip-name">${esc(p.name)}</span>
        </div>`;
      }
      return `<a href="http://localhost:${p.port}/" class="switcher-chip" data-port="${p.port}"
        onclick="sessionStorage.setItem('sd_switcher_show_claude','1')"
        title="${esc(p.name)} :${p.port}">
        <span class="switcher-chip-logo" style="background:${esc(p.color)}">${esc(p.logo)}</span>
        <span class="switcher-chip-name">${esc(p.name)}</span>
        <span class="switcher-chip-dot" data-port="${p.port}"></span>
      </a>`;
    }).join('');

  // Active chip click → show Claude dropdown
  const activeChip = container.querySelector('.switcher-chip.active');
  if (activeChip) {
    activeChip.addEventListener('click', () => {
      _showClaudeDropdown(activeChip, activeChip.dataset.port);
    });
  }

  // Auto-show Claude dropdown after switching dashboards
  if (sessionStorage.getItem('sd_switcher_show_claude') && activeChip) {
    sessionStorage.removeItem('sd_switcher_show_claude');
    setTimeout(() => _showClaudeDropdown(activeChip, activeChip.dataset.port), 300);
  }

  // Check health of other projects
  for (const p of projects) {
    if (p.port === currentPort) continue;
    const dot = container.querySelector(`.switcher-chip-dot[data-port="${p.port}"]`);
    if (!dot) continue;
    try {
      await fetch(`http://localhost:${p.port}/health`, { mode: 'no-cors', signal: AbortSignal.timeout(2000) });
      dot.classList.add('online');
    } catch {
      dot.classList.add('offline');
    }
  }
}

function _showClaudeDropdown(anchorEl, port) {
  // Remove any existing dropdown
  document.querySelectorAll('.switcher-dropdown').forEach(d => d.remove());

  const dropdown = document.createElement('div');
  dropdown.className = 'switcher-dropdown';
  dropdown.innerHTML = `<button type="button" class="switcher-dropdown-item switcher-dropdown-claude">
    <span class="switcher-dropdown-claude-icon">C</span> Claude
  </button>`;

  document.body.appendChild(dropdown);

  // Position below anchor
  const rect = anchorEl.getBoundingClientRect();
  let top = rect.bottom + 4;
  let left = rect.left;

  const popW = dropdown.offsetWidth;
  if (left + popW > window.innerWidth - 10) {
    left = window.innerWidth - popW - 10;
  }
  if (left < 10) left = 10;

  dropdown.style.top = top + 'px';
  dropdown.style.left = left + 'px';

  // Wire Claude button
  dropdown.querySelector('.switcher-dropdown-claude').addEventListener('click', () => {
    const url = `http://localhost:${port}/admin/api/open-terminal`;
    fetch(url, { method: 'POST', headers: authHeaders() })
      .then(r => r.json())
      .then(d => { if (!d.ok) console.error('open-terminal failed', d); })
      .catch(e => console.error('open-terminal error', e));
    dropdown.remove();
  });

  // Close on outside click
  setTimeout(() => {
    function outsideClick(e) {
      if (!dropdown.contains(e.target) && !anchorEl.contains(e.target)) {
        dropdown.remove();
        document.removeEventListener('mousedown', outsideClick);
      }
    }
    document.addEventListener('mousedown', outsideClick);
  }, 0);
}

// ─── Sidebar ───

function _buildNavItems(config) {
  const hiddenTabs = _loadJSON('hidden_tabs') || [];
  const groups = _getTabGroups();
  const collapsed = _getCollapsedGroups();

  // Collect all grouped tab IDs
  const groupedTabIds = new Set();
  groups.forEach(g => g.children.forEach(id => groupedTabIds.add(id)));

  // Determine active page
  const activeNav = document.querySelector('#sd-nav .nav-item.active');
  const activeId = activeNav ? activeNav.dataset.tab : null;

  // Restore saved order for ungrouped tabs
  let orderedPages = [...config.pages];
  try {
    const saved = localStorage.getItem(_prefix() + 'nav_order');
    if (saved) {
      const order = JSON.parse(saved);
      orderedPages.sort((a, b) => {
        const ai = order.indexOf(a.id);
        const bi = order.indexOf(b.id);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      });
    }
  } catch { /* ignore */ }

  const pinnedBottomIds = ['dashboard-categories', 'dashboard-settings'];

  function _navButton(p, extra = '') {
    const isHidden = hiddenTabs.includes(p.id);
    const isActive = p.id === activeId;
    const isPinned = pinnedBottomIds.includes(p.id);
    const cls = (isActive ? 'nav-item active' : 'nav-item') + (isHidden ? ' nav-hidden' : '') + (isPinned ? ' nav-pinned' : '') + extra;
    const draggable = isPinned ? 'false' : 'true';
    const reorder = isPinned ? '' : `<span class="nav-reorder">
        <span class="reorder-btn reorder-up" data-dir="up" title="הזז למעלה">&#9650;</span>
        <span class="reorder-btn reorder-down" data-dir="down" title="הזז למטה">&#9660;</span>
      </span>`;
    return `<button type="button" class="${cls}" data-tab="${esc(p.id)}" draggable="${draggable}"${isHidden ? ' style="display:none"' : ''}>
      <span class="nav-icon">${p.icon}</span>
      <span class="nav-label">${esc(p.label)}</span>
      ${reorder}
    </button>`;
  }

  let html = '';

  // Build ordered list of top-level items (groups + ungrouped tabs interleaved by saved order)
  // Groups are treated as draggable items alongside ungrouped tabs
  const savedOrder = (() => {
    try {
      const s = localStorage.getItem(_prefix() + 'nav_order');
      return s ? JSON.parse(s) : [];
    } catch { return []; }
  })();

  // Build top-level items: each is either { type:'group', group } or { type:'tab', page }
  const topItems = [];
  const usedGroupIds = new Set();
  const usedTabIds = new Set();

  // Walk saved order to restore positions
  savedOrder.forEach(id => {
    // Check if it's a group id
    const g = groups.find(g => g.id === id);
    if (g && !usedGroupIds.has(g.id)) {
      topItems.push({ type: 'group', group: g });
      usedGroupIds.add(g.id);
      return;
    }
    // Check if it's an ungrouped, non-pinned tab
    const p = orderedPages.find(p => p.id === id);
    if (p && !groupedTabIds.has(p.id) && !pinnedBottomIds.includes(p.id) && !usedTabIds.has(p.id)) {
      topItems.push({ type: 'tab', page: p });
      usedTabIds.add(p.id);
    }
  });

  // Append any remaining groups not in saved order
  groups.forEach(g => {
    if (!usedGroupIds.has(g.id)) {
      topItems.push({ type: 'group', group: g });
      usedGroupIds.add(g.id);
    }
  });

  // Append any remaining ungrouped non-pinned tabs not in saved order
  orderedPages.forEach(p => {
    if (!groupedTabIds.has(p.id) && !pinnedBottomIds.includes(p.id) && !usedTabIds.has(p.id)) {
      topItems.push({ type: 'tab', page: p });
      usedTabIds.add(p.id);
    }
  });

  // Render top-level items
  topItems.forEach(item => {
    if (item.type === 'group') {
      const g = item.group;
      const isCollapsed = collapsed.includes(g.id);
      const arrow = isCollapsed ? '◀' : '▼';
      const childPages = g.children
        .map(cid => orderedPages.find(p => p.id === cid))
        .filter(Boolean);
      const allChildrenHidden = childPages.length > 0 && childPages.every(p => hiddenTabs.includes(p.id));
      const groupHidden = childPages.length === 0 || allChildrenHidden;
      html += `<div class="nav-group${groupHidden ? ' nav-group-empty' : ''}" data-group-id="${esc(g.id)}" draggable="true"${groupHidden ? ' style="display:none"' : ''}>
        <div class="nav-group-header" data-group-id="${esc(g.id)}">
          <span class="nav-icon">${g.icon}</span>
          <span class="nav-label">${esc(g.name)}</span>
          <span class="nav-group-arrow">${arrow}</span>
        </div>
        <div class="nav-group-children${isCollapsed ? ' collapsed' : ''}">
          ${childPages.map(p => _navButton(p, ' nav-child')).join('')}
        </div>
      </div>`;
    } else {
      html += _navButton(item.page);
    }
  });

  // Pinned tabs (categories, settings) are rendered in the sidebar footer, not here

  return html;
}

function _wireGroupToggles() {
  const nav = document.getElementById('sd-nav');
  if (!nav) return;

  nav.querySelectorAll('.nav-group-header').forEach(header => {
    header.addEventListener('click', (e) => {
      e.stopPropagation();
      const groupId = header.dataset.groupId;
      const children = header.nextElementSibling;
      const arrow = header.querySelector('.nav-group-arrow');
      if (!children) return;

      const wasCollapsed = children.classList.contains('collapsed');

      // Find group data for defaultChild
      const groups = _getTabGroups();
      const group = groups.find(g => g.id === groupId);
      const defaultChild = group?.defaultChild;

      if (defaultChild && wasCollapsed) {
        // Opening a collapsed group with a default child — expand and navigate
        children.classList.remove('collapsed');
        if (arrow) arrow.textContent = '▼';
        let coll = _getCollapsedGroups();
        coll = coll.filter(id => id !== groupId);
        _saveCollapsedGroups(coll);
        activatePage(defaultChild, _config);
      } else if (defaultChild && !wasCollapsed) {
        // Already open — collapse
        children.classList.add('collapsed');
        if (arrow) arrow.textContent = '◀';
        let coll = _getCollapsedGroups();
        if (!coll.includes(groupId)) coll.push(groupId);
        _saveCollapsedGroups(coll);
      } else {
        // No default child — simple toggle
        const isCollapsed = children.classList.toggle('collapsed');
        if (arrow) arrow.textContent = isCollapsed ? '◀' : '▼';
        let coll = _getCollapsedGroups();
        if (isCollapsed) {
          if (!coll.includes(groupId)) coll.push(groupId);
        } else {
          coll = coll.filter(id => id !== groupId);
        }
        _saveCollapsedGroups(coll);
      }
    });
  });
}

function _wireFooterPinnedTabs(config) {
  const container = document.getElementById('sd-footer-pinned');
  if (!container) return;

  // Click → navigate
  container.addEventListener('click', (e) => {
    const item = e.target.closest('[data-tab]');
    if (!item || item.querySelector('.tab-rename-input')) return;
    activatePage(item.dataset.tab, config);
  });

  // Right-click → inline rename
  container.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.nav-pinned-footer');
    if (!item) return;
    e.preventDefault();

    const tabId = item.dataset.tab;
    const page = config.pages.find(p => p.id === tabId);
    if (!page) return;

    const labelEl = item.querySelector('.nav-label');
    if (!labelEl || labelEl.querySelector('.tab-rename-input')) return;

    const currentName = labelEl.textContent;
    labelEl.innerHTML = `<input class="tab-rename-input" value="${esc(currentName)}" />`;
    const input = labelEl.querySelector('.tab-rename-input');
    input.style.width = Math.max(labelEl.offsetWidth, 80) + 'px';
    input.select();
    input.focus();

    function commit() {
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        labelEl.textContent = newName;
        page.label = newName;
        page.title = newName;
        const savedLabels = _loadJSON('tab_labels') || {};
        savedLabels[tabId] = newName;
        _saveJSON('tab_labels', savedLabels);
        // Update page title too
        const pageTitle = document.querySelector(`#tab-${tabId} .page-title`);
        if (pageTitle) pageTitle.textContent = newName;
        _showToast('\u05e9\u05dd \u05d4\u05d8\u05d0\u05d1 \u05e2\u05d5\u05d3\u05db\u05df');
      } else {
        labelEl.textContent = currentName;
      }
    }

    input.addEventListener('blur', commit, { once: true });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { input.blur(); }
      if (ev.key === 'Escape') { input.value = currentName; input.blur(); }
    });
  });
}

// ─── Table header restore ───

function _restoreTableHeaders(tabId) {
  const savedThLabels = _loadJSON('table_headers');
  if (!savedThLabels || !savedThLabels[tabId]) return;
  const section = document.getElementById('tab-' + tabId);
  if (!section) return;
  const headers = section.querySelectorAll('thead th');
  Object.entries(savedThLabels[tabId]).forEach(([idx, label]) => {
    const th = headers[parseInt(idx)];
    if (th) th.textContent = label;
  });
}

// ─── Global right-click inline editing ───

function _inlineEdit(el, currentText, onCommit) {
  if (el.querySelector('.tab-rename-input')) return;
  const orig = currentText;
  el.innerHTML = `<input class="tab-rename-input" value="${esc(orig)}" />`;
  const input = el.querySelector('.tab-rename-input');
  input.style.width = Math.max(el.offsetWidth, 80) + 'px';
  input.select();
  input.focus();

  function commit() {
    const val = input.value.trim();
    if (val && val !== orig) {
      el.textContent = val;
      onCommit(val);
      _showToast('עודכן בהצלחה');
    } else {
      el.textContent = orig;
    }
  }

  input.addEventListener('blur', () => {
    setTimeout(() => { if (el.querySelector('.tab-rename-input')) commit(); }, 100);
  }, { once: true });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
    if (ev.key === 'Escape') { ev.preventDefault(); input.value = orig; input.blur(); }
  });
  input.addEventListener('click', (ev) => ev.stopPropagation());
}

function _wireGlobalInlineEdit(config) {
  const root = document.getElementById('dashboard-root');
  if (!root) return;

  root.addEventListener('contextmenu', (e) => {
    // Skip if already handled by nav/footer-pinned listeners
    const navItem = e.target.closest('#sd-nav .nav-item');
    const footerPinned = e.target.closest('#sd-footer-pinned .nav-pinned-footer');
    if (navItem || footerPinned) return;

    // ── 1. Page title (h2.page-title) ──
    const pageTitle = e.target.closest('.page-title');
    if (pageTitle) {
      e.preventDefault();
      const section = pageTitle.closest('.tab-content');
      const tabId = section?.id?.replace('tab-', '');
      if (!tabId || tabId === 'dashboard-settings') return;
      const page = config.pages.find(p => p.id === tabId);

      _inlineEdit(pageTitle, pageTitle.textContent, (val) => {
        if (page) { page.label = val; page.title = val; }
        // Update nav label
        const navLabel = document.querySelector(`[data-tab="${tabId}"] .nav-label`);
        if (navLabel) navLabel.textContent = val;
        // Update footer pinned label
        const footerLabel = document.querySelector(`#sd-footer-pinned [data-tab="${tabId}"] .nav-label`);
        if (footerLabel) footerLabel.textContent = val;
        // Persist
        const savedLabels = _loadJSON('tab_labels') || {};
        savedLabels[tabId] = val;
        _saveJSON('tab_labels', savedLabels);
      });
      return;
    }

    // ── 2. Group name (nav-group-header .nav-label) ──
    const groupHeader = e.target.closest('.nav-group-header');
    if (groupHeader) {
      e.preventDefault();
      const groupId = groupHeader.dataset.groupId;
      const labelEl = groupHeader.querySelector('.nav-label');
      if (!labelEl) return;

      _inlineEdit(labelEl, labelEl.textContent, (val) => {
        _renameGroup(groupId, val, null);
      });
      return;
    }

    // ── 3. Project name (.logo-text) ──
    const logoText = e.target.closest('.logo-text');
    if (logoText) {
      e.preventDefault();
      _inlineEdit(logoText, logoText.textContent, (val) => {
        _saveJSON('project_name', val);
        config.projectName = val;
        document.title = val + ' — לוח בקרה';
      });
      return;
    }

    // ── 4. Footer links (.footer-link, .footer-btn) ──
    const footerLink = e.target.closest('.footer-link, .footer-btn');
    if (footerLink && footerLink.closest('#sd-sidebar-footer')) {
      e.preventDefault();
      const footer = document.getElementById('sd-sidebar-footer');
      const allLinks = [...footer.querySelectorAll('.footer-link, .footer-btn')];
      const idx = allLinks.indexOf(footerLink);
      if (idx === -1 || !config.footerLinks?.[idx]) return;
      const f = config.footerLinks[idx];

      // Extract text without icon
      const currentLabel = f.label;
      const icon = f.icon ? f.icon + ' ' : '';

      _inlineEdit(footerLink, currentLabel, (val) => {
        f.label = val;
        footerLink.innerHTML = icon + esc(val);
        // Add back health dot if needed
        if (f.healthUrl) {
          footerLink.insertAdjacentHTML('afterbegin', `<span class="footer-health-dot" id="sd-footer-health-${idx}"></span>`);
        }
        const savedLabels = _loadJSON('footer_labels') || {};
        savedLabels[idx] = val;
        _saveJSON('footer_labels', savedLabels);
      });
      return;
    }

    // ── 5. Stat card labels (.stat-label) ──
    const statLabel = e.target.closest('.stat-label');
    if (statLabel) {
      e.preventDefault();
      const card = statLabel.closest('.stat-card');
      const allCards = [...document.querySelectorAll('#sd-overview-cards .stat-card')];
      const idx = allCards.indexOf(card);

      _inlineEdit(statLabel, statLabel.textContent, (val) => {
        const savedStatLabels = _loadJSON('stat_labels') || {};
        savedStatLabels[idx] = val;
        _saveJSON('stat_labels', savedStatLabels);
      });
      return;
    }

    // ── 6. Table headers (th) ──
    const th = e.target.closest('th');
    if (th) {
      e.preventDefault();
      const table = th.closest('table');
      const section = th.closest('.tab-content');
      const tabId = section?.id?.replace('tab-', '') || 'unknown';
      const allTh = [...table.querySelectorAll('thead th')];
      const idx = allTh.indexOf(th);

      _inlineEdit(th, th.textContent, (val) => {
        const savedThLabels = _loadJSON('table_headers') || {};
        if (!savedThLabels[tabId]) savedThLabels[tabId] = {};
        savedThLabels[tabId][idx] = val;
        _saveJSON('table_headers', savedThLabels);
      });
      return;
    }
  });
}

function _rebuildSidebarNav(config) {
  const nav = document.getElementById('sd-nav');
  if (!nav) return;
  nav.innerHTML = _buildNavItems(config);
  _wireGroupToggles();
  wireDraggableTabs(config);
}

function buildSidebar(config) {
  const logoHtml = config.logoUrl
    ? `<img src="${esc(config.logoUrl)}" class="logo-img" alt="">`
    : `<span class="logo">${esc(config.logoText || config.projectName[0])}</span>`;

  const navItems = _buildNavItems(config);

  const footerLinks = (config.footerLinks || []).map((f, i) => {
    const dot = f.healthUrl ? `<span class="footer-health-dot" id="sd-footer-health-${i}"></span>` : '';
    if (f.href) {
      return `<a href="${esc(f.href)}" target="${f.target || '_blank'}" class="footer-link">${dot}${f.icon || ''} ${esc(f.label)}</a>`;
    }
    if (f.action) {
      return `<button onclick="window.__sd_footerAction__('${esc(f.action)}')" class="footer-link footer-btn">${dot}${f.icon || ''} ${esc(f.label)}</button>`;
    }
    return '';
  }).join('');

  // Build pinned tabs for footer
  const pinnedIds = ['dashboard-categories', 'dashboard-settings'];
  const pinnedHtml = pinnedIds.map(id => {
    const p = config.pages.find(pg => pg.id === id);
    if (!p) return '';
    return `<button type="button" class="nav-item nav-pinned-footer" data-tab="${esc(p.id)}">
      <span class="nav-icon">${p.icon}</span>
      <span class="nav-label">${esc(p.label)}</span>
    </button>`;
  }).join('');

  return `
    <aside class="sidebar" id="sd-sidebar">
      <div class="sidebar-header">
        ${logoHtml}
        <span class="logo-text">${esc(config.projectName)}</span>
        <button class="sidebar-collapse-btn" id="sd-sidebar-collapse" title="\u05d4\u05e6\u05de\u05d3/\u05d4\u05e1\u05ea\u05e8 \u05e1\u05e8\u05d2\u05dc">&#x25B6;</button>
      </div>
      <div class="nav-group-toggle-bar" id="sd-nav-group-toggles">
        <button class="nav-group-toggle-btn" id="sd-collapse-all" title="\u05db\u05d5\u05d5\u05e5 \u05d4\u05db\u05dc">&#x25C0;</button>
        <button class="nav-group-toggle-btn" id="sd-expand-all" title="\u05e4\u05ea\u05d7 \u05d4\u05db\u05dc">&#x25BC;</button>
      </div>
      <nav class="nav" id="sd-nav">${navItems}</nav>
      <div class="sidebar-footer" id="sd-sidebar-footer">
        <div class="footer-pinned-tabs" id="sd-footer-pinned">${pinnedHtml}</div>
        ${footerLinks}
        <div id="sd-status"><span class="status-dot warn"></span> \u05de\u05ea\u05d7\u05d1\u05e8...</div>
      </div>
    </aside>`;
}

// ─── Health checks ───

async function checkHealth(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    // Network error or timeout — try no-cors as fallback (for cross-origin)
    try {
      await fetch(url, { mode: 'no-cors', signal: AbortSignal.timeout(4000) });
      return true; // Server responded (opaque response)
    } catch {
      return false;
    }
  }
}

async function runHealthChecks(config) {
  // Check current server health
  try {
    const health = await api('/health');
    const dot = health.status === 'ok' ? 'ok' : 'err';
    const statusText = health.status === 'ok' ? '\u05de\u05d7\u05d5\u05d1\u05e8' : '\u05ea\u05e7\u05dc\u05d4';
    const statusEl = document.getElementById('sd-status');
    if (statusEl) statusEl.innerHTML = `<span class="status-dot ${dot}"></span> ${statusText}`;
    window.__sd_healthData__ = health;
  } catch {
    const statusEl = document.getElementById('sd-status');
    if (statusEl) statusEl.innerHTML = `<span class="status-dot err"></span> \u05dc\u05d0 \u05de\u05d7\u05d5\u05d1\u05e8`;
    window.__sd_healthData__ = {};
  }

  // Check footer link health URLs
  (config.footerLinks || []).forEach(async (f, i) => {
    if (!f.healthUrl) return;
    const dot = document.getElementById(`sd-footer-health-${i}`);
    if (!dot) return;
    const ok = await checkHealth(f.healthUrl);
    dot.className = 'footer-health-dot ' + (ok ? 'up' : 'down');
  });
}

// ─── Main content area ───

function buildMain(config) {
  const hiddenTabs = _loadJSON('hidden_tabs') || [];

  const pages = config.pages.map((p, i) => {
    const isHidden = hiddenTabs.includes(p.id);
    const cls = (i === 0 && !isHidden ? 'tab-content active' : 'tab-content') + (isHidden ? ' tab-hidden' : '');
    return `<section class="${cls}" id="tab-${esc(p.id)}"${isHidden ? ' style="display:none !important"' : ''}>
      <h2 class="page-title">${esc(p.title || p.label)}</h2>
      <div class="page-body" id="page-body-${esc(p.id)}"></div>
    </section>`;
  }).join('');

  return `
    <div class="main" id="sd-main">
      <header class="header">
        <button class="menu-toggle" id="sd-menu-toggle">\u2630</button>
        <div class="project-switcher" id="sd-project-switcher"></div>
        <div class="header-info" id="sd-header-info"></div>
      </header>
      ${pages}
    </div>`;
}

// ─── Thread modal (shared) ───

function buildThreadModal() {
  return `
    <div class="modal-overlay hidden" id="sd-thread-overlay">
      <div class="modal-box">
        <div class="modal-header">
          <h3 id="sd-thread-title">\u05e9\u05d9\u05d7\u05d4</h3>
          <button class="modal-close" id="sd-thread-close">&times;</button>
        </div>
        <div class="modal-body" id="sd-thread-body"></div>
      </div>
    </div>`;
}

// ─── Navigation ───

function wireNavigation(config) {
  const nav = document.getElementById('sd-nav');
  if (!nav) return;

  nav.addEventListener('click', (e) => {
    if (e.target.closest('.reorder-btn') || e.target.closest('.tab-rename-input')) return;
    const item = e.target.closest('[data-tab]');
    if (!item || !nav.contains(item)) return;
    activatePage(item.dataset.tab, config);
  });

  // ─── Right-click to rename tab ───
  nav.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.nav-item');
    if (!item) return;
    e.preventDefault();

    const tabId = item.dataset.tab;
    const page = config.pages.find(p => p.id === tabId);
    if (!page) return;

    // Don't allow renaming settings tab
    if (tabId === 'dashboard-settings') return;

    const labelEl = item.querySelector('.nav-label');
    if (!labelEl || labelEl.querySelector('.tab-rename-input')) return;

    const currentName = labelEl.textContent;
    const origWidth = labelEl.offsetWidth;

    // Replace label with input
    labelEl.innerHTML = `<input class="tab-rename-input" value="${esc(currentName)}" />`;
    const input = labelEl.querySelector('.tab-rename-input');
    input.style.width = Math.max(origWidth, 80) + 'px';
    input.select();
    input.focus();

    // Prevent drag while editing
    item.setAttribute('draggable', 'false');

    function commitRename() {
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        // Update label
        labelEl.textContent = newName;

        // Update page title
        const pageTitle = document.querySelector(`#tab-${tabId} .page-title`);
        if (pageTitle) pageTitle.textContent = newName;

        // Save to config
        page.label = newName;
        page.title = newName;

        // Persist to localStorage
        const savedLabels = _loadJSON('tab_labels') || {};
        savedLabels[tabId] = newName;
        _saveJSON('tab_labels', savedLabels);

        _showToast('שם הטאב עודכן');
      } else {
        labelEl.textContent = currentName;
      }
      item.setAttribute('draggable', 'true');
    }

    function cancelRename() {
      labelEl.textContent = currentName;
      item.setAttribute('draggable', 'true');
    }

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commitRename(); }
      if (ev.key === 'Escape') { ev.preventDefault(); cancelRename(); }
    });

    input.addEventListener('blur', () => {
      // Small delay to allow click events to fire first
      setTimeout(() => {
        if (labelEl.querySelector('.tab-rename-input')) commitRename();
      }, 100);
    });

    // Stop click from navigating while editing
    input.addEventListener('click', (ev) => ev.stopPropagation());
  });
}

function activatePage(pageId, config) {
  // Validate page exists
  if (!config.pages.find(p => p.id === pageId)) return;

  // Update nav + footer pinned active states
  document.querySelectorAll('#sd-nav .nav-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('#sd-footer-pinned .nav-pinned-footer').forEach(el => el.classList.remove('active'));
  const navItem = document.querySelector(`#sd-nav [data-tab="${pageId}"]`);
  if (navItem) navItem.classList.add('active');
  const footerItem = document.querySelector(`#sd-footer-pinned [data-tab="${pageId}"]`);
  if (footerItem) footerItem.classList.add('active');

  // Auto-expand parent group if tab is inside a collapsed group
  const parentGroup = navItem?.closest('.nav-group');
  if (parentGroup) {
    const children = parentGroup.querySelector('.nav-group-children');
    const arrow = parentGroup.querySelector('.nav-group-arrow');
    if (children && children.classList.contains('collapsed')) {
      children.classList.remove('collapsed');
      if (arrow) arrow.textContent = '\u25BC';
      // Update persisted collapsed state
      const groupId = parentGroup.dataset.groupId;
      let coll = _getCollapsedGroups();
      coll = coll.filter(id => id !== groupId);
      _saveCollapsedGroups(coll);
    }
  }

  // Update content (scoped to #sd-main to avoid touching custom page internals)
  document.querySelectorAll('#sd-main > .tab-content').forEach(el => el.classList.remove('active'));
  const tab = document.getElementById('tab-' + pageId);
  if (tab) tab.classList.add('active');

  // Update URL hash for persistence
  history.replaceState(null, '', '#' + pageId);

  // Close mobile menu
  document.getElementById('sd-sidebar')?.classList.remove('open');

  // Load page data
  loadPageData(pageId, config);
}

function loadPageData(pageId, config) {
  const page = config.pages.find(p => p.id === pageId);
  if (!page) return;

  try {
    if (page.type === 'builtin') {
      loadBuiltinPage(page);
    } else if (page.type === 'custom' && page.onActivate) {
      Promise.resolve(page.onActivate()).catch(err => {
        console.error(`[dashboard] onActivate error for "${pageId}":`, err);
      });
    }
  } catch (err) {
    console.error(`[dashboard] loadPageData error for "${pageId}":`, err);
  }
}

function refreshActivePage(config) {
  const activeNav = document.querySelector('#sd-nav .nav-item.active');
  if (!activeNav) return;
  loadPageData(activeNav.dataset.tab, config);
}

// ─── Mobile ───

function wireMobileMenu() {
  const toggle = document.getElementById('sd-menu-toggle');
  const sidebar = document.getElementById('sd-sidebar');
  if (!toggle || !sidebar) return;

  toggle.addEventListener('click', () => sidebar.classList.toggle('open'));

  // Close on outside click
  document.addEventListener('click', (e) => {
    if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && e.target !== toggle) {
      sidebar.classList.remove('open');
    }
  });
}

// ─── Draggable tabs ───

function wireDraggableTabs(config) {
  const nav = document.getElementById('sd-nav');
  if (!nav) return;

  const prefix = _prefix();
  const pinnedIds = ['dashboard-categories', 'dashboard-settings'];
  let draggedItem = null;

  function _isPinned(el) {
    if (!el) return false;
    if (el.classList.contains('nav-pinned')) return true;
    if (el.dataset.tab && pinnedIds.includes(el.dataset.tab)) return true;
    return false;
  }

  // Get the draggable element — individual nav-item (even inside a group) or nav-group header
  function _topDraggable(el) {
    if (!el) return null;
    // Individual tab (even if inside a group) takes priority
    const item = el.closest('.nav-item');
    if (item) return item;
    // Group header → drag the whole group
    const groupHeader = el.closest('.nav-group-header');
    if (groupHeader) return groupHeader.closest('.nav-group');
    const group = el.closest('.nav-group');
    if (group) return group;
    return null;
  }

  function saveOrder() {
    // Save order of top-level items: group IDs and ungrouped tab IDs
    const order = [];
    for (const child of nav.children) {
      if (child.dataset.groupId) {
        order.push(child.dataset.groupId); // nav-group
      } else if (child.dataset.tab && !pinnedIds.includes(child.dataset.tab)) {
        order.push(child.dataset.tab); // ungrouped nav-item
      }
    }
    localStorage.setItem(prefix + 'nav_order', JSON.stringify(order));

    // Also persist children order within each group
    const groups = _getTabGroups();
    let changed = false;
    nav.querySelectorAll('.nav-group').forEach(groupEl => {
      const gid = groupEl.dataset.groupId;
      const g = groups.find(g => g.id === gid);
      if (!g) return;
      const domChildren = [...groupEl.querySelectorAll('.nav-group-children .nav-child')].map(b => b.dataset.tab).filter(Boolean);
      if (domChildren.length && JSON.stringify(domChildren) !== JSON.stringify(g.children)) {
        g.children = domChildren;
        changed = true;
      }
    });
    if (changed) _saveTabGroups(groups);

    _syncSettingsToDb();
  }

  // ─── Up/Down button clicks (supports reordering children within groups) ───
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.reorder-btn');
    if (!btn) return;
    e.stopPropagation();
    const item = _topDraggable(btn);
    if (!item || _isPinned(item)) return;

    const dir = btn.dataset.dir;
    const isChild = item.classList.contains('nav-child');

    if (isChild) {
      // Reorder within the group's children container
      const container = item.parentElement;
      const prev = item.previousElementSibling;
      const next = item.nextElementSibling;
      if (dir === 'up' && prev) {
        container.insertBefore(item, prev);
        saveOrder();
      } else if (dir === 'down' && next) {
        container.insertBefore(next, item);
        saveOrder();
      }
    } else {
      // Top-level reorder (existing behavior)
      const prev = item.previousElementSibling;
      const next = item.nextElementSibling;
      if (dir === 'up' && prev && !prev.classList.contains('nav-group-divider')) {
        nav.insertBefore(item, prev);
        saveOrder();
      } else if (dir === 'down' && next && !next.classList.contains('nav-group-divider') && !_isPinned(next)) {
        nav.insertBefore(next, item);
        saveOrder();
      }
    }
  });

  // ─── Drag & drop (supports dragging tabs into/out of groups) ───

  function _clearDragHighlights() {
    nav.querySelectorAll('.nav-item, .nav-group').forEach(el => el.classList.remove('drag-over'));
    nav.querySelectorAll('.nav-group').forEach(el => el.classList.remove('group-drop-target'));
  }

  nav.addEventListener('dragstart', (e) => {
    draggedItem = _topDraggable(e.target);
    if (!draggedItem || _isPinned(draggedItem)) { draggedItem = null; e.preventDefault(); return; }
    // If dragging a child tab, prevent the parent group from being dragged
    if (draggedItem.classList.contains('nav-child')) {
      e.stopPropagation();
    }
    draggedItem.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  nav.addEventListener('dragend', () => {
    if (draggedItem) draggedItem.classList.remove('dragging');
    _clearDragHighlights();
    draggedItem = null;
    saveOrder();
  });

  nav.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!draggedItem) return;

    _clearDragHighlights();

    const isDraggingTab = draggedItem.classList.contains('nav-item');
    const groupHeader = e.target.closest('.nav-group-header');
    const targetGroup = e.target.closest('.nav-group');

    // Highlight group as drop target when dragging a tab over a group (header or children area)
    if (isDraggingTab && targetGroup && targetGroup !== draggedItem.closest('.nav-group')) {
      targetGroup.classList.add('group-drop-target');
      return;
    }

    // Highlight target for reorder (child within same group, or top-level reorder)
    const target = _topDraggable(e.target);
    if (target && target !== draggedItem && !_isPinned(target)) {
      target.classList.add('drag-over');
    }
  });

  nav.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!draggedItem) return;

    const isDraggingTab = draggedItem.classList.contains('nav-item');
    const tabId = draggedItem.dataset?.tab;
    const groupHeader = e.target.closest('.nav-group-header');
    const targetGroup = e.target.closest('.nav-group');
    const isChildDrag = draggedItem.classList.contains('nav-child');
    const isGroupDrag = draggedItem.classList.contains('nav-group') || !!draggedItem.dataset?.groupId;

    // ── Case 1: Drop a tab onto a group → assign to that group ──
    if (isDraggingTab && targetGroup && tabId && !isChildDrag) {
      const groupId = targetGroup.dataset.groupId;
      if (groupId && targetGroup !== draggedItem.closest('.nav-group')) {
        _assignTabToGroup(tabId, groupId);
        _showToast('הטאב שויך לקטגוריה');
        draggedItem = null;
        return;
      }
    }
    // Also handle child tab dropped onto a different group
    if (isChildDrag && targetGroup && tabId) {
      const groupId = targetGroup.dataset.groupId;
      const sourceGroup = draggedItem.closest('.nav-group');
      if (groupId && sourceGroup && sourceGroup.dataset.groupId !== groupId) {
        _assignTabToGroup(tabId, groupId);
        _showToast('הטאב הועבר לקטגוריה');
        draggedItem = null;
        return;
      }
    }

    // ── Case 2: Drop a child tab onto top-level area → ungroup it ──
    if (isChildDrag && !targetGroup && tabId) {
      const groups = _getTabGroups();
      groups.forEach(g => {
        g.children = g.children.filter(c => c !== tabId);
        if (g.defaultChild === tabId) delete g.defaultChild;
      });
      _saveTabGroups(groups);
      _showToast('הטאב הוסר מהקטגוריה');
      // Insert at the drop position
      const topTarget = [...nav.querySelectorAll(':scope > .nav-item:not(.nav-pinned), :scope > .nav-group')].find(el => {
        const rect = el.getBoundingClientRect();
        return e.clientY <= rect.bottom;
      });
      _rebuildSidebarNav(config);
      draggedItem = null;
      return;
    }

    // ── Case 3: Drop a child onto another child in same group → reorder within group ──
    const targetItem = e.target.closest('.nav-item');
    if (isChildDrag && targetItem && targetItem.classList.contains('nav-child') && targetItem !== draggedItem) {
      const sourceGroupEl = draggedItem.closest('.nav-group');
      const targetGroupEl = targetItem.closest('.nav-group');
      if (sourceGroupEl && sourceGroupEl === targetGroupEl) {
        const container = targetItem.parentElement;
        const rect = targetItem.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) {
          container.insertBefore(draggedItem, targetItem);
        } else {
          container.insertBefore(draggedItem, targetItem.nextSibling);
        }
        return;
      }
      // Different group → reassign to target group
      if (targetGroupEl && tabId) {
        const newGroupId = targetGroupEl.dataset.groupId;
        if (newGroupId) {
          _assignTabToGroup(tabId, newGroupId);
          _showToast('הטאב הועבר לקטגוריה');
          draggedItem = null;
          return;
        }
      }
    }

    // ── Case 4: Default top-level reorder (existing behavior) ──
    const target = _topDraggable(e.target);
    if (target && target !== draggedItem && !_isPinned(target) && !isChildDrag) {
      const rect = target.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        nav.insertBefore(draggedItem, target);
      } else {
        nav.insertBefore(draggedItem, target.nextSibling);
      }
    }
  });

  // ─── Touch drag support (mobile) — supports group assignment ───
  let touchItem = null;
  let touchClone = null;
  let touchStartY = 0;

  nav.addEventListener('touchstart', (e) => {
    const item = _topDraggable(e.target);
    if (!item || _isPinned(item) || e.target.closest('.reorder-btn')) return;
    touchItem = item;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  nav.addEventListener('touchmove', (e) => {
    if (!touchItem) return;
    const dy = Math.abs(e.touches[0].clientY - touchStartY);
    if (dy < 10) return;
    e.preventDefault();

    if (!touchClone) {
      touchItem.classList.add('dragging');
      touchClone = true;
    }

    const y = e.touches[0].clientY;
    _clearDragHighlights();

    const isTouchTab = touchItem.classList.contains('nav-item');

    // Check if hovering over a group header (for drop-into-group)
    const allGroupHeaders = nav.querySelectorAll('.nav-group-header');
    let overGroupHeader = false;
    if (isTouchTab) {
      for (const header of allGroupHeaders) {
        const rect = header.getBoundingClientRect();
        if (y > rect.top && y < rect.bottom) {
          const parentGroup = header.closest('.nav-group');
          if (parentGroup && parentGroup !== touchItem.closest('.nav-group')) {
            parentGroup.classList.add('group-drop-target');
            overGroupHeader = true;
          }
          break;
        }
      }
    }

    if (!overGroupHeader) {
      const items = [...nav.querySelectorAll(':scope > .nav-item:not(.nav-pinned), :scope > .nav-group')];
      for (const el of items) {
        if (el === touchItem) continue;
        const rect = el.getBoundingClientRect();
        if (y > rect.top && y < rect.bottom) {
          el.classList.add('drag-over');
          break;
        }
      }
    }
  }, { passive: false });

  nav.addEventListener('touchend', (e) => {
    if (!touchItem || !touchClone) { touchItem = null; touchClone = null; return; }
    const y = e.changedTouches[0].clientY;
    const isTouchTab = touchItem.classList.contains('nav-item');
    const tabId = touchItem.dataset?.tab;
    const isTouchChild = touchItem.classList.contains('nav-child');

    // Check if dropping onto a group header
    if (isTouchTab && tabId) {
      const allGroupHeaders = nav.querySelectorAll('.nav-group-header');
      for (const header of allGroupHeaders) {
        const rect = header.getBoundingClientRect();
        if (y > rect.top && y < rect.bottom) {
          const groupId = header.dataset.groupId;
          if (groupId) {
            _assignTabToGroup(tabId, groupId);
            _showToast('הטאב שויך לקטגוריה');
            touchItem = null; touchClone = null;
            return;
          }
        }
      }
    }

    // Check if child tab dropped outside any group → ungroup
    if (isTouchChild && tabId) {
      const groups = nav.querySelectorAll('.nav-group');
      let overGroup = false;
      for (const g of groups) {
        const rect = g.getBoundingClientRect();
        if (y > rect.top && y < rect.bottom) { overGroup = true; break; }
      }
      if (!overGroup) {
        const grps = _getTabGroups();
        grps.forEach(g => {
          g.children = g.children.filter(c => c !== tabId);
          if (g.defaultChild === tabId) delete g.defaultChild;
        });
        _saveTabGroups(grps);
        _showToast('הטאב הוסר מהקטגוריה');
        _rebuildSidebarNav(config);
        touchItem = null; touchClone = null;
        return;
      }
    }

    // Default: top-level reorder
    const items = [...nav.querySelectorAll(':scope > .nav-item:not(.nav-pinned), :scope > .nav-group')];
    for (const el of items) {
      if (el === touchItem) continue;
      const rect = el.getBoundingClientRect();
      if (y > rect.top && y < rect.bottom) {
        const midY = rect.top + rect.height / 2;
        if (y < midY) {
          nav.insertBefore(touchItem, el);
        } else {
          nav.insertBefore(touchItem, el.nextSibling);
        }
        break;
      }
    }
    touchItem.classList.remove('dragging');
    _clearDragHighlights();
    saveOrder();
    touchItem = null;
    touchClone = null;
  });

  // Footer action for reset
  window.__sd_footerAction__ = (action) => {
    if (action === 'resetTabOrder') {
      localStorage.removeItem(prefix + 'nav_order');
      location.reload();
    }
    if (action === 'openTerminal') {
      fetch('/admin/api/open-terminal', { method: 'POST', headers: authHeaders() })
        .then(r => r.json())
        .then(d => { if (!d.ok) console.error('open-terminal failed', d); })
        .catch(e => console.error('open-terminal error', e));
    }
  };
}

// ─── Builtin page rendering ───

function renderBuiltinPage(page, container) {
  switch (page.builtinType) {
    case 'conversations':
      container.innerHTML = `
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>\u05de\u05e9\u05ea\u05de\u05e9</th>
              <th>\u05e2\u05e8\u05d5\u05e5</th>
              <th>\u05d4\u05d5\u05d3\u05e2\u05d4</th>
              <th>\u05ea\u05d2\u05d5\u05d1\u05d4</th>
              <th>\u05d6\u05de\u05df</th>
            </tr></thead>
            <tbody id="sd-conv-table"></tbody>
          </table>
        </div>`;
      break;

    case 'dashboard-categories':
      renderCategoriesPage(container);
      break;

    case 'dashboard-settings':
      renderSettingsPage(container);
      break;
  }
}

// ─── Builtin page data loaders ───

async function loadBuiltinPage(page) {
  switch (page.builtinType) {
    case 'conversations': await loadConversations(); break;
    case 'dashboard-categories': loadCategoriesPage(); break;
    case 'dashboard-settings': loadSettingsPage(); break;
  }
}

async function loadConversations() {
  try {
    const res = await api('/admin/api/conversations?limit=50');
    const convs = res.conversations || [];
    const tbody = document.getElementById('sd-conv-table');
    if (tbody) {
      tbody.innerHTML = convs.length
        ? convs.map(c => `
          <tr style="cursor:pointer" onclick="window.__sd_openThread__('${esc(c.user_id)}','${esc(c.user_name || c.user_id)}')">
            <td>${esc(c.user_name || c.user_id)}</td>
            <td>${badge(c.channel || '', c.channel || '\u2014')}</td>
            <td>${trunc(c.user_message, 60)}</td>
            <td>${trunc(c.assistant_message, 60)}</td>
            <td>${formatTime(c.created_at)}</td>
          </tr>`).join('')
        : emptyRow(5, '\u05d0\u05d9\u05df \u05e9\u05d9\u05d7\u05d5\u05ea \u05e2\u05d3\u05d9\u05d9\u05df');
    }
  } catch {
    const tbody = document.getElementById('sd-conv-table');
    if (tbody) tbody.innerHTML = emptyRow(5, '\u05e9\u05d2\u05d9\u05d0\u05d4 \u05d1\u05d8\u05e2\u05d9\u05e0\u05d4');
  }
}

// ─── Categories page ───

const UNDELETABLE_TABS = ['dashboard-categories', 'dashboard-settings'];

function renderCategoriesPage(container) {
  container.innerHTML = `
    <div class="settings-page settings-page-categories">

      <div class="settings-section">
        <div class="settings-section-title">\u05e7\u05d8\u05d2\u05d5\u05e8\u05d9\u05d5\u05ea \u05d0\u05d1</div>
        <p style="font-size:0.82rem;color:var(--muted);margin-bottom:16px">\u05e6\u05d5\u05e8 \u05e7\u05d1\u05d5\u05e6\u05d5\u05ea \u05dc\u05d0\u05e8\u05d2\u05d5\u05df \u05d8\u05d0\u05d1\u05d9\u05dd \u05d1\u05ea\u05e4\u05e8\u05d9\u05d8 \u05d4\u05e6\u05d3</p>
        <div class="cat-create-form" id="sd-cat-create-form">
          <button type="button" class="emoji-picker-trigger" id="sd-cat-new-icon" data-emoji="\uD83D\uDCC1">\uD83D\uDCC1</button>
          <input class="settings-input" id="sd-cat-new-name" placeholder="\u05e9\u05dd \u05d4\u05e7\u05d8\u05d2\u05d5\u05e8\u05d9\u05d4" style="flex:1" />
          <button class="btn-primary" id="sd-cat-create-btn">\u05e6\u05d5\u05e8</button>
        </div>
        <div id="sd-cat-groups-list" style="margin-top:16px"></div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">\u05e0\u05d9\u05d4\u05d5\u05dc \u05d8\u05d0\u05d1\u05d9\u05dd</div>
        <p style="font-size:0.82rem;color:var(--muted);margin-bottom:16px">\u05e9\u05d9\u05d5\u05da \u05dc\u05e7\u05d8\u05d2\u05d5\u05e8\u05d9\u05d4 \u05d5\u05d4\u05e6\u05d2\u05d4/\u05d4\u05e1\u05ea\u05e8\u05d4 \u05e9\u05dc \u05d8\u05d0\u05d1\u05d9\u05dd</p>
        <div id="sd-cat-tabs-list"></div>
      </div>

      <div style="text-align:center;margin-top:24px;padding-bottom:16px">
        <button class="btn-primary" id="sd-cat-save-db" style="padding:10px 32px;font-size:0.95rem">\u05e9\u05de\u05d5\u05e8 \u05e9\u05d9\u05e0\u05d5\u05d9\u05d9\u05dd</button>
        <div id="sd-cat-save-status" style="margin-top:8px;font-size:0.82rem;color:var(--muted);min-height:1.2em"></div>
      </div>

    </div>`;
}

function loadCategoriesPage() {
  const pages = (_config?.pages || []);
  const hiddenTabs = _loadJSON('hidden_tabs') || [];
  const groups = _getTabGroups();

  // ─── Section 1: Parent Groups ───
  const groupsList = document.getElementById('sd-cat-groups-list');
  if (groupsList) {
    if (groups.length === 0) {
      groupsList.innerHTML = '<div class="empty-state" style="padding:12px">\u05dc\u05d0 \u05e0\u05d5\u05e6\u05e8\u05d5 \u05e7\u05d8\u05d2\u05d5\u05e8\u05d9\u05d5\u05ea \u05e2\u05d3\u05d9\u05d9\u05df</div>';
    } else {
      groupsList.innerHTML = groups.map(g => {
        const childLabels = g.children.map(cid => {
          const p = pages.find(p => p.id === cid);
          return p ? `<span class="cat-child-chip" data-group-id="${esc(g.id)}" data-tab-id="${esc(cid)}">${p.icon} ${esc(p.label)} <span class="cat-child-remove">\u00d7</span></span>` : '';
        }).filter(Boolean).join('');

        // Default child selector
        const childPagesForSelect = g.children.map(cid => pages.find(p => p.id === cid)).filter(Boolean);
        const defaultChildSelect = childPagesForSelect.length > 0
          ? `<div class="cat-group-default-row">
              <span class="cat-group-default-label">\u05d8\u05d0\u05d1 \u05d1\u05e8\u05d9\u05e8\u05ea \u05de\u05d7\u05d3\u05dc:</span>
              <select class="cat-assign-select cat-group-default-select" data-default-group="${esc(g.id)}">
                <option value="">\u05dc\u05dc\u05d0 (\u05e8\u05e7 \u05e4\u05ea\u05d9\u05d7\u05d4/\u05e1\u05d2\u05d9\u05e8\u05d4)</option>
                ${childPagesForSelect.map(p => `<option value="${esc(p.id)}"${p.id === g.defaultChild ? ' selected' : ''}>${p.icon} ${esc(p.label)}</option>`).join('')}
              </select>
            </div>`
          : '';

        return `<div class="cat-group-card" data-group-id="${esc(g.id)}">
          <div class="cat-group-card-header">
            <span class="cat-group-icon" data-group-id="${esc(g.id)}">${g.icon}</span>
            <span class="cat-group-name" data-group-id="${esc(g.id)}">${esc(g.name)}</span>
            <button class="btn-secondary cat-group-edit" data-group-id="${esc(g.id)}" title="\u05e2\u05e8\u05d9\u05db\u05d4">\u270F\uFE0F</button>
            <button class="btn-secondary cat-group-delete" data-group-id="${esc(g.id)}" title="\u05de\u05d7\u05e7">\uD83D\uDDD1</button>
          </div>
          <div class="cat-group-children">${childLabels || '<span style="color:var(--text-dim);font-size:0.8rem">\u05d0\u05d9\u05df \u05d8\u05d0\u05d1\u05d9\u05dd \u05de\u05e9\u05d5\u05d9\u05db\u05d9\u05dd</span>'}</div>
          ${defaultChildSelect}
        </div>`;
      }).join('');
    }

    // Wire create button
    const createBtn = document.getElementById('sd-cat-create-btn');
    const nameInput = document.getElementById('sd-cat-new-name');
    const iconTrigger = document.getElementById('sd-cat-new-icon');
    if (iconTrigger) {
      iconTrigger.addEventListener('click', () => {
        _showEmojiPicker(iconTrigger, (emoji) => {
          iconTrigger.dataset.emoji = emoji;
          iconTrigger.textContent = emoji;
        }, nameInput?.value?.trim());
      });
    }
    if (createBtn) {
      createBtn.onclick = () => {
        const name = nameInput?.value?.trim();
        if (!name) { _showToast('\u05d4\u05d6\u05df \u05e9\u05dd \u05dc\u05e7\u05d8\u05d2\u05d5\u05e8\u05d9\u05d4'); return; }
        const icon = iconTrigger?.dataset?.emoji || '\uD83D\uDCC1';
        _createGroup(name, icon);
        if (nameInput) nameInput.value = '';
        if (iconTrigger) { iconTrigger.dataset.emoji = '\uD83D\uDCC1'; iconTrigger.textContent = '\uD83D\uDCC1'; }
        _showToast('\u05e7\u05d8\u05d2\u05d5\u05e8\u05d9\u05d4 \u05e0\u05d5\u05e6\u05e8\u05d4');
        loadCategoriesPage();
      };
    }
    if (nameInput) {
      nameInput.onkeydown = (e) => { if (e.key === 'Enter') createBtn?.click(); };
    }

    // Wire delete buttons
    groupsList.querySelectorAll('.cat-group-delete').forEach(btn => {
      btn.addEventListener('click', () => {
        _deleteGroup(btn.dataset.groupId);
        _showToast('\u05e7\u05d8\u05d2\u05d5\u05e8\u05d9\u05d4 \u05e0\u05de\u05d7\u05e7\u05d4');
        loadCategoriesPage();
      });
    });

    // Wire child chip remove
    groupsList.querySelectorAll('.cat-child-remove').forEach(x => {
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        const chip = x.closest('.cat-child-chip');
        if (!chip) return;
        _removeTabFromGroup(chip.dataset.tabId, chip.dataset.groupId);
        _showToast('\u05d4\u05d8\u05d0\u05d1 \u05d4\u05d5\u05e1\u05e8 \u05de\u05d4\u05e7\u05d8\u05d2\u05d5\u05e8\u05d9\u05d4');
        loadCategoriesPage();
      });
    });

    // Wire default child selects
    groupsList.querySelectorAll('.cat-group-default-select').forEach(sel => {
      sel.addEventListener('change', () => {
        _setGroupDefaultChild(sel.dataset.defaultGroup, sel.value);
        _showToast(sel.value ? '\u05d8\u05d0\u05d1 \u05d1\u05e8\u05d9\u05e8\u05ea \u05de\u05d7\u05d3\u05dc \u05e0\u05e7\u05d1\u05e2' : '\u05d8\u05d0\u05d1 \u05d1\u05e8\u05d9\u05e8\u05ea \u05de\u05d7\u05d3\u05dc \u05d4\u05d5\u05e1\u05e8');
      });
    });

    // Wire edit buttons — inline edit for icon + name
    groupsList.querySelectorAll('.cat-group-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const groupId = btn.dataset.groupId;
        const card = btn.closest('.cat-group-card');
        if (!card) return;
        const g = _getTabGroups().find(g => g.id === groupId);
        if (!g) return;

        const header = card.querySelector('.cat-group-card-header');
        const origIcon = g.icon;
        const origName = g.name;

        // Replace header with inline edit form
        let selectedIcon = origIcon;
        header.innerHTML = `
          <button type="button" class="emoji-picker-trigger cat-edit-icon-trigger">${origIcon}</button>
          <input class="settings-input cat-edit-name-input" value="${esc(origName)}" />
          <button class="btn-primary cat-edit-save" style="padding:5px 12px;font-size:0.8rem">\u2714</button>
          <button class="btn-secondary cat-edit-cancel" style="padding:5px 12px;font-size:0.8rem">\u2716</button>
        `;

        const iconTrig = header.querySelector('.cat-edit-icon-trigger');
        const nameInp = header.querySelector('.cat-edit-name-input');
        const saveBtn = header.querySelector('.cat-edit-save');
        const cancelBtn = header.querySelector('.cat-edit-cancel');

        iconTrig.addEventListener('click', () => {
          _showEmojiPicker(iconTrig, (emoji) => {
            selectedIcon = emoji;
            iconTrig.textContent = emoji;
          }, nameInp?.value?.trim() || origName);
        });

        nameInp.focus();
        nameInp.select();

        function save() {
          const newName = nameInp.value.trim();
          if (!newName) { _showToast('\u05d4\u05d6\u05df \u05e9\u05dd'); return; }
          const nameChanged = newName !== origName;
          const iconChanged = selectedIcon !== origIcon;
          if (nameChanged || iconChanged) {
            _renameGroup(groupId, nameChanged ? newName : null, iconChanged ? selectedIcon : null);
            _showToast('\u05d4\u05e7\u05d8\u05d2\u05d5\u05e8\u05d9\u05d4 \u05e2\u05d5\u05d3\u05db\u05e0\u05d4');
          }
          loadCategoriesPage();
        }

        function cancel() {
          loadCategoriesPage();
        }

        saveBtn.addEventListener('click', save);
        cancelBtn.addEventListener('click', cancel);
        nameInp.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') save();
          if (ev.key === 'Escape') cancel();
        });
      });
    });
  }

  // ─── Section 2: Combined Tab Assignment + Visibility ───
  const tabsList = document.getElementById('sd-cat-tabs-list');
  if (!tabsList) return;

  const currentGroups = _getTabGroups();
  const managablePages = pages.filter(p => !UNDELETABLE_TABS.includes(p.id));

  tabsList.innerHTML = managablePages.map(p => {
    const parentGroup = currentGroups.find(g => g.children.includes(p.id));
    const parentId = parentGroup ? parentGroup.id : '';
    const isVisible = !hiddenTabs.includes(p.id);

    return `<div class="cat-tab-row">
      <label class="toggle-switch">
        <input type="checkbox" ${isVisible ? 'checked' : ''} data-cat-tab="${esc(p.id)}">
        <span class="toggle-slider"></span>
      </label>
      <span class="categories-icon">${p.icon}</span>
      <span class="categories-label">${esc(p.label)}</span>
      <select class="cat-assign-select" data-assign-tab="${esc(p.id)}">
        <option value="">\u05dc\u05dc\u05d0 \u05e7\u05d8\u05d2\u05d5\u05e8\u05d9\u05d4</option>
        ${currentGroups.map(g => `<option value="${esc(g.id)}"${g.id === parentId ? ' selected' : ''}>${g.icon} ${esc(g.name)}</option>`).join('')}
      </select>
    </div>`;
  }).join('');

  // Wire visibility toggles
  tabsList.querySelectorAll('[data-cat-tab]').forEach(input => {
    input.addEventListener('change', () => {
      _toggleTabVisibility(input.dataset.catTab, input.checked);
    });
  });

  // Wire assignment dropdowns
  tabsList.querySelectorAll('.cat-assign-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const tabId = sel.dataset.assignTab;
      const groupId = sel.value;
      if (groupId) {
        _assignTabToGroup(tabId, groupId);
        _showToast('\u05d4\u05d8\u05d0\u05d1 \u05e9\u05d5\u05d9\u05da \u05dc\u05e7\u05d8\u05d2\u05d5\u05e8\u05d9\u05d4');
      } else {
        const grps = _getTabGroups();
        grps.forEach(g => { g.children = g.children.filter(c => c !== tabId); });
        _saveTabGroups(grps);
        _rebuildSidebarNav(_config);
        _showToast('\u05d4\u05d8\u05d0\u05d1 \u05d4\u05d5\u05e1\u05e8 \u05de\u05d4\u05e7\u05d8\u05d2\u05d5\u05e8\u05d9\u05d4');
      }
      loadCategoriesPage();
    });
  });

  // ─── Save to DB button ───
  const saveDbBtn = document.getElementById('sd-cat-save-db');
  const saveStatus = document.getElementById('sd-cat-save-status');
  if (saveDbBtn) {
    saveDbBtn.addEventListener('click', async () => {
      saveDbBtn.disabled = true;
      saveDbBtn.textContent = '\u05e9\u05d5\u05de\u05e8...';
      if (saveStatus) saveStatus.textContent = '';
      try {
        const blob = _collectAllSettings();
        const res = await api('/admin/api/dashboard-settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(blob),
        });
        if (res.ok) {
          _dbAvailable = true;
          _forcebroadcast();
          _showHubSaveNotice();
          _showToast('\u05d4\u05e9\u05d9\u05e0\u05d5\u05d9\u05d9\u05dd \u05e0\u05e9\u05de\u05e8\u05d5 \u05d1\u05d4\u05e6\u05dc\u05d7\u05d4');
          if (saveStatus) { saveStatus.style.color = 'var(--accent)'; saveStatus.textContent = '\u2714 \u05e0\u05e9\u05de\u05e8 \u05d1\u05d4\u05e6\u05dc\u05d7\u05d4'; }
        } else {
          throw new Error(res.error || 'save failed');
        }
      } catch (err) {
        _showToast('\u05e9\u05d2\u05d9\u05d0\u05d4 \u05d1\u05e9\u05de\u05d9\u05e8\u05d4', 'error');
        if (saveStatus) { saveStatus.style.color = '#f44'; saveStatus.textContent = '\u2716 \u05e9\u05d2\u05d9\u05d0\u05d4 \u05d1\u05e9\u05de\u05d9\u05e8\u05d4'; }
      } finally {
        saveDbBtn.disabled = false;
        saveDbBtn.textContent = '\u05e9\u05de\u05d5\u05e8 \u05e9\u05d9\u05e0\u05d5\u05d9\u05d9\u05dd';
      }
    });
  }
}

function _toggleTabVisibility(tabId, visible) {
  let hiddenTabs = _loadJSON('hidden_tabs') || [];

  if (visible) {
    hiddenTabs = hiddenTabs.filter(id => id !== tabId);
  } else {
    if (!hiddenTabs.includes(tabId)) hiddenTabs.push(tabId);
  }

  _saveJSON('hidden_tabs', hiddenTabs);

  // If hiding the active tab, switch to first visible
  const navItem = document.querySelector(`#sd-nav [data-tab="${tabId}"]`);
  if (!visible && navItem && navItem.classList.contains('active')) {
    const firstVisible = document.querySelector('#sd-nav .nav-item:not(.nav-hidden)');
    if (firstVisible) activatePage(firstVisible.dataset.tab, _config);
  }

  // Rebuild sidebar to update group visibility
  _rebuildSidebarNav(_config);

  // Live-update tab content
  const tabContent = document.getElementById('tab-' + tabId);
  if (tabContent) {
    if (visible) {
      tabContent.style.display = '';
      tabContent.classList.remove('tab-hidden');
    } else {
      tabContent.style.display = 'none';
      tabContent.classList.add('tab-hidden');
    }
  }

  _showToast(visible ? '\u05d4\u05d8\u05d0\u05d1 \u05d4\u05d5\u05d7\u05d6\u05e8' : '\u05d4\u05d8\u05d0\u05d1 \u05d4\u05d5\u05e1\u05e8');
}

// ─── Settings page ───

function renderSettingsPage(container) {
  container.style.width = "100%";
  container.style.maxWidth = "none";
  const hostTab = container.closest(".tab-content");
  if (hostTab) {
    const main = document.getElementById("sd-main");
    if (main) { main.style.maxWidth = "none"; main.style.width = "100%"; }
    hostTab.style.width = "100%";
    hostTab.style.maxWidth = "none";
  }
  container.innerHTML = `
    <div class="settings-page settings-page-dashboard" style="width:100%;max-width:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));align-items:start">

      <div class="settings-section">
        <div class="settings-section-title">\u05DE\u05E6\u05D1 HUB</div>
        <div class="settings-row" style="justify-content:space-between">
          <span id="sd-hub-status-badge" style="font-size:0.9rem;color:var(--muted)">\u05D1\u05D5\u05D3\u05E7...</span>
          <button class="settings-save-btn" id="sd-hub-start-btn" style="display:none">\u05D4\u05D3\u05DC\u05E7 HUB</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">\u05e9\u05dd \u05e4\u05e8\u05d5\u05d9\u05e7\u05d8</div>
        <div class="settings-row">
          <span class="settings-label">\u05e9\u05dd</span>
          <input class="settings-input" id="sd-settings-project-name" value="${esc(_config?.projectName || '')}" placeholder="\u05e9\u05dd \u05d4\u05e4\u05e8\u05d5\u05d9\u05e7\u05d8" />
        </div>
        <div class="settings-row">
          <span class="settings-label">\u05d0\u05d9\u05d9\u05e7\u05d5\u05df \u05e4\u05e8\u05d5\u05d9\u05e7\u05d8</span>
          <button class="emoji-picker-trigger" id="sd-settings-project-icon" style="font-size:1.4rem;width:44px;height:44px">${esc(_config?.logoText || _config?.projectName?.[0] || '?')}</button>
          <span class="settings-hint" style="color:var(--muted);font-size:0.8rem">\u05de\u05d5\u05e4\u05d9\u05e2 \u05d1Hub, \u05d1\u05e1\u05e8\u05d2\u05dc \u05d5\u05d1\u05d3\u05e9\u05d1\u05d5\u05e8\u05d3</span>
        </div>
        <div class="settings-actions">
          <button class="settings-save-btn" id="sd-settings-save-project-name">\uD83D\uDCBE \u05e9\u05de\u05d5\u05e8</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">\u05ea\u05de\u05d5\u05e0\u05ea \u05dc\u05d5\u05d2\u05d5</div>
        <div class="settings-preview" id="sd-settings-logo-preview"></div>
        <div class="settings-row">
          <span class="settings-label">\u05db\u05ea\u05d5\u05d1\u05ea \u05ea\u05de\u05d5\u05e0\u05d4</span>
          <input class="settings-input ltr-input" id="sd-settings-logo-url" placeholder="https://..." />
        </div>
        <div class="settings-divider">\u2014 \u05d0\u05d5 \u2014</div>
        <div class="settings-row">
          <span class="settings-label">\u05d8\u05e7\u05e1\u05d8 \u05dc\u05d5\u05d2\u05d5</span>
          <input class="settings-input" id="sd-settings-logo-text" placeholder="\u05d0\u05d5\u05ea \u05d0\u05d5 \u05d0\u05de\u05d5\u05d2'\u05d9" maxlength="4" />
        </div>
        <div class="settings-actions">
          <button class="settings-save-btn" id="sd-settings-save-logo">\uD83D\uDCBE \u05e9\u05de\u05d5\u05e8</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">\uD83D\uDD12 \u05d8\u05d0\u05d1\u05d9\u05dd \u05de\u05e9\u05d5\u05ea\u05e4\u05d9\u05dd (\u05d1\u05db\u05dc \u05d4\u05d3\u05e9\u05d1\u05d5\u05e8\u05d3\u05d9\u05dd)</div>
        <p style="font-size:0.78rem;color:#718096;margin-bottom:10px">\u05e9\u05d9\u05e0\u05d5\u05d9 \u05db\u05d0\u05df \u05d9\u05e2\u05d3\u05db\u05df \u05d0\u05d5\u05d8\u05d5\u05de\u05d8\u05d9\u05ea \u05d1\u05db\u05dc \u05d4\u05d3\u05e9\u05d1\u05d5\u05e8\u05d3\u05d9\u05dd \u2014 \u05d3\u05d5\u05e8\u05e9 \u05e1\u05d9\u05e1\u05de\u05d0</p>
        <div id="sd-settings-shared-tab-list"></div>
        <div class="settings-actions">
          <button class="settings-save-btn" id="sd-settings-save-shared-labels" style="background:linear-gradient(135deg,#6366f1,#00d4ff)">\uD83D\uDD12 \u05e9\u05de\u05d5\u05e8 \u05d5\u05e1\u05e0\u05db\u05e8\u05df \u05dc\u05db\u05dc \u05d4\u05d3\u05e9\u05d1\u05d5\u05e8\u05d3\u05d9\u05dd</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">\u05e9\u05de\u05d5\u05ea \u05d5\u05d0\u05d9\u05d9\u05e7\u05d5\u05e0\u05d9 \u05d8\u05d0\u05d1\u05d9\u05dd</div>
        <div id="sd-settings-tab-list"></div>
        <div class="settings-actions">
          <button class="settings-save-btn" id="sd-settings-save-builtin-labels">\uD83D\uDCBE \u05e9\u05de\u05d5\u05e8</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">\u05e9\u05de\u05d5\u05ea \u05db\u05d9\u05e9\u05d5\u05e8\u05d9\u05dd</div>
        <div id="sd-settings-skills-list">
          <div class="empty-state">\u05d8\u05d5\u05e2\u05df...</div>
        </div>
        <div class="settings-actions">
          <button class="settings-save-btn" id="sd-settings-save-skills">\uD83D\uDCBE \u05e9\u05de\u05d5\u05e8</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">\u05E7\u05D9\u05E9\u05D5\u05E8\u05D9 \u05EA\u05D7\u05EA\u05D9\u05EA</div>
        <div id="sd-settings-footer-list"></div>
        <div class="settings-actions">
          <button class="settings-save-btn" id="sd-settings-save-footer">\uD83D\uDCBE \u05e9\u05de\u05d5\u05e8</button>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">\u05D2\u05D5\u05D3\u05DC \u05E4\u05D5\u05E0\u05D8</div>
        <div class="settings-row" style="align-items:center;gap:12px">
          <span class="settings-label" style="min-width:auto">\u05E7\u05D8\u05DF</span>
          <input type="range" id="sd-settings-font-size" min="80" max="130" step="5" value="100" style="flex:1" />
          <span class="settings-label" style="min-width:auto">\u05D2\u05D3\u05D5\u05DC</span>
          <span id="sd-settings-font-size-value" style="min-width:42px;text-align:center;font-weight:bold">100%</span>
        </div>
        <div class="settings-actions">
          <button class="settings-save-btn" id="sd-settings-save-font">\uD83D\uDCBE \u05e9\u05de\u05d5\u05e8</button>
          <button class="settings-reset-btn" id="sd-settings-reset-font" style="margin-right:8px">\u05D0\u05D9\u05E4\u05D5\u05E1</button>
        </div>
      </div>

      <div style="text-align:center;margin-top:8px">
        <button class="settings-reset-btn" id="sd-settings-reset" style="margin:0 auto">\uD83D\uDD04 \u05d0\u05d9\u05e4\u05d5\u05e1 \u05db\u05dc \u05d4\u05d4\u05d2\u05d3\u05e8\u05d5\u05ea</button>
      </div>

    </div>`;

  // Wire save buttons
  document.getElementById('sd-settings-save-project-name')?.addEventListener('click', _saveProjectName);
  document.getElementById('sd-settings-save-logo')?.addEventListener('click', _saveLogo);
  document.getElementById('sd-settings-save-builtin-labels')?.addEventListener('click', _saveBuiltinLabels);
  document.getElementById('sd-settings-save-shared-labels')?.addEventListener('click', _saveSharedLabels);
  document.getElementById('sd-settings-save-skills')?.addEventListener('click', _saveSkillNames);
  document.getElementById('sd-settings-save-footer')?.addEventListener('click', _saveFooterLabels);
  document.getElementById('sd-settings-save-font')?.addEventListener('click', _saveFontSize);
  document.getElementById('sd-settings-reset-font')?.addEventListener('click', _resetFontSize);
  document.getElementById('sd-settings-reset')?.addEventListener('click', _resetAll);
  document.getElementById('sd-hub-start-btn')?.addEventListener('click', _startHubFromSettings);

  // Wire project icon emoji picker
  const projIconBtn = document.getElementById('sd-settings-project-icon');
  if (projIconBtn) {
    projIconBtn.addEventListener('click', () => {
      _showEmojiPicker(projIconBtn, (emoji) => { projIconBtn.textContent = emoji; });
    });
  }

  // Live preview for logo URL
  document.getElementById('sd-settings-logo-url')?.addEventListener('input', _updateLogoPreview);

  // Live preview for font slider
  const fontSlider = document.getElementById('sd-settings-font-size');
  const fontValue = document.getElementById('sd-settings-font-size-value');
  if (fontSlider) {
    fontSlider.addEventListener('input', () => {
      const v = fontSlider.value + '%';
      if (fontValue) fontValue.textContent = v;
      _applyZoom(parseInt(fontSlider.value));
    });
  }

  _refreshHubStatusUi();
}

function loadSettingsPage() {
  // Populate project name
  const projInp = document.getElementById('sd-settings-project-name');
  if (projInp) projInp.value = _config?.projectName || '';

  // Populate project icon
  const projIconBtn = document.getElementById('sd-settings-project-icon');
  if (projIconBtn) {
    const savedIcon = _loadJSON('project_icon');
    projIconBtn.textContent = savedIcon || _config?.logoText || _config?.projectName?.[0] || '?';
  }

  // Populate shared tabs list (password-protected, synced across all dashboards)
  const sharedTabListEl = document.getElementById('sd-settings-shared-tab-list');
  if (sharedTabListEl && _config?.pages) {
    const sharedPages = _config.pages.filter(p => _SHARED_SYSTEM_TABS.includes(p.id));
    sharedTabListEl.innerHTML = sharedPages.map(p => `
      <div class="settings-row shared-tab-row">
        <span class="settings-label">\uD83D\uDD12 ${esc(p._origLabel || p.label)}</span>
        <input class="settings-input sd-tab-icon-input" data-tab-id="${esc(p.id)}" value="${esc(p.icon || '')}" maxlength="4" placeholder="\u05d0\u05d9\u05d9\u05e7\u05d5\u05df" style="max-width:54px;text-align:center;font-size:1.15rem;padding:6px 4px" />
        <input class="settings-input sd-tab-label-input" data-tab-id="${esc(p.id)}" value="${esc(p.label || '')}" placeholder="\u05e9\u05dd \u05d4\u05d8\u05d0\u05d1" />
      </div>`).join('');
    if (!sharedPages.length) sharedTabListEl.innerHTML = '<div style="color:#718096;font-size:0.82rem">\u05d0\u05d9\u05df \u05d8\u05d0\u05d1\u05d9\u05dd \u05de\u05e9\u05d5\u05ea\u05e4\u05d9\u05dd</div>';
  }

  // Populate project-specific tabs list (no password needed)
  const tabListEl = document.getElementById('sd-settings-tab-list');
  if (tabListEl && _config?.pages) {
    const projectPages = _config.pages.filter(p => !_SHARED_SYSTEM_TABS.includes(p.id));
    tabListEl.innerHTML = projectPages.map(p => `
      <div class="settings-row">
        <span class="settings-label">${esc(p._origLabel || p.label)}</span>
        <input class="settings-input sd-tab-icon-input" data-tab-id="${esc(p.id)}" value="${esc(p.icon || '')}" maxlength="4" placeholder="\u05d0\u05d9\u05d9\u05e7\u05d5\u05df" style="max-width:54px;text-align:center;font-size:1.15rem;padding:6px 4px" />
        <input class="settings-input sd-tab-label-input" data-tab-id="${esc(p.id)}" value="${esc(p.label || '')}" placeholder="\u05e9\u05dd \u05d4\u05d8\u05d0\u05d1" />
      </div>`).join('');
  }

  // Populate logo fields
  const saved = _loadJSON('logo');
  const urlInput = document.getElementById('sd-settings-logo-url');
  const textInput = document.getElementById('sd-settings-logo-text');
  if (urlInput && saved?.type === 'url') urlInput.value = saved.value || '';
  if (textInput && saved?.type === 'text') textInput.value = saved.value || '';
  _updateLogoPreview();

  // Load skills list
  _loadSettingsSkills();

  // Load footer links list
  _loadSettingsFooter();

  // Load font size (zoom percentage)
  const savedFont = _loadJSON('font_size');
  const fontSlider = document.getElementById('sd-settings-font-size');
  const fontValue = document.getElementById('sd-settings-font-size-value');
  if (savedFont && fontSlider) {
    fontSlider.value = savedFont;
    if (fontValue) fontValue.textContent = savedFont + '%';
  }

  _refreshHubStatusUi();
}

function _updateLogoPreview() {
  const preview = document.getElementById('sd-settings-logo-preview');
  if (!preview) return;
  const url = document.getElementById('sd-settings-logo-url')?.value?.trim();
  if (url) {
    preview.innerHTML = `<img src="${esc(url)}" alt="" onerror="this.style.display='none'">`;
  } else if (_config?.logoUrl) {
    preview.innerHTML = `<img src="${esc(_config.logoUrl)}" alt="">`;
  } else {
    preview.innerHTML = `<div class="preview-placeholder">${esc(_config?.logoText || _config?.projectName?.[0] || '?')}</div>`;
  }
}

async function _loadSettingsSkills() {
  const container = document.getElementById('sd-settings-skills-list');
  if (!container) return;

  try {
    const res = await api('/admin/api/skills');
    const skills = res.skills || [];
    const savedNames = _loadJSON('skill_names') || {};

    if (!skills.length) {
      container.innerHTML = '<div class="empty-state">\u05dc\u05d0 \u05e0\u05de\u05e6\u05d0\u05d5 \u05db\u05d9\u05e9\u05d5\u05e8\u05d9\u05dd</div>';
      return;
    }

    container.innerHTML = skills.map(s => `
      <div class="settings-row">
        <span class="settings-label" style="direction:ltr;text-align:left">${esc(s.name)}</span>
        <input class="settings-input" data-skill-name="${esc(s.name)}" value="${esc(savedNames[s.name] || s.name)}" placeholder="${esc(s.name)}" />
      </div>
    `).join('');
  } catch {
    container.innerHTML = '<div class="empty-state">\u05e9\u05d2\u05d9\u05d0\u05d4 \u05d1\u05d8\u05e2\u05d9\u05e0\u05ea \u05db\u05d9\u05e9\u05d5\u05e8\u05d9\u05dd</div>';
  }
}

function _saveLogo() {
  const url = document.getElementById('sd-settings-logo-url')?.value?.trim();
  const text = document.getElementById('sd-settings-logo-text')?.value?.trim();

  if (url) {
    _saveJSON('logo', { type: 'url', value: url });
  } else if (text) {
    _saveJSON('logo', { type: 'text', value: text });
  } else {
    localStorage.removeItem(_settingsKey('logo'));
  }

  // Live-update sidebar logo
  const header = document.querySelector('.sidebar-header');
  if (header) {
    const logoText = header.querySelector('.logo-text');
    const projectName = logoText?.textContent || '';
    if (url) {
      header.innerHTML = `<img src="${esc(url)}" class="logo-img" alt=""><span class="logo-text">${esc(projectName)}</span>`;
    } else if (text) {
      header.innerHTML = `<span class="logo">${esc(text)}</span><span class="logo-text">${esc(projectName)}</span>`;
    } else {
      const fallback = _config?.projectName?.[0] || '?';
      header.innerHTML = `<span class="logo">${esc(fallback)}</span><span class="logo-text">${esc(projectName)}</span>`;
    }
  }

  _showToast('\u05DC\u05D5\u05D2\u05D5 \u05E2\u05D5\u05D3\u05DB\u05DF \u05D1\u05D4\u05E6\u05DC\u05D7\u05D4');
  _showHubSaveNotice();
}

function _saveProjectName() {
  const inp = document.getElementById('sd-settings-project-name');
  const val = inp?.value?.trim();
  if (!val) { _showToast('\u05d4\u05d6\u05df \u05e9\u05dd'); return; }

  _saveJSON('project_name', val);
  _config.projectName = val;

  // Live-update sidebar header
  const logoText = document.querySelector('.sidebar-header .logo-text');
  if (logoText) logoText.textContent = val;

  // Live-update page title
  document.title = val + ' \u2014 \u05dc\u05d5\u05d7 \u05d1\u05e7\u05e8\u05d4';

  // Save project icon
  const iconBtn = document.getElementById('sd-settings-project-icon');
  const icon = iconBtn?.textContent?.trim();
  if (icon) {
    _saveJSON('project_icon', icon);
    _config.logoText = icon;
    _syncSettingsToDb();

    // Live-update sidebar logo (replace img if present)
    const header = document.querySelector('.sidebar-header');
    const logoEl = header?.querySelector('.logo');
    const logoImg = header?.querySelector('.logo-img');
    if (logoEl) {
      logoEl.textContent = icon;
    } else if (logoImg && header) {
      const span = document.createElement('span');
      span.className = 'logo';
      span.textContent = icon;
      logoImg.replaceWith(span);
    }

    // Live-update project switcher chip (current project)
    const activeChip = document.querySelector('.switcher-chip.active .switcher-chip-logo');
    if (activeChip) activeChip.textContent = icon;

    // Push icon to Hub so it appears in Hub cards and other dashboards' switcher
    const hubUrl = _config?.hubUrl || 'http://localhost:3000';
    const projectId = _config?.projectId;
    if (projectId) {
      fetch(`${hubUrl}/api/project/${encodeURIComponent(projectId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logo: icon, name: val }),
      }).catch(() => { /* Hub may be offline */ });
    }
  }

  _showToast('\u05e9\u05dd \u05d5\u05d0\u05d9\u05d9\u05e7\u05d5\u05df \u05e2\u05d5\u05d3\u05db\u05e0\u05d5');
  _showHubSaveNotice();
}

function _saveBuiltinLabels() {
  const savedLabels = _loadJSON('tab_labels') || {};
  const savedIcons  = _loadJSON('tab_icons')  || {};
  _doSaveBuiltinLabels(savedLabels, savedIcons, false);
}

function _saveSharedLabels() {
  _showPasswordPrompt((ok) => {
    if (!ok) return;
    const savedLabels = _loadJSON('tab_labels') || {};
    const savedIcons  = _loadJSON('tab_icons')  || {};
    _doSaveBuiltinLabels(savedLabels, savedIcons, true);
  });
}

function _showPasswordPrompt(callback) {
  // Remove any existing prompt
  document.getElementById('sd-password-overlay')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'sd-password-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;justify-content:center;align-items:center;z-index:10000';
  overlay.innerHTML = `
    <div style="background:#1a1d27;border:1px solid #2e3250;border-radius:16px;padding:28px;min-width:320px;text-align:center;direction:rtl">
      <div style="font-size:1.3rem;margin-bottom:6px">\uD83D\uDD12</div>
      <h3 style="margin-bottom:6px;font-weight:700;font-size:1.05rem;color:#e2e8f0">\u05e9\u05d9\u05e0\u05d5\u05d9 \u05d8\u05d0\u05d1\u05d9\u05dd \u05de\u05e9\u05d5\u05ea\u05e4\u05d9\u05dd</h3>
      <p style="font-size:0.82rem;color:#718096;margin-bottom:16px">\u05d4\u05e9\u05d9\u05e0\u05d5\u05d9 \u05d9\u05e2\u05d3\u05db\u05df \u05d0\u05d5\u05d8\u05d5\u05de\u05d8\u05d9\u05ea \u05d1\u05db\u05dc \u05d4\u05d3\u05e9\u05d1\u05d5\u05e8\u05d3\u05d9\u05dd. \u05d4\u05db\u05e0\u05e1 \u05e1\u05d9\u05e1\u05de\u05d0:</p>
      <input type="password" id="sd-password-input" placeholder="\u05e1\u05d9\u05e1\u05de\u05d0" style="width:100%;padding:10px 14px;border:1px solid #2e3250;border-radius:10px;background:#0f1117;color:#e2e8f0;font-family:inherit;font-size:1rem;margin-bottom:16px;outline:none;text-align:center;letter-spacing:4px" />
      <div id="sd-password-error" style="color:#ef4444;font-size:0.82rem;margin-bottom:10px;display:none">\u05e1\u05d9\u05e1\u05de\u05d0 \u05e9\u05d2\u05d5\u05d9\u05d4</div>
      <div style="display:flex;gap:10px;justify-content:center">
        <button id="sd-password-ok" style="padding:8px 28px;border:none;border-radius:10px;font-family:inherit;font-size:0.88rem;font-weight:700;cursor:pointer;background:linear-gradient(135deg,#6366f1,#00d4ff);color:#fff">\u05d0\u05e9\u05e8</button>
        <button id="sd-password-cancel" style="padding:8px 28px;border:none;border-radius:10px;font-family:inherit;font-size:0.88rem;font-weight:600;cursor:pointer;background:#2e3250;color:#a0a0b8">\u05d1\u05d9\u05d8\u05d5\u05dc</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const inp = document.getElementById('sd-password-input');
  const errEl = document.getElementById('sd-password-error');
  inp.focus();

  function trySubmit() {
    if (inp.value === _SHARED_TAB_PASSWORD) {
      overlay.remove();
      callback(true);
    } else {
      errEl.style.display = 'block';
      inp.value = '';
      inp.focus();
    }
  }

  document.getElementById('sd-password-ok').addEventListener('click', trySubmit);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') trySubmit(); });
  document.getElementById('sd-password-cancel').addEventListener('click', () => {
    overlay.remove();
    callback(false);
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { overlay.remove(); callback(false); }
  });
}

function _doSaveBuiltinLabels(savedLabels, savedIcons, isSharedSave) {
  // Collect tab icon/label inputs — filter by shared vs project tabs
  document.querySelectorAll('.sd-tab-icon-input').forEach(inp => {
    const id = inp.dataset.tabId;
    const shared = _SHARED_SYSTEM_TABS.includes(id);
    if (isSharedSave && !shared) return; // shared save → only shared tabs
    if (!isSharedSave && shared) return; // project save → skip shared tabs
    const val = inp.value.trim();
    const page = _config?.pages?.find(p => p.id === id);
    const origIcon = page?._origIcon || '';
    if (val && val !== origIcon) savedIcons[id] = val; else delete savedIcons[id];
  });
  document.querySelectorAll('.sd-tab-label-input').forEach(inp => {
    const id = inp.dataset.tabId;
    const shared = _SHARED_SYSTEM_TABS.includes(id);
    if (isSharedSave && !shared) return;
    if (!isSharedSave && shared) return;
    const val = inp.value.trim();
    const page = _config?.pages?.find(p => p.id === id);
    const origLabel = page?._origLabel || '';
    if (val && val !== origLabel) savedLabels[id] = val; else delete savedLabels[id];
  });

  _saveJSON('tab_labels', savedLabels);
  _saveJSON('tab_icons',  savedIcons);

  // Force broadcast for shared tabs (bypass _dbAvailable check)
  if (isSharedSave) {
    _forcebroadcast();
  }
  _syncSettingsToDb();

  // Live-update all tabs
  (_config?.pages || []).forEach(page => {
    const id = page.id;
    const label = savedLabels[id] || page._origLabel || page.label;
    const icon  = savedIcons[id]  || page._origIcon  || page.icon;

    const navLabel = document.querySelector(`[data-tab="${id}"] .nav-label`);
    const navIcon  = document.querySelector(`[data-tab="${id}"] .nav-icon`);
    const pageTitle = document.querySelector(`#tab-${id} .page-title`);

    if (navLabel) navLabel.textContent = label;
    if (pageTitle) pageTitle.textContent = label;
    if (navIcon) navIcon.textContent = icon;

    page.label = label;
    page.title = label;
    page.icon = icon;
  });

  _showToast(isSharedSave
    ? '\u05e9\u05de\u05d5\u05ea \u05e2\u05d5\u05d3\u05db\u05e0\u05d5 \u05d5\u05de\u05e1\u05ea\u05e0\u05db\u05e8\u05e0\u05d9\u05dd \u05dc\u05db\u05dc \u05d4\u05d3\u05e9\u05d1\u05d5\u05e8\u05d3\u05d9\u05dd'
    : '\u05e9\u05de\u05d5\u05ea \u05d5\u05d0\u05d9\u05d9\u05e7\u05d5\u05e0\u05d9\u05dd \u05e2\u05d5\u05d3\u05db\u05e0\u05d5 \u05d1\u05d4\u05e6\u05dc\u05d7\u05d4');
  _showHubSaveNotice();
}

// Direct broadcast — does NOT depend on _dbAvailable
function _forcebroadcast() {
  const currentPort = parseInt(location.port, 10);
  if (currentPort === 3000) return;
  const hubUrl = _config?.hubUrl || 'http://localhost:3000';
  const allSettings = _collectAllSettings();
  // Save to project DB directly first
  fetch('/admin/api/dashboard-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(allSettings),
  }).catch(() => {});
  // Then broadcast to Hub
  fetch(hubUrl + '/api/broadcast-settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: allSettings, senderPort: currentPort }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}

function _saveSkillNames() {
  const inputs = document.querySelectorAll('#sd-settings-skills-list [data-skill-name]');
  const names = {};
  inputs.forEach(inp => {
    const key = inp.dataset.skillName;
    const val = inp.value.trim();
    if (val && val !== key) names[key] = val;
  });

  _saveJSON('skill_names', names);
  _forcebroadcast();
  _showToast('\u05E9\u05DE\u05D5\u05EA \u05DB\u05D9\u05E9\u05D5\u05E8\u05D9\u05DD \u05E2\u05D5\u05D3\u05DB\u05E0\u05D5 \u05D1\u05D4\u05E6\u05DC\u05D7\u05D4');
  _showHubSaveNotice();
}

function _loadSettingsFooter() {
  const container = document.getElementById('sd-settings-footer-list');
  if (!container) return;
  const links = _config?.footerLinks || [];
  const savedLabels = _loadJSON('footer_labels') || {};

  if (!links.length) {
    container.innerHTML = '<div class="empty-state">\u05d0\u05d9\u05df \u05e7\u05d9\u05e9\u05d5\u05e8\u05d9 \u05ea\u05d7\u05ea\u05d9\u05ea</div>';
    return;
  }

  container.innerHTML = links.map((f, i) => {
    const origLabel = f._origLabel || f.label;
    const curLabel = savedLabels[i] || origLabel;
    return `
      <div class="settings-row">
        <span class="settings-label">${esc(origLabel)}</span>
        <input class="settings-input" data-footer-idx="${i}" value="${esc(curLabel)}" placeholder="${esc(origLabel)}" />
      </div>`;
  }).join('');
}

function _saveFooterLabels() {
  const inputs = document.querySelectorAll('#sd-settings-footer-list [data-footer-idx]');
  const labels = {};
  inputs.forEach(inp => {
    const idx = parseInt(inp.dataset.footerIdx);
    const val = inp.value.trim();
    const origLabel = (_config?.footerLinks?.[idx])?._origLabel || (_config?.footerLinks?.[idx])?.label;
    if (val && val !== origLabel) labels[idx] = val;
  });

  _saveJSON('footer_labels', labels);

  // Live-update footer
  const footer = document.getElementById('sd-sidebar-footer');
  if (footer) {
    const btns = footer.querySelectorAll('.footer-link, .footer-btn');
    (_config?.footerLinks || []).forEach((f, i) => {
      if (labels[i] && btns[i]) {
        const icon = f.icon ? f.icon + ' ' : '';
        btns[i].innerHTML = icon + esc(labels[i]);
        f.label = labels[i];
      }
    });
  }

  _showToast('\u05E9\u05DE\u05D5\u05EA \u05E7\u05D9\u05E9\u05D5\u05E8\u05D9\u05DD \u05E2\u05D5\u05D3\u05DB\u05E0\u05D5');
  _showHubSaveNotice();
}

function _applyZoom(pct) {
  const content = document.querySelector('.tab-content');
  const sidebar = document.getElementById('sd-sidebar');
  if (content) content.style.zoom = (pct / 100);
  if (sidebar) sidebar.style.zoom = (pct / 100);
}

function _saveFontSize() {
  const slider = document.getElementById('sd-settings-font-size');
  if (!slider) return;
  const pct = parseInt(slider.value);
  _saveJSON('font_size', pct);
  _applyZoom(pct);
  _showToast('\u05D2\u05D5\u05D3\u05DC \u05E4\u05D5\u05E0\u05D8 \u05E2\u05D5\u05D3\u05DB\u05DF');
  _showHubSaveNotice();
}

function _resetFontSize() {
  localStorage.removeItem(_settingsKey('font_size'));
  _applyZoom(100);
  const slider = document.getElementById('sd-settings-font-size');
  const fontValue = document.getElementById('sd-settings-font-size-value');
  if (slider) slider.value = 100;
  if (fontValue) fontValue.textContent = '100%';
  _showToast('\u05D2\u05D5\u05D3\u05DC \u05E4\u05D5\u05E0\u05D8 \u05D0\u05D5\u05E4\u05E1');
}

function _resetAll() {
  const prefix = _prefix();
  ['settings_project_name', 'settings_logo', 'settings_tab_labels', 'settings_skill_names', 'settings_hidden_tabs', 'settings_tab_groups', 'settings_tab_groups_collapsed', 'settings_footer_labels', 'settings_font_size', 'settings_stat_labels', 'settings_table_headers'].forEach(k => {
    localStorage.removeItem(prefix + k);
  });
  localStorage.removeItem(prefix + 'nav_order');
  _applyZoom(100);
  if (_dbAvailable) {
    api('/admin/api/dashboard-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(() => {});
  }
  location.reload();
}

// ─── Thread viewer ───

window.__sd_openThread__ = async function(userId, userName) {
  const overlay = document.getElementById('sd-thread-overlay');
  const title = document.getElementById('sd-thread-title');
  const body = document.getElementById('sd-thread-body');
  if (!overlay || !body) return;

  title.textContent = userName || userId;
  body.innerHTML = '<div class="empty-state">\u05d8\u05d5\u05e2\u05df...</div>';
  overlay.classList.remove('hidden');

  try {
    const res = await api('/admin/api/conversations/' + encodeURIComponent(userId));
    const msgs = (res.history || []).flatMap(h => [
      { role: 'user', text: h.user_message, time: h.created_at },
      { role: 'assistant', text: h.assistant_message, time: h.created_at },
    ]).filter(m => m.text);

    body.innerHTML = msgs.length
      ? msgs.map(m => `
        <div class="msg ${m.role}">
          ${esc(m.text)}
          <div class="time">${formatTime(m.time)}</div>
        </div>`).join('')
      : '<div class="empty-state">\u05d0\u05d9\u05df \u05d4\u05d5\u05d3\u05e2\u05d5\u05ea</div>';
  } catch {
    body.innerHTML = '<div class="empty-state">\u05e9\u05d2\u05d9\u05d0\u05d4 \u05d1\u05d8\u05e2\u05d9\u05e0\u05d4</div>';
  }
};

function closeThread() {
  document.getElementById('sd-thread-overlay')?.classList.add('hidden');
}

// Wire close button & overlay click
document.addEventListener('click', (e) => {
  if (e.target.id === 'sd-thread-close') closeThread();
  if (e.target.id === 'sd-thread-overlay') closeThread();
});

// ─── Sidebar collapse ───

function _toggleSidebar() {
  const collapsed = document.body.classList.toggle('sidebar-collapsed');
  if (collapsed) _saveJSON('sidebar_collapsed', true);
  else localStorage.removeItem(_settingsKey('sidebar_collapsed'));
}

// ─── Integrations Modal ───

function _buildIntegrationsModal() {
  return `
    <div class="modal-overlay hidden" id="sd-integrations-overlay">
      <div class="modal-box" style="max-width:740px">
        <div class="modal-header">
          <span style="font-size:1.3rem">🔌</span>
          <h3>אינטגרציות חיצוניות</h3>
          <button class="modal-close" id="sd-integrations-close">&times;</button>
        </div>
        <div class="modal-body" id="sd-integrations-body">
          <div class="empty-state">טוען...</div>
        </div>
      </div>
    </div>`;
}

async function _openIntegrationsModal() {
  if (document.querySelector('.tab-rename-input')) return;
  const overlay = document.getElementById('sd-integrations-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  const body = document.getElementById('sd-integrations-body');
  body.innerHTML = '<div class="empty-state">טוען...</div>';
  try {
    const data = await api('/admin/api/integrations');
    if (!data.ok || !data.integrations?.length) {
      body.innerHTML = '<div class="empty-state">אין אינטגרציות מוגדרות ב-.env</div>';
      return;
    }
    body.innerHTML = _renderIntegrations(data.integrations);
  } catch {
    body.innerHTML = '<div class="empty-state" style="color:#f44">שגיאה בטעינה</div>';
  }
}

function _renderIntegrations(integrations) {
  const STATUS = {
    configured:  { label: 'מוגדר',  color: '#22c55e' },
    active:      { label: 'פעיל',   color: '#22c55e' },
    partial:     { label: 'חלקי',   color: '#f59e0b' },
    disabled:    { label: 'מושבת',  color: '#718096' },
    'test-mode': { label: 'בדיקה',  color: '#6366f1' },
  };
  return `<div class="int-grid">${integrations.map((i, idx) => {
    const s = STATUS[i.status] || { label: i.status, color: '#718096' };
    const details = Object.entries(i.details || {})
      .filter(([, v]) => v !== null && v !== undefined && v !== false)
      .map(([k, v]) => `<div class="int-detail-row">
        <span class="int-detail-key">${esc(k)}</span>
        <span class="int-detail-val">${esc(Array.isArray(v) ? v.join(', ') : String(v))}</span>
      </div>`).join('');
    const canDelete = i.status === 'disabled' && i.deleteUrl;
    return `<div class="int-card" data-int-idx="${idx}">
      <div class="int-card-header">
        <span class="int-icon">${i.icon}</span>
        <div class="int-meta">
          <span class="int-name">${esc(i.name)}</span>
          <span class="int-provider">${esc(i.provider)}</span>
        </div>
        <span class="int-badge" style="background:${s.color}20;color:${s.color}">${s.label}</span>
        ${canDelete ? `<button class="int-delete-btn" data-delete-url="${esc(i.deleteUrl)}" title="מחק">🗑️</button>` : ''}
      </div>
      ${details ? `<div class="int-details">${details}</div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

document.addEventListener('click', async (e) => {
  if (e.target.id === 'sd-integrations-close' || e.target.id === 'sd-integrations-overlay') {
    document.getElementById('sd-integrations-overlay')?.classList.add('hidden');
    return;
  }
  const delBtn = e.target.closest('.int-delete-btn');
  if (!delBtn) return;
  const card = delBtn.closest('.int-card');
  const url = delBtn.dataset.deleteUrl;
  if (!url || !card) return;
  delBtn.disabled = true;
  delBtn.textContent = '⏳';
  try {
    const res = await fetch(url, { method: 'DELETE', headers: authHeaders() });
    if (res.ok) {
      card.style.transition = 'opacity 0.3s';
      card.style.opacity = '0';
      setTimeout(() => card.remove(), 300);
    } else {
      delBtn.textContent = '❌';
      delBtn.disabled = false;
    }
  } catch {
    delBtn.textContent = '❌';
    delBtn.disabled = false;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.getElementById('sd-integrations-overlay')?.classList.add('hidden');
  }
});

// ─── Skill toggle ───

window.__sd_toggleSkill__ = async function(name, enabled) {
  try {
    const res = await fetch('/admin/api/skills/' + encodeURIComponent(name), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ enabled }),
    });
    if (res.status === 401) { showLoginScreen(); return; }
  } catch {
    alert('\u05e9\u05d2\u05d9\u05d0\u05d4 \u05d1\u05e2\u05d3\u05db\u05d5\u05df \u05db\u05d9\u05e9\u05d5\u05e8');
  }
};










