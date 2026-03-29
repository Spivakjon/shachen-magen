// shared-dashboard/lib/sharedAdminRoutes.js
// Fastify plugin — registers shared dashboard API endpoints + security layer
// Each project provides "providers" with its own data-fetching functions.

import { spawn } from 'child_process';
import { basename, dirname, resolve as resolvePath } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { registerSecurity } from './security.js';
import { scanAllIntegrations } from './integrationScanner.js';

const __sdDir = dirname(fileURLToPath(import.meta.url));
const STANDARD_TABS_DIR = resolvePath(__sdDir, '..', 'public', 'data');
const STANDARD_TABS_FILE = resolvePath(STANDARD_TABS_DIR, 'standard-tabs.json');

function _defaultSettingsFile() {
  return resolvePath(process.cwd(), 'data', 'dashboard-settings.json');
}
function _defaultGetSettings() {
  const file = _defaultSettingsFile();
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
}
function _defaultSaveSettings(settings) {
  const file = _defaultSettingsFile();
  const dir = resolvePath(process.cwd(), 'data');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
}

function _fixMojibakeString(str) {
  if (typeof str !== 'string') return str;
  if (!/[×âð׳]/.test(str)) return str;
  try {
    const fixed = Buffer.from(str, 'latin1').toString('utf8');
    if (!fixed || fixed === str) return str;
    if (/[\u0590-\u05FF]/.test(fixed) || /[\u{1F300}-\u{1FAFF}]/u.test(fixed)) return fixed;
  } catch { /* keep original value */ }
  return str;
}

function _normalizeSettings(value) {
  if (Array.isArray(value)) return value.map(_normalizeSettings);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = _normalizeSettings(v);
    return out;
  }
  return _fixMojibakeString(value);
}

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {Object} providers
 * @param {Function} providers.getStats          - async () => { totalConversations, activeSkills, ... }
 * @param {Function} providers.getConversations  - async (limit) => { conversations: [...] }
 * @param {Function} providers.getThread         - async (userId) => { history: [...] }
 * @param {Function} providers.getSkills         - async () => { skills: [...] }
 * @param {Function} providers.updateSkill       - async (name, body) => skill | null
 * @param {Function} providers.getHealth         - async () => { status, ts, db, ... }
 * @param {Function} [providers.getTokenStats]   - async () => { today, allTime, model } (optional)
 * @param {Object}  [securityOpts]              - Options for security middleware
 * @param {string}  [securityOpts.adminSecret]  - Admin secret for authentication
 */
