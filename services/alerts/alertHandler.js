// services/alerts/alertHandler.js — Process incoming alerts
import db from '../db.js';
import { logger } from '../../core/logger.js';
import { config } from '../../core/config.js';
import { sendPushToHosts } from '../push/pushService.js';

// Alert type mapping from Pikud HaOref
const ALERT_TYPES = {
  1: 'missiles',
  2: 'hostile_aircraft',
  3: 'earthquake',
  4: 'tsunami',
  5: 'radiological',
  6: 'hostile_aircraft',
};

export async function handleNewAlert(alerts) {
  const cities = [...new Set(alerts.map(a => a.data).filter(Boolean))];
  const alertType = ALERT_TYPES[alerts[0]?.cat] || 'missiles';
  const timeToShelter = parseInt(alerts[0]?.countdown) || 90;
  const externalId = alerts.map(a => a.id || a.notificationId || '').join(',');

  // Check if alert already exists
  if (externalId) {
    const existing = db.prepare('SELECT _id FROM alerts WHERE external_id = ?').get(externalId);
    if (existing) return;
  }

  // Save alert
  const result = db.prepare(`
    INSERT INTO alerts (external_id, alert_type, cities, time_to_shelter)
    VALUES (?, ?, ?, ?)
  `).run(externalId || null, alertType, cities.join(', '), timeToShelter);

  const alertId = result.lastInsertRowid;
  logger.warn({ alertId, cities, alertType, timeToShelter }, 'New alert saved');

  // Auto-activate shelters with status 'always_open'
  const autoHosts = db.prepare(`
    SELECT _id, name, phone FROM hosts
    WHERE status = 'always_open' AND is_approved = 1 AND is_active = 0
  `).all();

  for (const host of autoHosts) {
    db.prepare('UPDATE hosts SET is_active = 1 WHERE _id = ?').run(host._id);
    db.prepare(`INSERT INTO shelter_activations (host_id, alert_id, activation_type) VALUES (?, ?, 'auto')`).run(host._id, alertId);
    logger.info({ hostId: host._id, name: host.name }, 'Auto-activated shelter');
  }

  // Send push to 'always_open' hosts — confirmation
  if (autoHosts.length > 0) {
    await sendPushToHosts(autoHosts.map(h => h._id), {
      title: '🚨 אזעקה — הממ"ד שלך נפתח!',
      body: `אזעקה ב${cities.join(', ')}. הממ"ד שלך סומן כפתוח אוטומטית.`,
      url: '/host',
      tag: `alert-auto-${alertId}`,
    });
  }

  // Send push to 'manual' hosts — ask to open
  const manualHosts = db.prepare(`
    SELECT _id, name, phone FROM hosts
    WHERE status = 'manual' AND is_approved = 1 AND is_active = 0
  `).all();

  if (manualHosts.length > 0) {
    await sendPushToHosts(manualHosts.map(h => h._id), {
      title: '🚨 אזעקה! הממ"ד שלך פתוח?',
      body: `אזעקה ב${cities.join(', ')}. לחץ לפתוח את הממ"ד לשכנים.`,
      url: '/host',
      tag: `alert-manual-${alertId}`,
    });
  }

  logger.info({
    alertId,
    autoActivated: autoHosts.length,
    manualNotified: manualHosts.length,
  }, 'Alert handled');

  // Schedule auto-deactivation after 10 minutes
  setTimeout(() => deactivateAlert(alertId), 10 * 60 * 1000);
}

function deactivateAlert(alertId) {
  const alert = db.prepare('SELECT * FROM alerts WHERE _id = ? AND ended_at IS NULL').get(alertId);
  if (!alert) return;

  db.prepare("UPDATE alerts SET ended_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE _id = ?").run(alertId);

  // Deactivate ALL shelters activated for this alert (auto + manual)
  const activations = db.prepare(`
    SELECT host_id FROM shelter_activations
    WHERE alert_id = ? AND deactivated_at IS NULL
  `).all(alertId);

  // Also deactivate any host that is currently active
  const activeHosts = db.prepare('SELECT _id FROM hosts WHERE is_active = 1').all();

  const allHostIds = [...new Set([
    ...activations.map(a => a.host_id),
    ...activeHosts.map(h => h._id),
  ])];

  // Close all active hosts
  if (allHostIds.length > 0) {
    db.prepare(`UPDATE hosts SET is_active = 0 WHERE is_active = 1`).run();
  }

  // Close all open activations for this alert
  db.prepare(`
    UPDATE shelter_activations SET deactivated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE alert_id = ? AND deactivated_at IS NULL
  `).run(alertId);

  // Notify hosts
  if (allHostIds.length > 0) {
    sendPushToHosts(allHostIds, {
      title: '✅ האזעקה הסתיימה',
      body: 'הממ"ד שלך סומן כסגור. תודה!',
      url: '/host',
      tag: `alert-end-${alertId}`,
    }).catch(() => {});
  }

  logger.info({ alertId, deactivatedHosts: allHostIds.length }, 'Alert deactivated — all shelters closed');
}

