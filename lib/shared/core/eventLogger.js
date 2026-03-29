// shared-dashboard/lib/core/eventLogger.js
// Universal system event logger — logs to Pino + persists to PostgreSQL system_events table.
// Non-blocking: never throws, DB writes are fire-and-forget.
//
// Usage:
//   import { logEvent } from 'shared-dashboard/core/eventLogger';
//   await logEvent({ project: 'spivak-os', type: 'message.received', entity_id: userId, status: 'ok', duration_ms: 42 });

import { randomUUID } from 'crypto';
import pg from 'pg';
import { logger } from './logger.js';

const { Pool } = pg;

let _pool = null;

function _getPool() {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  _pool = new Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL !== '0' ? { rejectUnauthorized: false } : false,
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  _pool.on('error', (err) => logger.error({ err }, '[eventLogger] pool error'));
  return _pool;
}

/**
 * Log a structured system event. Logs to Pino and persists to DB.
 * Never throws. Accepts both camelCase and snake_case field names.
 *
 * @param {object} event
 * @param {string} event.project       - Project name (e.g. 'spivak-os')
 * @param {string} event.type          - Event type (e.g. 'message.received')
 * @param {string} [event.entity_id]   - Relevant entity ID (userId, toolName, …)
 * @param {string} [event.entityId]    - Alias for entity_id (backward compat)
 * @param {'ok'|'success'|'error'|'warn'|'info'} [event.status] - Outcome
 * @param {number} [event.duration_ms] - Elapsed time in ms
 * @param {number} [event.durationMs]  - Alias for duration_ms (backward compat)
 * @param {object} [event.metadata]    - Arbitrary extra context
 * @param {string} [event.trace_id]    - UUID trace ID (auto-generated if missing)
 */
export async function logEvent(event = {}) {
  try {
    const {
      project, type, status = 'info', metadata,
      entity_id, entityId,
      duration_ms, durationMs,
      trace_id,
    } = event;

    const resolvedEntityId  = entity_id  ?? entityId  ?? null;
    const resolvedDurationMs = duration_ms ?? durationMs ?? null;

    // ─── Pino log ───
    const entry = { project, type, entityId: resolvedEntityId, status };
    if (resolvedDurationMs !== undefined && resolvedDurationMs !== null) entry.durationMs = resolvedDurationMs;
    if (metadata) entry.metadata = metadata;

    if (status === 'error') {
      logger.error(entry, `[event] ${type}`);
    } else {
      logger.info(entry, `[event] ${type}`);
    }

    // ─── DB persistence (fail-safe) ───
    if (!project || !type) return;
    const pool = _getPool();
    if (!pool) return;

    pool.query(
      `INSERT INTO system_events (trace_id, project, type, entity_id, status, duration_ms, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        trace_id || randomUUID(),
        project,
        type,
        resolvedEntityId,
        status,
        resolvedDurationMs,
        metadata ? JSON.stringify(metadata) : '{}',
      ]
    ).catch((err) => logger.error({ err }, '[eventLogger] DB insert failed'));

  } catch {
    // Never let logging break the caller
  }
}

/**
 * Query recent system events.
 * @param {{ limit?: number, project?: string, type?: string }} opts
 * @returns {Promise<Array>}
 */
export async function getSystemEvents({ limit = 100, project, type } = {}) {
  const pool = _getPool();
  if (!pool) return [];
  const conditions = [];
  const params = [];
  if (project) { params.push(project); conditions.push(`project = $${params.length}`); }
  if (type)    { params.push(type);    conditions.push(`type = $${params.length}`); }
  params.push(Math.min(limit, 1000));
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const { rows } = await pool.query(
    `SELECT id, trace_id, project, type, entity_id, status, duration_ms, metadata, created_at
     FROM system_events
     ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params
  );
  return rows;
}
