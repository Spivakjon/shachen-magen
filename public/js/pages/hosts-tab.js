// Admin tab — Hosts management
export function render(container) {
  container.innerHTML = `
    <h3 style="margin-bottom:16px;">ניהול מארחים</h3>
    <div style="margin-bottom:16px;">
      <select id="host-filter" style="padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-card);color:var(--text);font-size:14px;">
        <option value="">כל המארחים</option>
        <option value="approved">מאושרים</option>
        <option value="pending">ממתינים לאישור</option>
        <option value="blocked">חסומים</option>
      </select>
    </div>
    <div id="hosts-list"></div>
  `;
}

export async function onActivate() {
  document.getElementById('host-filter')?.addEventListener('change', () => renderList());
  await loadHosts();
}

let allHosts = [];

async function loadHosts() {
  try {
    const res = await fetch('/api/admin/hosts', {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('sd_auth_token') || ''}` }
    });
    const data = await res.json();
    allHosts = data.hosts || [];
    renderList();
  } catch (err) {
    console.error('Failed to load hosts:', err);
  }
}

function renderList() {
  const filter = document.getElementById('host-filter')?.value || '';
  let filtered = allHosts;
  if (filter === 'approved') filtered = filtered.filter(h => h.is_approved);
  else if (filter === 'pending') filtered = filtered.filter(h => !h.is_approved && !h.blocked);
  else if (filter === 'blocked') filtered = filtered.filter(h => !h.is_approved);

  if (filtered.length === 0) {
    document.getElementById('hosts-list').innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px;">אין מארחים להצגה</p>';
    return;
  }

  document.getElementById('hosts-list').innerHTML = filtered.map(h => `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:16px;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:14px;">
        <div style="width:44px;height:44px;border-radius:12px;background:${h.is_approved ? 'linear-gradient(135deg,#22c55e,#16a34a)' : '#4b5563'};display:flex;align-items:center;justify-content:center;color:#fff;font-size:18px;font-weight:700;">
          ${(h.name || '?')[0]}
        </div>
        <div>
          <div style="font-weight:600;">${esc(h.name)}</div>
          <div style="font-size:13px;color:var(--text-muted);">${esc(h.phone)} · ${esc(h.address)}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">
            נרשם: ${new Date(h.created_at).toLocaleDateString('he-IL')} ·
            מצב: ${h.status === 'always_open' ? 'פתוח תמיד' : h.status === 'manual' ? 'ידני' : 'לא זמין'}
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px;">
        ${h.is_approved
          ? `<button onclick="window._hostAction(${h._id},'block')" style="padding:6px 14px;border-radius:8px;border:1px solid #ef4444;background:transparent;color:#f87171;cursor:pointer;font-size:13px;">חסום</button>`
          : `<button onclick="window._hostAction(${h._id},'approve')" style="padding:6px 14px;border-radius:8px;border:1px solid #22c55e;background:transparent;color:#34d399;cursor:pointer;font-size:13px;">אשר</button>`
        }
      </div>
    </div>
  `).join('');
}

window._hostAction = async (id, action) => {
  await fetch(`/api/admin/hosts/${id}/${action}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${localStorage.getItem('sd_auth_token') || ''}` }
  });
  await loadHosts();
};

function esc(s) { return s ? String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') : ''; }