export function registerSharedRoutes(app, providers, securityOpts = {}) {
  const HUB_URL = process.env.HUB_URL || 'http://localhost:3000';

  // ─── Register security middleware ───
  registerSecurity(app, securityOpts);

  // ─── Public: Health check ───
  app.get('/health', async (req, reply) => {
    try {
      const health = await providers.getHealth();
      return reply.send(health);
    } catch (err) {
      return reply.code(500).send({ status: 'error', error: err.message });
    }
  });

  // ─── Protected: Admin API endpoints ───

  // Stats overview
  app.get('/admin/api/stats', async (req, reply) => {
    try {
      const stats = await providers.getStats();
      return reply.send({ ok: true, ...stats });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err.message });
    }
  });

  // Recent conversations
  app.get('/admin/api/conversations', async (req, reply) => {
    try {
      const limit = parseInt(req.query?.limit) || 20;
      const result = await providers.getConversations(limit);
      return reply.send({ ok: true, ...result });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err.message });
    }
  });

  // Conversation thread
  app.get('/admin/api/conversations/:userId', async (req, reply) => {
    try {
      const result = await providers.getThread(req.params.userId);
      return reply.send({ ok: true, ...result });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err.message });
    }
  });

  // List skills
  app.get('/admin/api/skills', async (req, reply) => {
    try {
      const result = await providers.getSkills();
      return reply.send({ ok: true, ...result });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err.message });
    }
  });

  // Update skill
  app.put('/admin/api/skills/:name', async (req, reply) => {
    try {
      const skill = await providers.updateSkill(req.params.name, req.body);
      if (!skill) return reply.code(404).send({ ok: false, error: 'Skill not found' });
      return reply.send({ ok: true, skill });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err.message });
    }
  });

  // Open terminal for this project
  app.post('/admin/api/open-terminal', async () => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    spawn('wt.exe', ['-w', '0', 'new-tab', '--title', basename(process.cwd()), '-d', process.cwd(), 'cmd', '/k', 'claude'], {
      detached: true, stdio: 'ignore', env,
    }).unref();
    return { ok: true };
  });

  async function _isHubUp() {
    try {
      const r = await fetch(`${HUB_URL}/health`, { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  app.get('/admin/api/hub/status', async () => {
    return { ok: true, hubUrl: HUB_URL, hubUp: await _isHubUp() };
  });

  app.post('/admin/api/hub/start', async (req, reply) => {
    try {
      if (await _isHubUp()) return { ok: true, started: false, alreadyRunning: true, hubUrl: HUB_URL };

      const candidates = [
        resolvePath(__sdDir, '..', '..', 'hub.js'),
        resolvePath(process.cwd(), '..', 'shared-dashboard', 'hub.js'),
        resolvePath(process.cwd(), '..', '..', 'shared-dashboard', 'hub.js'),
      ];
      const hubEntry = candidates.find(p => existsSync(p));
      if (!hubEntry) return reply.code(404).send({ ok: false, error: 'Hub entry not found', candidates });

      const child = spawn(process.execPath, [hubEntry], {
        detached: true,
        stdio: 'ignore',
        cwd: dirname(hubEntry),
        env: { ...process.env },
      });
      child.unref();

      for (let i = 0; i < 15; i++) {
        if (await _isHubUp()) return { ok: true, started: true, hubUrl: HUB_URL };
        await new Promise(r => setTimeout(r, 250));
      }
      return reply.code(202).send({ ok: true, started: true, hubUrl: HUB_URL, note: 'Start requested, hub not ready yet' });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err.message });
    }
  });

  // Integrations — scan current project's .env + optional provider extras (e.g. DB-stored accounts)
  app.get('/admin/api/integrations', async (req, reply) => {
    try {
      const result = scanAllIntegrations([{
        id: '', name: '', port: 0, color: '', logo: '', cwd: process.cwd(),
      }]);
      let integrations = result[0]?.integrations || [];
      if (providers.getExtraIntegrations) {
        const extras = await providers.getExtraIntegrations();
        if (Array.isArray(extras)) integrations = [...integrations, ...extras];
      }
      return reply.send({ ok: true, integrations });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err.message });
    }
  });

  // Token stats (optional — only if project provides getTokenStats)
  if (providers.getTokenStats) {
    app.get('/admin/api/token-stats', async (req, reply) => {
      try {
        const stats = await providers.getTokenStats();
        return reply.send({ ok: true, ...stats });
      } catch (err) {
        return reply.code(500).send({ ok: false, error: 'Failed to get token stats' });
      }
    });
  }

  // Dashboard settings persistence — Hub central DB is source of truth, local file is fallback
  const getSettings = providers.getDashboardSettings || _defaultGetSettings;
  const saveSettings = providers.saveDashboardSettings || _defaultSaveSettings;
  const HUB_SETTINGS_URL = `${HUB_URL}/api/shared-settings`;

  app.get('/admin/api/dashboard-settings', async (req, reply) => {
    try {
      // Try Hub central DB first
      const hubRes = await fetch(HUB_SETTINGS_URL, { signal: AbortSignal.timeout(2000) });
      if (hubRes.ok) {
        const hubData = await hubRes.json();
        if (hubData.ok && hubData.settings) {
          // Merge: Hub shared settings + local project-specific overrides
          const local = _normalizeSettings(await getSettings());
          const PROJECT_SPECIFIC_KEYS = ['project_name', 'logo', 'project_icon'];
          const merged = { ..._normalizeSettings(hubData.settings) };
          // Backward-compat: if Hub settings miss keys that still exist locally,
          // keep them so refresh won't silently reset the dashboard.
          for (const [k, v] of Object.entries(local || {})) {
            if (merged[k] === undefined) merged[k] = v;
          }
          for (const k of PROJECT_SPECIFIC_KEYS) {
            if (local?.[k] !== undefined) merged[k] = local[k];
          }
          if (hubData._broadcast_ts) merged._broadcast_ts = hubData._broadcast_ts;
          return reply.send({ ok: true, settings: merged });
        }
      }
    } catch { /* Hub unavailable — fall back to local */ }
    try {
      const settings = _normalizeSettings(await getSettings());
      return reply.send({ ok: true, settings: settings || {} });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err.message });
    }
  });

  app.put('/admin/api/dashboard-settings', async (req, reply) => {
    try {
      // Save locally (cache/fallback) as merge to avoid dropping keys on partial payloads.
      const existing = _normalizeSettings(await getSettings());
      const incoming = _normalizeSettings(req.body || {});
      const existingTs = Number(existing?._broadcast_ts || 0);
      const incomingTs = Number(incoming?._broadcast_ts || 0);
      const isStaleIncoming = existingTs > 0 && incomingTs > 0 && incomingTs < existingTs;
      const PROJECT_SPECIFIC_KEYS = ['project_name', 'logo', 'project_icon'];

      const merged = { ...(existing || {}), ...incoming };
      // Guard against stale browser cache overwriting shared settings.
      if (isStaleIncoming) {
        for (const k of Object.keys(incoming || {})) {
          if (k === '_broadcast_ts') continue;
          if (PROJECT_SPECIFIC_KEYS.includes(k)) continue;
          if (existing?.[k] !== undefined) merged[k] = existing[k];
        }
      }
      await saveSettings(merged);
      // Also push to Hub central DB via broadcast
      try {
        const port = app.server?.address?.()?.port || req.port;
        await fetch(`${HUB_URL}/api/broadcast-settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: merged, senderPort: port }),
          signal: AbortSignal.timeout(3000),
        });
      } catch { /* Hub unavailable — local save is enough */ }
      return reply.send({ ok: true });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err.message });
    }
  });

  // ─── Standard tabs config management ───

  app.get('/admin/api/standard-tabs', async (req, reply) => {
    try {
      if (!existsSync(STANDARD_TABS_FILE)) return reply.send({ ok: true, config: { version: 1, tabs: [], alwaysInject: ['dashboard-categories', 'dashboard-settings'] } });
      const data = JSON.parse(readFileSync(STANDARD_TABS_FILE, 'utf8'));
      return reply.send({ ok: true, config: data });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err.message });
    }
  });

  app.put('/admin/api/standard-tabs', async (req, reply) => {
    try {
      if (!existsSync(STANDARD_TABS_DIR)) mkdirSync(STANDARD_TABS_DIR, { recursive: true });
      writeFileSync(STANDARD_TABS_FILE, JSON.stringify(req.body, null, 2) + '\n', 'utf-8');
      return reply.send({ ok: true });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err.message });
    }
  });

  app.get('/admin/api/standard-tabs/available', async (req, reply) => {
    try {
      return reply.send({
        ok: true,
        builtinTypes: [
          { id: 'conversations', label: '\u05E9\u05D9\u05D7\u05D5\u05EA', icon: '\uD83D\uDCAC' },
        ],
        sharedModules: [
          { id: 'email-inbox', label: '\u05D3\u05D5\u05D0\u05E8', icon: '\u2709', modulePath: '/shared/js/pages/email-inbox.js' },
          { id: 'tasks', label: '\u05DE\u05E9\u05D9\u05DE\u05D5\u05EA', icon: '\u2713', modulePath: '/shared/js/pages/tasks-tab.js' },
          { id: 'database', label: '\u05D3\u05D0\u05D8\u05D4-\u05D1\u05D9\u05D9\u05E1', icon: '\u2261', modulePath: '/shared/js/pages/database.js' },
        ],
      });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: err.message });
    }
  });
}
