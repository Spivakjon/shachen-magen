// Admin tab — Alerts history + live Pikud HaOref status
let pollInterval = null;

export function render(container) {
  container.innerHTML = `
    <div class="stat-grid" id="alert-stats"></div>

    <!-- Live alert status -->
    <div id="live-alert-box" style="margin-bottom:20px;"></div>

    <!-- Drill / Test panel -->
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:20px;margin-bottom:24px;">
      <h4 style="margin:0 0 14px;display:flex;align-items:center;gap:8px;">🎯 תרגול אזעקה</h4>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">שלח אזעקת תרגול כדי לבדוק את המערכת. זה יפעיל Push למארחים, יפתח ממ"דים אוטומטיים, ויציג אזעקה באפליקציה.</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
        <div>
          <label style="font-size:13px;color:var(--text-muted);display:block;margin-bottom:4px;">ערים</label>
          <input type="text" id="drill-cities" value="תל מונד" style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-card);color:var(--text);font-family:Heebo,sans-serif;font-size:14px;">
        </div>
        <div>
          <label style="font-size:13px;color:var(--text-muted);display:block;margin-bottom:4px;">זמן מקלט (שניות)</label>
          <select id="drill-time" style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-card);color:var(--text);font-size:14px;">
            <option value="15">15 שניות (מיידי)</option>
            <option value="30">30 שניות</option>
            <option value="60">60 שניות</option>
            <option value="90" selected>90 שניות (ברירת מחדל)</option>
          </select>
        </div>
      </div>
      <div style="display:flex;gap:10px;">
        <button id="btn-drill" style="flex:1;padding:12px;border-radius:10px;border:none;background:linear-gradient(135deg,#dc2626,#991b1b);color:#fff;cursor:pointer;font-family:Heebo,sans-serif;font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:8px;">
          🚨 הפעל תרגול
        </button>
        <button id="btn-stop-drill" style="padding:12px 20px;border-radius:10px;border:1px solid var(--border);background:var(--bg-card);color:var(--text);cursor:pointer;font-family:Heebo,sans-serif;font-size:14px;">
          ⏹️ עצור
        </button>
        <button id="btn-refresh" style="padding:12px 20px;border-radius:10px;border:1px solid var(--border);background:var(--bg-card);color:var(--text);cursor:pointer;font-family:Heebo,sans-serif;font-size:14px;">
          🔄
        </button>
      </div>
    </div>

    <h3 style="margin-bottom:16px;">היסטוריית אזעקות</h3>
    <div id="alerts-list"></div>
  `;
}

export async function onActivate() {
  document.getElementById('btn-drill')?.addEventListener('click', sendDrillAlert);
  document.getElementById('btn-stop-drill')?.addEventListener('click', stopDrillAlert);
  document.getElementById('btn-refresh')?.addEventListener('click', loadAll);

  await loadAll();
  // Poll live status every 5 seconds
  pollInterval = setInterval(checkLiveAlert, 5000);
}

export function onDeactivate() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

async function loadAll() {
  await Promise.all([loadAlertHistory(), checkLiveAlert()]);
}

async function checkLiveAlert() {
  try {
    const res = await fetch('/api/alerts/active');
    const data = await res.json();
    const box = document.getElementById('live-alert-box');
    if (!box) return;

    if (data.alert) {
      box.innerHTML = `
        <div style="background:linear-gradient(135deg,#dc2626,#991b1b);border-radius:14px;padding:16px;display:flex;align-items:center;gap:14px;animation:pulse 2s ease-in-out infinite;">
          <div style="width:44px;height:44px;background:rgba(255,255,255,0.2);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;">🚨</div>
          <div style="flex:1;">
            <div style="font-weight:700;color:#fff;font-size:16px;">אזעקה פעילה!</div>
            <div style="font-size:14px;color:rgba(255,255,255,0.8);">${esc(data.alert.cities)} — ${typeLabel(data.alert.alert_type)}</div>
            <div style="font-size:12px;color:rgba(255,255,255,0.6);margin-top:4px;">החלה: ${new Date(data.alert.started_at).toLocaleString('he-IL')}</div>
          </div>
        </div>
        <style>@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.85}}</style>
      `;
    } else {
      box.innerHTML = `
        <div style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:14px;padding:16px;display:flex;align-items:center;gap:14px;">
          <div style="width:44px;height:44px;background:rgba(34,197,94,0.15);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;">✅</div>
          <div>
            <div style="font-weight:600;color:#34d399;font-size:15px;">אין אזעקות פעילות</div>
            <div style="font-size:13px;color:var(--text-muted);">הפולר סורק את פיקוד העורף כל 3 שניות</div>
          </div>
        </div>
      `;
    }
  } catch { /* silent */ }
}