// ─── Public: get alerts history ───
export function registerAlertRoutes(app) {
  app.get('/api/alerts/history', async () => {
    const alerts = db.prepare('SELECT * FROM alerts ORDER BY started_at DESC LIMIT 100').all();
    return { alerts };
  });

  app.get('/api/alerts/active', async () => {
    const alert = db.prepare('SELECT * FROM alerts WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get();
    return { alert: alert || null };
  });

  // Manual trigger for testing / drill
  app.post('/api/alerts/test', async (request) => {
    const { cities, type, timeToShelter } = request.body || {};
    await handleNewAlert([{
      id: `drill-${Date.now()}`,
      data: cities || 'תל מונד',
      cat: type || 1,
      countdown: timeToShelter || 90,
    }]);
    return { success: true, message: 'Drill alert triggered' };
  });

  // ─── Pikud HaOref API info ───
  app.get('/api/alerts/pikud-info', async () => {
    return {
      api: {
        url: 'https://www.oref.org.il/WarningMessages/alert/alerts.json',
        fallback: 'https://www.oref.org.il/warningMessages/alert/Ede/1/alerts.json',
        method: 'GET',
        headers: { Referer: 'https://www.oref.org.il/', 'X-Requested-With': 'XMLHttpRequest' },
        pollInterval: config.alerts.pollInterval + 'ms',
      },
      monitoredCities: config.alerts.monitoredCities,
      responseFormat: {
        description: 'JSON array when alerts active, empty string when quiet',
        fields: {
          id: 'Alert ID (string)',
          cat: 'Category: 1=missiles, 2=hostile_aircraft, 3=earthquake, 4=tsunami, 5=radiological, 6=hostile_aircraft_intrusion',
          title: 'Alert title in Hebrew',
          data: 'City/area name in Hebrew',
          desc: 'Alert description',
          countdown: 'Seconds to reach shelter (15-90)',
        },
        example: [{ id: '133210621260000000', cat: '1', title: 'ירי רקטות וטילים', data: 'תל מונד', desc: 'היכנסו למרחב המוגן', countdown: '90' }],
      },
      categoryMap: {
        1: 'ירי רקטות וטילים',
        2: 'חדירת כלי טיס עוין',
        3: 'רעידת אדמה',
        4: 'צונאמי',
        5: 'אירוע רדיולוגי',
        6: 'חדירת כלי טיס',
      },
      timeToShelter: {
        description: 'Seconds by distance from Gaza/Lebanon border',
        examples: { 'עוטף עזה': 15, 'אשקלון': 30, 'באר שבע': 60, 'תל אביב': 90, 'חיפה': 90 },
      },
      history: { note: 'Pikud HaOref does not provide a public history API. We store all detected alerts locally.' },
      status: 'polling',
    };
  });

  // ─── Live API connectivity test ───
  app.get('/api/alerts/test-connection', async () => {
    const url = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const start = Date.now();
      const res = await fetch(url, {
        headers: { 'Referer': 'https://www.oref.org.il/', 'X-Requested-With': 'XMLHttpRequest' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const text = await res.text();
      const ms = Date.now() - start;
      const cleaned = text.replace(/^\uFEFF/, '').trim();
      const isEmpty = !cleaned || cleaned === '' || cleaned === '[]';
      const hasAlerts = !isEmpty && cleaned.startsWith('[');

      let alerts = null;
      if (hasAlerts) {
        try { alerts = JSON.parse(cleaned); } catch { alerts = 'parse_error'; }
      }

      return {
        connected: true,
        httpStatus: res.status,
        responseTimeMs: ms,
        isEmpty,
        hasAlerts,
        alertCount: Array.isArray(alerts) ? alerts.length : 0,
        alerts: Array.isArray(alerts) ? alerts.slice(0, 5) : null,
        monitoredCities: config.alerts.monitoredCities,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      return { connected: false, error: err.message, timestamp: new Date().toISOString() };
    }
  });

  // ─── City management (multi-city) ───
  app.get('/api/alerts/cities', async () => {
    const dbCities = db.prepare('SELECT * FROM cities WHERE is_active = 1 ORDER BY name').all();
    return { cities: config.alerts.monitoredCities, dbCities };
  });

  app.post('/api/alerts/cities', async (request) => {
    const { name, name_en, lat, lng, time_to_shelter } = request.body || {};
    if (!name) return { error: 'name required' };
    db.prepare(`INSERT OR IGNORE INTO cities (name, name_en, lat, lng, time_to_shelter) VALUES (?, ?, ?, ?, ?)`)
      .run(name, name_en || '', lat || null, lng || null, time_to_shelter || 90);
    return { success: true };
  });

  // Stop active alert (end drill) — no body required
  app.post('/api/alerts/stop', { config: { rawBody: false } }, async (request, reply) => {
    const active = db.prepare('SELECT _id FROM alerts WHERE ended_at IS NULL').all();
    if (active.length === 0) return { success: true, message: 'No active alerts' };

    for (const a of active) {
      deactivateAlert(a._id);
    }
    return { success: true, stopped: active.length };
  });
}
