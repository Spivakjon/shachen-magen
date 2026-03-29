// shared-dashboard/lib/security.js
// Comprehensive security wrapper — auth, headers, rate-limiting, CORS, audit
// Zero external dependencies — uses Node.js crypto only

import { randomBytes, timingSafeEqual, createHmac } from 'crypto';

// ─── Configuration defaults ───

const DEFAULTS = {
  sessionTTL:    4 * 60 * 60 * 1000,  // 4 hours
  maxSessions:   20,
  rateLimitWindow: 60 * 1000,          // 1 minute
  rateLimitMax:  2000,                   // requests per window
  loginRateMax:  5,                     // login attempts per window
  corsOrigins:   null,                  // null = same-origin only, array = whitelist
  trustProxy:    false,
};

// ─── In-memory session store ───

const sessions = new Map();

function createSession(label) {
  const token = randomBytes(32).toString('hex');
  sessions.set(token, {
    created: Date.now(),
    lastSeen: Date.now(),
    label: label || 'admin',
  });
  return token;
}

function validateSession(token, ttl) {
  if (!token || typeof token !== 'string') return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() - session.created > ttl) {
    sessions.delete(token);
    return false;
  }
  session.lastSeen = Date.now();
  return true;
}

function destroySession(token) {
  sessions.delete(token);
}

function pruneExpiredSessions(ttl) {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.created > ttl) sessions.delete(token);
  }
}

// ─── Rate limiter (sliding window) ───

const rateBuckets = new Map();

function checkRateLimit(key, windowMs, max) {
  const now = Date.now();
  if (!rateBuckets.has(key)) {
    rateBuckets.set(key, []);
  }
  const bucket = rateBuckets.get(key);
  // Remove expired entries
  while (bucket.length > 0 && bucket[0] < now - windowMs) {
    bucket.shift();
  }
  if (bucket.length >= max) {
    return false; // Rate limited
  }
  bucket.push(now);
  return true;
}

// Periodic cleanup of rate limit buckets
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    while (bucket.length > 0 && bucket[0] < now - 120000) bucket.shift();
    if (bucket.length === 0) rateBuckets.delete(key);
  }
}, 60000);

// ─── Helpers ───

