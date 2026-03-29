// services/auth/authRoutes.js — OTP-based authentication for hosts
import jwt from 'jsonwebtoken';
import db from '../db.js';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { sendSMS } from '../sms.js';

const JWT_SECRET = config.admin.secret || 'magen-shachen-secret';
const OTP_EXPIRY_MINUTES = 5;

function generateOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalizePhone(phone) {
  let p = String(phone).replace(/[\s\-()]/g, '');
  if (p.startsWith('+972')) p = '0' + p.slice(4);
  else if (p.startsWith('972')) p = '0' + p.slice(3);
  return p;
}

export function registerAuthRoutes(app) {

  // ─── Send OTP ───
  app.post('/api/auth/send-otp', async (request, reply) => {
    const { phone } = request.body || {};
    if (!phone) return reply.code(400).send({ error: 'מספר טלפון נדרש' });

    const normalized = normalizePhone(phone);
    const code = generateOTP();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();

    // Save OTP
    db.prepare(`INSERT INTO otp_codes (phone, code, expires_at) VALUES (?, ?, ?)`).run(normalized, code, expiresAt);

    // In DRY_RUN mode, log the code instead of sending SMS
    if (config.dryRun) {
      logger.info({ phone: normalized, code }, 'OTP code (DRY_RUN — not sent via SMS)');
      return { success: true, dryRun: true, code }; // Return code in dev mode
    }

    // Send SMS
    const smsResult = await sendSMS(normalized, `שכן מגן — קוד אימות: ${code}`);
    if (!smsResult.success) {
      logger.error({ phone: normalized, error: smsResult.error }, 'SMS send failed');
      return reply.code(500).send({ error: 'שגיאה בשליחת SMS, נסה שוב' });
    }

    logger.info({ phone: normalized, provider: smsResult.provider }, 'OTP sent via SMS');
    return { success: true };
  });

  // ─── Verify OTP (step 2) ───
  // Returns token if host exists, or needsRegistration if new phone
  app.post('/api/auth/verify-otp', async (request, reply) => {
    const { phone, code } = request.body || {};
    if (!phone || !code) return reply.code(400).send({ error: 'טלפון וקוד נדרשים' });

    const normalized = normalizePhone(phone);

    // Find valid OTP
    const otp = db.prepare(`
      SELECT * FROM otp_codes
      WHERE phone = ? AND code = ? AND used = 0 AND expires_at > datetime('now')
      ORDER BY created_at DESC LIMIT 1
    `).get(normalized, code);

    if (!otp) {
      return reply.code(401).send({ error: 'קוד שגוי או שפג תוקפו' });
    }

    // Mark OTP as used
    db.prepare('UPDATE otp_codes SET used = 1 WHERE _id = ?').run(otp._id);

    // Check if host exists
    const host = db.prepare('SELECT * FROM hosts WHERE phone = ?').get(normalized);

    if (!host) {
      // New user — generate a temporary registration token (valid 15 min)
      const regToken = jwt.sign(
        { phone: normalized, purpose: 'register' },
        JWT_SECRET,
        { expiresIn: '15m' }
      );
      return { success: true, needsRegistration: true, regToken };
    }

    // Existing host — log in
    if (!host.verified_phone) {
      db.prepare('UPDATE hosts SET verified_phone = 1 WHERE _id = ?').run(host._id);
    }

    const token = jwt.sign(
      { hostId: host._id, phone: normalized, role: 'host' },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    return { success: true, token, host: hostToResponse(host) };
  });

  // ─── Register new host (step 3 — after OTP verified) ───
  app.post('/api/auth/register', async (request, reply) => {
    const { regToken, name, address, city, floor, capacity, notes, accessibility, lat, lng } = request.body || {};

    if (!regToken) return reply.code(400).send({ error: 'טוקן רישום נדרש' });
    if (!name || !address) return reply.code(400).send({ error: 'שם וכתובת הם שדות חובה' });

    // Verify registration token
    let payload;
    try {
      payload = jwt.verify(regToken, JWT_SECRET);
    } catch {
      return reply.code(401).send({ error: 'טוקן רישום פג תוקף, שלח קוד מחדש' });
    }

    if (payload.purpose !== 'register') {
      return reply.code(400).send({ error: 'טוקן לא תקין' });
    }

    const phone = payload.phone;

    // Check not already registered
    const existing = db.prepare('SELECT _id FROM hosts WHERE phone = ?').get(phone);
    if (existing) {
      return reply.code(400).send({ error: 'מספר כבר רשום' });
    }

    // Auto-geocode if lat/lng not provided
    let finalLat = lat || null;
    let finalLng = lng || null;
    if (!finalLat && address) {
      try {
        const { geocodeAddress } = await import('../geocoding.js');
        const geo = await geocodeAddress(address, city || 'תל מונד');
        if (geo) { finalLat = geo.lat; finalLng = geo.lng; }
      } catch { /* geocoding optional */ }
    }

    // Create host with all details
    db.prepare(`
      INSERT INTO hosts (phone, name, address, city, floor, capacity, notes, accessibility, lat, lng, verified_phone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      phone,
      name,
      address,
      city || 'תל מונד',
      parseInt(floor) || 0,
      parseInt(capacity) || 4,
      notes || '',
      accessibility ? 1 : 0,
      finalLat,
      finalLng
    );

    const host = db.prepare('SELECT * FROM hosts WHERE phone = ?').get(phone);
    logger.info({ phone, name, address, lat: finalLat, lng: finalLng }, 'New host registered');

    // Generate login token
    const token = jwt.sign(
      { hostId: host._id, phone, role: 'host' },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    return { success: true, token, host: hostToResponse(host) };
  });

  // ─── Get current host profile ───
  app.get('/api/auth/me', { preHandler: hostAuth }, async (request) => {
    const host = db.prepare('SELECT * FROM hosts WHERE _id = ?').get(request.hostId);
    if (!host) return { error: 'לא נמצא' };
    return { host };
  });
}

function hostToResponse(host) {
  return {
    _id: host._id, name: host.name, phone: host.phone,
    address: host.address, city: host.city, floor: host.floor,
    capacity: host.capacity, accessibility: host.accessibility,
    notes: host.notes, status: host.status, is_active: host.is_active,
  };
}

// ─── Host auth middleware ───
export function hostAuth(request, reply, done) {
  const auth = request.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'נדרש אימות' });
    return;
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    request.hostId = payload.hostId;
    request.hostPhone = payload.phone;
    done();
  } catch {
    reply.code(401).send({ error: 'טוקן לא תקין' });
  }
}
