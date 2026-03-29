// Admin tab — Live map (Leaflet, same pattern as אלקטרו-נתך)
let _map = null;
let _markers = [];
let _refreshInterval = null;
let _leafletLoaded = false;

export function render(container) {
  container.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <h3 style="margin:0;">מפה חיה</h3>
      <div style="display:flex;gap:16px;font-size:13px;color:var(--text-muted);">
        <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#22c55e;margin-left:4px;"></span> פתוח</span>
        <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#6b7280;margin-left:4px;"></span> רשום</span>
      </div>
    </div>
    <style>
      #admin-map .leaflet-tile{filter:brightness(0.7) invert(1) contrast(1.1) hue-rotate(200deg) saturate(0.3);}
      #admin-map .leaflet-control-zoom a{background:var(--bg-card)!important;color:var(--text)!important;border-color:var(--border)!important;}
      .leaflet-popup-content-wrapper{background:var(--bg-card)!important;color:var(--text)!important;border-radius:12px!important;}
      .leaflet-popup-tip{background:var(--bg-card)!important;}
      .leaflet-popup-content{font-family:Heebo,sans-serif!important;}
    </style>
    <div id="admin-map" style="height:500px;border-radius:12px;overflow:hidden;border:1px solid var(--border);background:#1e2130;"></div>
  `;
}

async function loadLeaflet() {
  if (_leafletLoaded) return;
  if (window.L) { _leafletLoaded = true; return; }

  await new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/vendor/leaflet/leaflet.css';
    link.onload = resolve;
    link.onerror = reject;
    document.head.appendChild(link);
  });

  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/leaflet/leaflet.js';
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });

  _leafletLoaded = true;
}

export async function onActivate() {
  await loadLeaflet();

  const el = document.getElementById('admin-map');
  if (!el) return;
  if (!window.L) { el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted)">ספריית מפה לא נטענה</div>'; return; }

  el.innerHTML = '';
  if (_map) { _map.remove(); _map = null; }

  try {
    _map = L.map('admin-map', { center: [32.256, 34.918], zoom: 15, zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a>',
      maxZoom: 18,
    }).addTo(_map);

    // Triple invalidateSize (proven pattern)
    setTimeout(() => _map && _map.invalidateSize(), 100);
    setTimeout(() => _map && _map.invalidateSize(), 400);
    setTimeout(() => _map && _map.invalidateSize(), 1000);
  } catch (err) {
    console.error('[map-tab] init error:', err);
    el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted)">שגיאה באתחול מפה</div>';
    return;
  }

  await refreshMarkers();
  _refreshInterval = setInterval(refreshMarkers, 10000);
}

export function onDeactivate() {
  if (_refreshInterval) { clearInterval(_refreshInterval); _refreshInterval = null; }
  if (_map) { _map.remove(); _map = null; }
  _markers = [];
}

async function refreshMarkers() {
  if (!_map) return;
  try {
    const res = await fetch('/api/admin/hosts', {
      headers: { 'Authorization': `Bearer ${localStorage.getItem('sd_auth_token') || ''}` }
    });
    const data = await res.json();
    const hosts = data.hosts || [];

    _markers.forEach(m => _map.removeLayer(m));
    _markers = [];

    const bounds = L.latLngBounds();

    for (const h of hosts) {
      if (!h.lat || !h.lng) continue;
      const isOpen = h.is_active;
      const color = isOpen ? '#22c55e' : '#6b7280';

      const marker = L.circleMarker([h.lat, h.lng], {
        radius: isOpen ? 10 : 7,
        fillColor: color,
        color: color,
        weight: 2,
        fillOpacity: isOpen ? 0.7 : 0.4,
      }).addTo(_map);

      marker.bindPopup(`
        <div dir="rtl" style="font-family:Heebo,sans-serif;min-width:160px;">
          <strong>${h.name}</strong><br>
          ${h.address}<br>
          <small>קומה ${h.floor} · ${h.capacity} אנשים</small><br>
          <small>${isOpen ? '🟢 פתוח' : '⚪ סגור'} · ${h.phone}</small>
        </div>
      `);
      _markers.push(marker);
      bounds.extend([h.lat, h.lng]);
    }

    if (bounds.isValid()) {
      _map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
    }
  } catch (err) {
    console.error('Map refresh failed:', err);
  }
}