function getClientIP(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) {
    // Still do a comparison to avoid timing leaks on length
    const hash1 = createHmac('sha256', 'pad').update(a).digest();
    const hash2 = createHmac('sha256', 'pad').update(b).digest();
    timingSafeEqual(hash1, hash2);
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ─── Main: registerSecurity ───

/**
 * Registers security middleware and auth routes on a Fastify app.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {Object} opts
 * @param {string}   opts.adminSecret      — Required. The admin password/secret.
 * @param {number}   [opts.sessionTTL]     — Session lifetime in ms (default 4h)
 * @param {number}   [opts.rateLimitMax]   — Max requests per minute (default 100)
 * @param {string[]} [opts.corsOrigins]    — Allowed CORS origins (default: same-origin)
 * @param {boolean}  [opts.trustProxy]     — Trust X-Forwarded-For header
 * @param {Function} [opts.logger]         — Logger function (default: console.log)
 * @param {string[]} [opts.publicPaths]    — Additional paths to exclude from auth
 */
export function registerSecurity(app, opts = {}) {
  const adminSecret = opts.adminSecret;
  const authEnabled = !!adminSecret;
  const cfg = { ...DEFAULTS, ...opts };
  const log = cfg.logger || console.log;

  if (!authEnabled) {
    console.warn('[security] WARNING: ADMIN_SECRET is not set — dashboard auth is DISABLED. Set ADMIN_SECRET in your .env file.');
  }

  const publicPaths = new Set([
    '/health',
    '/admin/auth/login',
    '/admin/auth/logout',
    ...(cfg.publicPaths || []),
  ]);

  // Prune sessions periodically (only if auth enabled)
  if (authEnabled) {
    const pruneInterval = setInterval(() => pruneExpiredSessions(cfg.sessionTTL), 60000);
    app.addHook('onClose', () => clearInterval(pruneInterval));
  }

  // ─── Security Headers (all responses) ───
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-XSS-Protection', '1; mode=block');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // CSP — allow self + fonts/styles CDN + localhost for cross-port health checks
    reply.header('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' http://localhost:*;"
    );
    return payload;
  });

  // ─── CORS ───
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin;
    if (cfg.corsOrigins) {
      // Whitelist mode
      if (origin && cfg.corsOrigins.includes(origin)) {
        reply.header('Access-Control-Allow-Origin', origin);
      }
    } else {
      // Default: allow localhost cross-port requests (dev-friendly)
      if (origin && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
        reply.header('Access-Control-Allow-Origin', origin);
      }
    }
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    reply.header('Access-Control-Allow-Credentials', 'true');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      reply.code(204).send();
      return;
    }
  });

  // ─── Rate Limiting ───
  app.addHook('onRequest', async (req, reply) => {
    const ip = getClientIP(req, cfg.trustProxy);
    // Skip rate limiting for localhost / loopback — internal project-to-project traffic
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost') return;

    const isLogin = req.url === '/admin/auth/login' && req.method === 'POST';
    const max = isLogin ? cfg.loginRateMax : cfg.rateLimitMax;
    const key = isLogin ? `login:${ip}` : `api:${ip}`;

    if (!checkRateLimit(key, cfg.rateLimitWindow, max)) {
      reply.header('Retry-After', Math.ceil(cfg.rateLimitWindow / 1000));
      reply.code(429).send({
        ok: false,
        error: 'Too many requests. Please try again later.',
      });
      return;
    }
  });

  // ─── Auth Middleware & Routes (only when auth is enabled) ───
  if (authEnabled) {
    app.addHook('onRequest', async (req, reply) => {
      // Skip non-admin routes, public paths, static files, and webhooks
      const url = req.url.split('?')[0]; // strip query string
      if (!url.startsWith('/admin/')) return;
      if (publicPaths.has(url)) return;

      // Extract token from Authorization header
      let token = null;
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7);
      }

      if (!validateSession(token, cfg.sessionTTL)) {
        reply.code(401).send({ ok: false, error: 'Unauthorized. Please log in.' });
        return;
      }

      // Audit log
      const ip = getClientIP(req, cfg.trustProxy);
      log(`[audit] ${req.method} ${url} — ip=${ip}`);
    });

    // Login
    app.post('/admin/auth/login', async (req, reply) => {
      const { secret } = req.body || {};

      if (!secret || !safeCompare(secret, adminSecret)) {
        const ip = getClientIP(req, cfg.trustProxy);
        log(`[security] Failed login attempt from ${ip}`);
        // Always delay failed login to prevent timing attacks
        await new Promise(r => setTimeout(r, 800 + Math.random() * 400));
        return reply.code(401).send({ ok: false, error: 'Invalid credentials' });
      }

      // Enforce max sessions
      if (sessions.size >= cfg.maxSessions) {
        // Remove oldest session
        const oldest = [...sessions.entries()].sort((a, b) => a[1].created - b[1].created)[0];
        if (oldest) sessions.delete(oldest[0]);
      }

      const token = createSession('admin');
      log(`[security] Admin logged in from ${getClientIP(req, cfg.trustProxy)}`);

      return reply.send({
        ok: true,
        token,
        expiresIn: cfg.sessionTTL,
      });
    });

    // Logout
    app.post('/admin/auth/logout', async (req, reply) => {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        destroySession(authHeader.slice(7));
      }
      return reply.send({ ok: true });
    });

    // Session check
    app.get('/admin/auth/check', async (req, reply) => {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
      const valid = validateSession(token, cfg.sessionTTL);
      return reply.send({ ok: valid });
    });
  }
}
