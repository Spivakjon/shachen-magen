// services/shelters/shelterRoutes.js — Shelter CRUD + public nearby search
import db from '../db.js';
import { hostAuth } from '../auth/authRoutes.js';
import { logger } from '../../core/logger.js';

export function registerShelterRoutes(app) {

  // ═══════════════════════════════════════
  // PUBLIC — Seeker endpoints (no auth)
  // ═══════════════════════════════════════

  // ─── Get nearby shelters ───
  // Returns ALL approved shelters with is_active flag.
  // During alert, open shelters are sorted first.
  app.get('/api/shelters/nearby', async (request) => {
    const { lat, lng, radius } = request.query;
    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);
    const maxRadius = parseFloat(radius) || 2000; // meters

    if (!userLat || !userLng) {
      return { error: 'lat and lng required', shelters: [] };
    }

    // Get ALL approved shelters (both open and closed)
    const shelters = db.prepare(`
      SELECT _id, name, phone, address, city, neighborhood, lat, lng, floor, capacity,
             accessibility, notes, status, is_active
      FROM hosts
      WHERE is_approved = 1 AND lat IS NOT NULL AND lng IS NOT NULL
    `).all();

    // Calculate distance and filter by radius
    const results = shelters
      .map(s => ({
        ...s,
        distance: haversineDistance(userLat, userLng, s.lat, s.lng),
      }))
      .filter(s => s.distance <= maxRadius)
      .sort((a, b) => {
        // Open shelters first, then by distance
        if (a.is_active !== b.is_active) return b.is_active - a.is_active;
        return a.distance - b.distance;
      });

    // Add walking time estimate (avg 80m/min)
    for (const s of results) {
      s.walkMinutes = Math.max(1, Math.round(s.distance / 80));
    }

    return { shelters: results };
  });

  // ─── Get active alert info ───
  app.get('/api/shelters/active-alert', async () => {
    const alert = db.prepare(`
      SELECT * FROM alerts WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1
    `).get();
    return { alert: alert || null };
  });

  // ─── Seeker event (view, navigate, on_my_way, arrived) ───
  app.post('/api/shelters/:id/events', async (request) => {
    const hostId = parseInt(request.params.id);
    const { event_type, lat, lng } = request.body || {};

    if (!event_type) return { error: 'event_type required' };

    // Find active activation for this host
    const activation = db.prepare(`
      SELECT _id FROM shelter_activations
      WHERE host_id = ? AND deactivated_at IS NULL
      ORDER BY activated_at DESC LIMIT 1
    `).get(hostId);

    db.prepare(`
      INSERT INTO seeker_events (activation_id, host_id, event_type, seeker_lat, seeker_lng)
      VALUES (?, ?, ?, ?, ?)
    `).run(activation?._id || null, hostId, event_type, lat || null, lng || null);

    // Update seekers count on activation
    if (activation && event_type === 'on_my_way') {
      db.prepare('UPDATE shelter_activations SET seekers_count = seekers_count + 1 WHERE _id = ?').run(activation._id);
    }

    logger.info({ hostId, event_type }, 'Seeker event recorded');
    return { success: true };
  });

  // ═══════════════════════════════════════
  // HOST — Authenticated endpoints
  // ═══════════════════════════════════════

  // ─── Get my shelter ───
  app.get('/api/shelters/mine', { preHandler: hostAuth }, async (request) => {
    const host = db.prepare('SELECT * FROM hosts WHERE _id = ?').get(request.hostId);
    if (!host) return { error: 'לא נמצא' };

    // Get stats
    const activations = db.prepare('SELECT COUNT(*) as c FROM shelter_activations WHERE host_id = ?').get(request.hostId).c;
    const seekersHelped = db.prepare('SELECT COALESCE(SUM(seekers_count), 0) as c FROM shelter_activations WHERE host_id = ?').get(request.hostId).c;

    return { host, stats: { activations, seekersHelped } };
  });

  // ─── Update my shelter ───
  app.put('/api/shelters/mine', { preHandler: hostAuth }, async (request) => {
    const { name, address, city, neighborhood, lat, lng, floor, capacity, accessibility, notes, status } = request.body || {};
    const hostId = request.hostId;

    const fields = [];
    const values = [];

    if (name !== undefined)          { fields.push('name = ?');          values.push(name); }
    if (address !== undefined)       { fields.push('address = ?');       values.push(address); }
    if (city !== undefined)          { fields.push('city = ?');          values.push(city); }
    if (neighborhood !== undefined)  { fields.push('neighborhood = ?');  values.push(neighborhood); }
    if (lat !== undefined)           { fields.push('lat = ?');           values.push(lat); }
    if (lng !== undefined)           { fields.push('lng = ?');           values.push(lng); }
    if (floor !== undefined)         { fields.push('floor = ?');         values.push(floor); }
    if (capacity !== undefined)      { fields.push('capacity = ?');      values.push(capacity); }
    if (accessibility !== undefined) { fields.push('accessibility = ?'); values.push(accessibility ? 1 : 0); }
    if (notes !== undefined)         { fields.push('notes = ?');         values.push(notes); }
    if (status !== undefined)        { fields.push('status = ?');        values.push(status); }

    if (fields.length === 0) return { error: 'אין שדות לעדכון' };

    fields.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')");
    values.push(hostId);

    db.prepare(`UPDATE hosts SET ${fields.join(', ')} WHERE _id = ?`).run(...values);

    const updated = db.prepare('SELECT * FROM hosts WHERE _id = ?').get(hostId);
    logger.info({ hostId }, 'Host shelter updated');
    return { success: true, host: updated };
  });

  // ─── Activate shelter (open) ───
  app.post('/api/shelters/mine/activate', { preHandler: hostAuth }, async (request) => {
    const hostId = request.hostId;

    // Check if already active
    const host = db.prepare('SELECT is_active FROM hosts WHERE _id = ?').get(hostId);
    if (host?.is_active) return { success: true };

    db.prepare('UPDATE hosts SET is_active = 1, updated_at = strftime(\'%Y-%m-%dT%H:%M:%SZ\',\'now\') WHERE _id = ?').run(hostId);

    // Find current active alert
    const alert = db.prepare('SELECT _id FROM alerts WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get();

    db.prepare(`INSERT INTO shelter_activations (host_id, alert_id, activation_type) VALUES (?, ?, 'manual')`).run(hostId, alert?._id || null);

    logger.info({ hostId, alertId: alert?._id }, 'Shelter activated by host');
    return { success: true };
  });

  // ─── Deactivate shelter (close) ───
  app.post('/api/shelters/mine/deactivate', { preHandler: hostAuth }, async (request) => {
    const hostId = request.hostId;

    db.prepare('UPDATE hosts SET is_active = 0, updated_at = strftime(\'%Y-%m-%dT%H:%M:%SZ\',\'now\') WHERE _id = ?').run(hostId);

    // Close any open activation
    db.prepare(`UPDATE shelter_activations SET deactivated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE host_id = ? AND deactivated_at IS NULL`).run(hostId);

    logger.info({ hostId }, 'Shelter deactivated by host');
    return { success: true };
  });

  // ─── Get my activation stats ───
  app.get('/api/shelters/mine/stats', { preHandler: hostAuth }, async (request) => {
    const hostId = request.hostId;

    const activations = db.prepare('SELECT COUNT(*) as c FROM shelter_activations WHERE host_id = ?').get(hostId).c;
    const seekersHelped = db.prepare('SELECT COALESCE(SUM(seekers_count), 0) as c FROM shelter_activations WHERE host_id = ?').get(hostId).c;
    const seekersOnWay = db.prepare(`
      SELECT COUNT(*) as c FROM seeker_events
      WHERE host_id = ? AND event_type = 'on_my_way'
      AND created_at > datetime('now', '-10 minutes')
    `).get(hostId).c;

    return { activations, seekersHelped, seekersOnWay };
  });

  // ═══════════════════════════════════════
  // ADMIN — Dashboard endpoints
  // ═══════════════════════════════════════

  app.get('/api/admin/hosts', async () => {
    const hosts = db.prepare('SELECT * FROM hosts ORDER BY created_at DESC').all();
    return { hosts };
  });

  app.get('/api/admin/stats', async () => {
    const totalHosts = db.prepare('SELECT COUNT(*) as c FROM hosts').get().c;
    const activeHosts = db.prepare('SELECT COUNT(*) as c FROM hosts WHERE is_active = 1').get().c;
    const totalAlerts = db.prepare('SELECT COUNT(*) as c FROM alerts').get().c;
    const totalActivations = db.prepare('SELECT COUNT(*) as c FROM shelter_activations').get().c;
    const totalSeekerEvents = db.prepare('SELECT COUNT(*) as c FROM seeker_events').get().c;
    return { totalHosts, activeHosts, totalAlerts, totalActivations, totalSeekerEvents };
  });

  app.put('/api/admin/hosts/:id/approve', async (request) => {
    db.prepare('UPDATE hosts SET is_approved = 1 WHERE _id = ?').run(parseInt(request.params.id));
    return { success: true };
  });

  app.put('/api/admin/hosts/:id/block', async (request) => {
    db.prepare('UPDATE hosts SET is_approved = 0, is_active = 0 WHERE _id = ?').run(parseInt(request.params.id));
    return { success: true };
  });

  app.get('/api/admin/recent-activations', async () => {
    const activations = db.prepare(`
      SELECT sa.*, h.name as host_name
      FROM shelter_activations sa
      JOIN hosts h ON h._id = sa.host_id
      ORDER BY sa.activated_at DESC LIMIT 20
    `).all();
    return { activations };
  });

  app.get('/api/admin/recent-events', async () => {
    const events = db.prepare(`
      SELECT se.*, h.name as host_name
      FROM seeker_events se
      LEFT JOIN hosts h ON h._id = se.host_id
      ORDER BY se.created_at DESC LIMIT 20
    `).all();
    return { events };
  });
}

// ─── Haversine distance in meters ───
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