async function loadAlertHistory() {
  try {
    const res = await fetch('/api/alerts/history', {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('sd_auth_token') || ''}` }
    });
    const data = await res.json();
    const alerts = data.alerts || [];

    const total = alerts.length;
    const thisMonth = alerts.filter(a => {
      const d = new Date(a.started_at);
      const now = new Date();
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length;
    const active = alerts.filter(a => !a.ended_at).length;

    document.getElementById('alert-stats').innerHTML = `
      <div class="stat-card"><div class="value" style="color:#f87171">${total}</div><div class="label">סה"כ אזעקות</div></div>
      <div class="stat-card"><div class="value" style="color:#fbbf24">${thisMonth}</div><div class="label">החודש</div></div>
      <div class="stat-card"><div class="value" style="color:${active ? '#f87171' : '#34d399'}">${active}</div><div class="label">פעילות עכשיו</div></div>
    `;

    const list = document.getElementById('alerts-list');
    if (alerts.length === 0) {
      list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px;">אין אזעקות בהיסטוריה</p>';
      return;
    }

    list.innerHTML = `
      <table style="width:100%;border-collapse:collapse;">
        <thead><tr style="border-bottom:1px solid var(--border);text-align:right;">
          <th style="padding:10px;">תאריך</th>
          <th style="padding:10px;">סוג</th>
          <th style="padding:10px;">ערים</th>
          <th style="padding:10px;">זמן מקלט</th>
          <th style="padding:10px;">סטטוס</th>
        </tr></thead>
        <tbody>${alerts.map(a => `
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:10px;">${new Date(a.started_at).toLocaleString('he-IL')}</td>
            <td style="padding:10px;"><span class="badge badge-alert">${typeLabel(a.alert_type)}</span></td>
            <td style="padding:10px;">${esc(a.cities)}</td>
            <td style="padding:10px;">${a.time_to_shelter} שניות</td>
            <td style="padding:10px;">${a.ended_at
              ? `<span style="color:#34d399;">הסתיים ${new Date(a.ended_at).toLocaleTimeString('he-IL')}</span>`
              : '<span style="color:#f87171;font-weight:600;">פעיל</span>'
            }</td>
          </tr>
        `).join('')}</tbody>
      </table>
    `;
  } catch (err) {
    console.error('Failed to load alerts:', err);
  }
}

async function sendDrillAlert() {
  const cities = document.getElementById('drill-cities')?.value || 'תל מונד';
  const timeToShelter = parseInt(document.getElementById('drill-time')?.value) || 90;

  if (!confirm(`להפעיל תרגול אזעקה?\n\nערים: ${cities}\nזמן מקלט: ${timeToShelter} שניות\n\nזה יפעיל Push למארחים ויציג אזעקה באפליקציה.`)) return;

  try {
    const res = await fetch('/api/alerts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cities, type: 1, timeToShelter }),
    });
    const data = await res.json();
    if (data.success) await loadAll();
  } catch (err) {
    console.error('Drill alert failed:', err);
  }
}

async function stopDrillAlert() {
  try {
    const res = await fetch('/api/alerts/stop', { method: 'POST' });
    const data = await res.json();
    if (data.success) await loadAll();
  } catch (err) {
    console.error('Stop alert failed:', err);
  }
}

function typeLabel(type) {
  const map = { missiles: 'רקטות וטילים', earthquake: 'רעידת אדמה', tsunami: 'צונאמי', hostile_aircraft: 'חדירת כלי טיס', radiological: 'רדיולוגי' };
  return map[type] || type || 'לא ידוע';
}

function esc(s) { return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''; }
