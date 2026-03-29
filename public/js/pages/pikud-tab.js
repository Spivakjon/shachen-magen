// Admin tab — Pikud HaOref API integration info
export function render(container) {
  container.innerHTML = `
    <div class="stat-grid" id="pk-stats"></div>
    <div id="pk-content" style="color:var(--text-muted);text-align:center;padding:40px;">טוען...</div>
  `;
}

export async function onActivate() {
  try {
    const d = await (await fetch('/api/alerts/pikud-info')).json();
    const cities = d.monitoredCities || [];
    const cats = d.categoryMap || {};

    document.getElementById('pk-stats').innerHTML = `
      <div class="stat-card"><div class="value" style="color:#34d399">${cities.length}</div><div class="label">ערים מנוטרות</div></div>
      <div class="stat-card"><div class="value" style="color:#60a5fa">${d.api.pollInterval}</div><div class="label">תדירות סריקה</div></div>
      <div class="stat-card"><div class="value" style="color:#fbbf24">${Object.keys(cats).length}</div><div class="label">סוגי התרעות</div></div>
    `;

    document.getElementById('pk-content').innerHTML = `
      <!-- API connection -->
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:20px;margin-bottom:16px;text-align:right;">
        <h4 style="margin:0 0 14px;">🔗 חיבור API</h4>
        <div style="display:flex;flex-direction:column;gap:8px;font-size:13px;">
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
            <span style="color:var(--text-muted);">URL ראשי</span>
            <code style="color:#60a5fa;font-size:12px;direction:ltr;">${esc(d.api.url)}</code>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
            <span style="color:var(--text-muted);">URL גיבוי</span>
            <code style="color:#60a5fa;font-size:12px;direction:ltr;">${esc(d.api.fallback)}</code>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
            <span style="color:var(--text-muted);">תדירות סריקה</span>
            <span>כל ${d.api.pollInterval}</span>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;">
            <span style="color:var(--text-muted);">סטטוס</span>
            <span style="color:#34d399;font-weight:600;">● ${d.status}</span>
          </div>
        </div>
      </div>

      <!-- Monitored cities -->
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:20px;margin-bottom:16px;text-align:right;">
        <h4 style="margin:0 0 14px;">🏙️ ערים מנוטרות</h4>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          ${cities.map(c => `<span style="background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.2);color:#34d399;padding:6px 14px;border-radius:10px;font-size:14px;">${esc(c)}</span>`).join('')}
        </div>
        <p style="font-size:12px;color:var(--text-muted);margin-top:12px;">להוספת ערים: עדכן <code>MONITORED_CITIES</code> ב-.env (מופרדות בפסיקים)</p>
      </div>

      <!-- Alert types -->
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:20px;margin-bottom:16px;text-align:right;">
        <h4 style="margin:0 0 14px;">🚨 סוגי התרעות</h4>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead><tr style="border-bottom:1px solid var(--border);text-align:right;">
            <th style="padding:8px;">קוד</th><th style="padding:8px;">סוג</th><th style="padding:8px;">זמן מקלט</th>
          </tr></thead>
          <tbody>
            ${Object.entries(cats).map(([k, v]) => `<tr style="border-bottom:1px solid var(--border);"><td style="padding:8px;color:#60a5fa;">${k}</td><td style="padding:8px;">${esc(v)}</td><td style="padding:8px;color:var(--text-muted);">15-90 שניות</td></tr>`).join('')}
          </tbody>
        </table>
      </div>

      <!-- Time to shelter -->
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:20px;margin-bottom:16px;text-align:right;">
        <h4 style="margin:0 0 14px;">⏱️ זמן מקלט לפי אזור</h4>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          ${Object.entries(d.timeToShelter?.examples || {}).map(([city, sec]) =>
            `<div style="background:var(--bg-primary,var(--bg-hover,#1e2130));padding:10px;border-radius:8px;display:flex;justify-content:space-between;">
              <span>${esc(city)}</span><span style="font-weight:700;color:${sec <= 15 ? '#f87171' : sec <= 30 ? '#fbbf24' : '#34d399'};">${sec} שנ׳</span>
            </div>`).join('')}
        </div>
      </div>

      <!-- Response format -->
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:14px;padding:20px;text-align:right;">
        <h4 style="margin:0 0 14px;">📋 פורמט תגובה מה-API</h4>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px;">${esc(d.responseFormat?.description || '')}</p>
        <div style="background:#0d0d15;border-radius:8px;padding:12px;overflow-x:auto;">
          <pre style="color:#60a5fa;font-size:12px;direction:ltr;text-align:left;margin:0;white-space:pre-wrap;">${JSON.stringify(d.responseFormat?.example, null, 2)}</pre>
        </div>
        <div style="margin-top:14px;font-size:13px;">
          <strong>שדות:</strong>
          <table style="width:100%;border-collapse:collapse;margin-top:8px;">
            ${Object.entries(d.responseFormat?.fields || {}).map(([k, v]) =>
              `<tr style="border-bottom:1px solid var(--border);"><td style="padding:6px;color:#a78bfa;font-family:monospace;">${k}</td><td style="padding:6px;color:var(--text-muted);">${esc(v)}</td></tr>`).join('')}
          </table>
        </div>
        <p style="font-size:12px;color:var(--text-muted);margin-top:12px;">💡 פיקוד העורף לא מספק API היסטוריה — כל ההתרעות שנתפסות נשמרות ב-DB המקומי.</p>
      </div>
    `;
  } catch (err) {
    document.getElementById('pk-content').innerHTML = `<p style="color:#f87171;">שגיאה בטעינה: ${err.message}</p>`;
  }
}

function esc(s) { return s ? String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : ''; }
