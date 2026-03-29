// Admin tab — Statistics
export function render(container) {
  container.innerHTML = `
    <h3 style="margin-bottom:20px;">סטטיסטיקות שימוש</h3>
    <div class="stat-grid" id="stats-overview"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:20px;" id="stats-panels">
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:20px;">
        <h4 style="margin:0 0 16px;">פעילויות אחרונות</h4>
        <div id="recent-activations"></div>
      </div>
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:20px;">
        <h4 style="margin:0 0 16px;">אירועי מחפשים</h4>
        <div id="recent-events"></div>
      </div>
    </div>
  `;
}

export async function onActivate() {
  try {
    const res = await fetch('/api/admin/stats', {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('sd_auth_token') || ''}` }
    });
    const s = await res.json();

    document.getElementById('stats-overview').innerHTML = `
      <div class="stat-card"><div class="value" style="color:#34d399">${s.totalHosts || 0}</div><div class="label">ממ"דים רשומים</div></div>
      <div class="stat-card"><div class="value" style="color:#60a5fa">${s.activeHosts || 0}</div><div class="label">פעילים עכשיו</div></div>
      <div class="stat-card"><div class="value" style="color:#f87171">${s.totalAlerts || 0}</div><div class="label">אזעקות</div></div>
      <div class="stat-card"><div class="value" style="color:#a78bfa">${s.totalActivations || 0}</div><div class="label">פתיחות ממ"ד</div></div>
      <div class="stat-card"><div class="value" style="color:#fbbf24">${s.totalSeekerEvents || 0}</div><div class="label">שימושי מחפשים</div></div>
    `;

    // Load recent activations
    const actRes = await fetch('/api/admin/recent-activations', {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('sd_auth_token') || ''}` }
    });
    const actData = await actRes.json();
    const activations = actData.activations || [];

    document.getElementById('recent-activations').innerHTML = activations.length === 0
      ? '<p style="color:var(--text-muted);font-size:14px;">אין פעילויות עדיין</p>'
      : activations.map(a => `
        <div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:14px;">
          <strong>${esc(a.host_name)}</strong> — ${a.activation_type === 'auto' ? 'אוטומטי' : 'ידני'}
          <div style="font-size:12px;color:var(--text-muted);">${new Date(a.activated_at).toLocaleString('he-IL')}</div>
        </div>
      `).join('');

    // Load recent seeker events
    const evRes = await fetch('/api/admin/recent-events', {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('sd_auth_token') || ''}` }
    });
    const evData = await evRes.json();
    const events = evData.events || [];

    document.getElementById('recent-events').innerHTML = events.length === 0
      ? '<p style="color:var(--text-muted);font-size:14px;">אין אירועים עדיין</p>'
      : events.map(e => `
        <div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:14px;">
          ${eventLabel(e.event_type)} — ${esc(e.host_name || 'לא ידוע')}
          <div style="font-size:12px;color:var(--text-muted);">${new Date(e.created_at).toLocaleString('he-IL')}</div>
        </div>
      `).join('');

  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

function eventLabel(type) {
  const map = { view: 'צפייה', navigate: 'ניווט', on_my_way: 'בדרך', arrived: 'הגיע' };
  return map[type] || type;
}

function esc(s) { return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''; }
