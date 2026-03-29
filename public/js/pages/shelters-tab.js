// Admin tab — Shelters management
const API = '/api/admin';

export function render(container) {
  container.innerHTML = `
    <div class="stat-grid" id="shelter-stats"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3 style="margin:0;">ממ"דים רשומים</h3>
      <div style="display:flex;gap:8px;">
        <input type="text" id="shelter-search" placeholder="חיפוש..." style="padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-card);color:var(--text);font-size:14px;">
        <select id="shelter-filter" style="padding:8px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-card);color:var(--text);font-size:14px;">
          <option value="">הכל</option>
          <option value="active">פעילים עכשיו</option>
          <option value="always_open">פתוח תמיד</option>
          <option value="manual">ידני</option>
          <option value="unavailable">לא זמין</option>
        </select>
      </div>
    </div>
    <div id="shelter-table"></div>
  `;
}

export async function onActivate() {
  await loadData();

  document.getElementById('shelter-search')?.addEventListener('input', () => renderTable());
  document.getElementById('shelter-filter')?.addEventListener('change', () => renderTable());
}

let allShelters = [];

async function loadData() {
  try {
    const res = await fetch(`${API}/hosts`, { headers: authHeaders() });
    const data = await res.json();
    allShelters = data.hosts || [];
    renderStats();
    renderTable();
  } catch (err) {
    console.error('Failed to load shelters:', err);
  }
}

function renderStats() {
  const total = allShelters.length;
  const active = allShelters.filter(h => h.is_active).length;
  const alwaysOpen = allShelters.filter(h => h.status === 'always_open').length;
  const totalCapacity = allShelters.reduce((sum, h) => sum + (h.capacity || 0), 0);

  document.getElementById('shelter-stats').innerHTML = `
    <div class="stat-card"><div class="value">${total}</div><div class="label">ממ"דים רשומים</div></div>
    <div class="stat-card"><div class="value" style="color:#34d399">${active}</div><div class="label">פעילים עכשיו</div></div>
    <div class="stat-card"><div class="value" style="color:#60a5fa">${alwaysOpen}</div><div class="label">פתוח תמיד</div></div>
    <div class="stat-card"><div class="value" style="color:#a78bfa">${totalCapacity}</div><div class="label">קיבולת כוללת</div></div>
  `;
}

function renderTable() {
  const search = (document.getElementById('shelter-search')?.value || '').toLowerCase();
  const filter = document.getElementById('shelter-filter')?.value || '';

  let filtered = allShelters;
  if (search) {
    filtered = filtered.filter(h =>
      h.name?.toLowerCase().includes(search) ||
      h.address?.toLowerCase().includes(search) ||
      h.phone?.includes(search)
    );
  }
  if (filter === 'active') filtered = filtered.filter(h => h.is_active);
  else if (filter) filtered = filtered.filter(h => h.status === filter);

  const statusLabel = (h) => {
    if (h.is_active) return '<span class="badge badge-open">פתוח</span>';
    if (h.status === 'always_open') return '<span class="badge badge-open">פתוח תמיד</span>';
    if (h.status === 'unavailable') return '<span class="badge badge-closed">לא זמין</span>';
    return '<span class="badge badge-closed">ידני</span>';
  };

  document.getElementById('shelter-table').innerHTML = filtered.length === 0
    ? '<p style="color:var(--text-muted);text-align:center;padding:40px;">אין ממ"דים להצגה</p>'
    : `<table style="width:100%;border-collapse:collapse;">
        <thead><tr style="border-bottom:1px solid var(--border);text-align:right;">
          <th style="padding:10px;">שם</th>
          <th style="padding:10px;">כתובת</th>
          <th style="padding:10px;">טלפון</th>
          <th style="padding:10px;">קומה</th>
          <th style="padding:10px;">קיבולת</th>
          <th style="padding:10px;">סטטוס</th>
          <th style="padding:10px;">פעולות</th>
        </tr></thead>
        <tbody>${filtered.map(h => `
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:10px;">${esc(h.name)}</td>
            <td style="padding:10px;">${esc(h.address)}</td>
            <td style="padding:10px;direction:ltr;text-align:right;">${esc(h.phone)}</td>
            <td style="padding:10px;">${h.floor}</td>
            <td style="padding:10px;">${h.capacity}</td>
            <td style="padding:10px;">${statusLabel(h)}</td>
            <td style="padding:10px;">
              <button onclick="window._toggleApproval(${h._id})" style="padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:var(--bg-card);color:var(--text);cursor:pointer;font-size:12px;">
                ${h.is_approved ? 'חסום' : 'אשר'}
              </button>
            </td>
          </tr>
        `).join('')}</tbody>
      </table>`;
}

window._toggleApproval = async (id) => {
  const host = allShelters.find(h => h._id === id);
  if (!host) return;
  const action = host.is_approved ? 'block' : 'approve';
  await fetch(`${API}/hosts/${id}/${action}`, { method: 'PUT', headers: authHeaders() });
  await loadData();
};

function authHeaders() {
  const token = localStorage.getItem('sd_auth_token');
  return { 'Authorization': token ? `Bearer ${token}` : '', 'Content-Type': 'application/json' };
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
