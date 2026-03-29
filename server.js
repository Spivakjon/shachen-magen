// ─── Crash Protection ───
process.on('uncaughtException', (err) => {
  console.error('[שכן-מגן] uncaughtException:', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[שכן-מגן] unhandledRejection:', reason?.stack || reason?.message || reason);
});

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { config } from './core/config.js';
import { logger } from './core/logger.js';
import { registerSharedRoutes } from './lib/shared/sharedAdminRoutes.js';
import { createDatabaseRoutes } from './lib/shared/databaseRoutes.js';
import { dashboardProviders } from './services/admin/adminRoutes.js';
import { registerAuthRoutes } from './services/auth/authRoutes.js';
import { registerShelterRoutes } from './services/shelters/shelterRoutes.js';
import { registerAlertRoutes } from './services/alerts/alertHandler.js';
import { registerPushRoutes } from './services/push/pushRoutes.js';
import { startAlertPoller } from './services/alerts/alertPoller.js';
import { sqliteQuery } from './services/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ═══════════════════════════════════════════════════
// TABLE_CONSUMERS
// ═══════════════════════════════════════════════════
const TABLE_CONSUMERS = {
  hosts:                { tabs: ['ממ"דים', 'מפה', 'מארחים', 'סטטיסטיקות'], agents: [], skills: [] },
  alerts:               { tabs: ['אזעקות', 'סטטיסטיקות'], agents: [], skills: ['alert_poller'] },
  shelter_activations:  { tabs: ['ממ"דים', 'סטטיסטיקות'], agents: [], skills: [] },
  seeker_events:        { tabs: ['סטטיסטיקות'], agents: [], skills: [] },
  push_subscriptions:   { tabs: [], agents: [], skills: ['push_notifications'] },
  otp_codes:            { tabs: [], agents: [], skills: [] },
  app_settings:         { tabs: [], agents: [], skills: [] },
};

const TABLE_SOURCES = {
  hosts:               [{ type: 'route', name: 'Auth + Shelters', file: 'services/auth/authRoutes.js', ops: 'INSERT on register, UPDATE on profile edit' }],
  alerts:              [{ type: 'service', name: 'Alert Poller', file: 'services/alerts/alertPoller.js', ops: 'INSERT from Pikud HaOref API' }],
  shelter_activations: [{ type: 'route', name: 'Shelter Routes', file: 'services/shelters/shelterRoutes.js', ops: 'INSERT on activate, UPDATE on deactivate' }],
  seeker_events:       [{ type: 'route', name: 'Shelter Events', file: 'services/shelters/shelterRoutes.js', ops: 'INSERT from seeker actions' }],
  push_subscriptions:  [{ type: 'route', name: 'Push Routes', file: 'services/push/pushRoutes.js', ops: 'INSERT/DELETE' }],
  otp_codes:           [{ type: 'route', name: 'Auth Routes', file: 'services/auth/authRoutes.js', ops: 'INSERT on send-otp, UPDATE on verify' }],
  app_settings:        [{ type: 'route', name: 'Server', file: 'server.js', ops: 'INSERT/UPDATE' }],
};

const SCAN_FILES = [
  { path: 'services/auth/authRoutes.js',          name: 'Auth Routes',      type: 'route' },
  { path: 'services/shelters/shelterRoutes.js',    name: 'Shelter Routes',   type: 'route' },
  { path: 'services/alerts/alertPoller.js',        name: 'Alert Poller',     type: 'service' },
  { path: 'services/alerts/alertHandler.js',       name: 'Alert Handler',    type: 'service' },
  { path: 'services/push/pushService.js',          name: 'Push Service',     type: 'service' },
  { path: 'services/push/pushRoutes.js',           name: 'Push Routes',      type: 'route' },
  { path: 'services/db.js',                        name: 'SQLite DB',        type: 'service' },
  { path: 'public/js/pages/shelters-tab.js',       name: 'ממ"דים',           type: 'tab' },
  { path: 'public/js/pages/map-tab.js',            name: 'מפה',             type: 'tab' },
  { path: 'public/js/pages/alerts-tab.js',         name: 'אזעקות',          type: 'tab' },
  { path: 'public/js/pages/hosts-tab.js',          name: 'מארחים',          type: 'tab' },
  { path: 'public/js/pages/stats-tab.js',          name: 'סטטיסטיקות',      type: 'tab' },
];

const app = Fastify({ logger });

// ─── Static files ────────────────────────
app.register(fastifyStatic, {
  root: join(__dirname, 'public'),
  prefix: '/',
});

// Serve shared-dashboard static files (bundled locally)
app.register(fastifyStatic, {
  root: join(__dirname, 'lib', 'shared', 'public'),
  prefix: '/shared/',
  decorateReply: false,
});

// ─── Shared dashboard routes ──
registerSharedRoutes(app, dashboardProviders);

// ─── Auth routes ──
registerAuthRoutes(app);

// ─── Shelter routes ──
registerShelterRoutes(app);

// ─── Alert routes ──
registerAlertRoutes(app);

// ─── Push routes ──
registerPushRoutes(app);

// ─── Public config ──
app.get('/api/config', async () => {
  return { googleMapsKey: config.googleMapsKey };
});

// ─── Geocoding + street autocomplete ──
import { geocodeAddress, searchStreets } from './services/geocoding.js';

app.get('/api/streets/search', async (request) => {
  const { q, city } = request.query;
  if (!q || q.length < 2) return { streets: [] };
  const streets = await searchStreets(q, city || 'תל מונד');
  return { streets };
});

app.post('/api/geocode', async (request) => {
  const { address, city } = request.body || {};
  if (!address) return { error: 'address required' };
  const result = await geocodeAddress(address, city || 'תל מונד');
  return result || { error: 'not found' };
});

// ─── Serve app pages ──
app.get('/app', async (request, reply) => {
  return reply.sendFile('app.html');
});

app.get('/host', async (request, reply) => {
  return reply.sendFile('host.html');
});

// ─── Database browser ──
app.register(createDatabaseRoutes({
  query: sqliteQuery,
  tableConsumers: TABLE_CONSUMERS,
  tableSources: TABLE_SOURCES,
  scanFiles: SCAN_FILES,
  projectRoot: __dirname,
  cacheDir: join(__dirname, 'data'),
  projectName: 'שכן מגן',
  dialect: 'sqlite',
}));

// ─── Start ───────────────────────────────
try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  logger.info({ port: config.port }, 'שכן מגן started');

  // Start alert poller
  startAlertPoller();

} catch (err) {
  logger.fatal({ err }, 'FATAL — server failed to start');
  process.exit(1);
}
