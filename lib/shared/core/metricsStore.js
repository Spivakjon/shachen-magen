// shared-dashboard/lib/core/metricsStore.js
// Daily metrics store — reads/writes system_metrics_daily and aggregates from system_events.
//
// Usage:
//   import { recordMetric, getGlobalMetrics } from 'shared-dashboard/core/metricsStore';
//
//   // Write a custom daily metric (e.g. from a cron job):
//   await recordMetric({ date: '2026-03-01', project: 'spivak-os', metric: 'active_users', value: 42 });
//
//   // Query for the API:
//   const data = await getGlobalMetrics({ days: 7 });

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
  _pool.on('error', (err) => logger.error({ err }, '[metricsStore] pool error'));
  return _pool;
}

/**
 * Upsert a daily metric value for a project.
 * @param {{ date: string, project: string, metric: string, value: number }} opts
 */
export async function recordMetric({ date, project, metric, value }) {
  try {
    const pool = _getPool();
    if (!pool) return;
    await pool.query(
      `INSERT INTO system_metrics_daily (date, project, metric, value)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (date, project, metric) DO UPDATE SET value = EXCLUDED.value`,
      [date, project, metric, value]
    );
  } catch (err) {
    logger.error({ err }, '[metricsStore] recordMetric failed');
  }
}

/**
 * Aggregate global metrics from system_events (live) + system_metrics_daily (stored).
 * @param {{ days?: number }} opts
 * @returns {Promise<{ summary, byProject, byDay, stored }>}
 */
export async function getGlobalMetrics({ days = 7 } = {}) {
  const pool = _getPool();
  if (!pool) return { summary: {}, byProject: [], byDay: [], stored: [] };

  const safeDays = Math.min(Math.max(1, parseInt(days) || 7), 90);

  // ─── Per-project totals from system_events ───
  const { rows: byProject } = await pool.query(
    `SELECT
       project,
       COUNT(*)::int                                                   AS total,
       COUNT(*) FILTER (WHERE status IN ('error','failed'))::int       AS errors,
       COUNT(*) FILTER (WHERE
         type ILIKE '%message%' OR type ILIKE '%msg%' OR
         type ILIKE '%whatsapp%' OR type ILIKE '%telegram%'
       )::int                                                          AS messages,
       ROUND(AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::int AS avg_duration_ms
     FROM system_events
     WHERE created_at >= NOW() - INTERVAL '1 day' * $1
     GROUP BY project
     ORDER BY total DESC`,
    [safeDays]
  );

  // ─── Daily totals from system_events ───
  const { rows: byDay } = await pool.query(
    `SELECT
       DATE(created_at AT TIME ZONE 'UTC')::text                      AS date,
       COUNT(*)::int                                                   AS total,
       COUNT(*) FILTER (WHERE status IN ('error','failed'))::int       AS errors,
       COUNT(*) FILTER (WHERE
         type ILIKE '%message%' OR type ILIKE '%msg%' OR
         type ILIKE '%whatsapp%' OR type ILIKE '%telegram%'
       )::int                                                          AS messages
     FROM system_events
     WHERE created_at >= NOW() - INTERVAL '1 day' * $1
     GROUP BY DATE(created_at AT TIME ZONE 'UTC')
     ORDER BY date ASC`,
    [safeDays]
  );

  // ─── Stored daily metrics ───
  let stored = [];
  try {
    const { rows } = await pool.query(
      `SELECT date::text, project, metric, value::numeric AS value
       FROM system_metrics_daily
       WHERE date >= CURRENT_DATE - $1
       ORDER BY date ASC, project, metric`,
      [safeDays]
    );
    stored = rows;
  } catch {
    // Table may not exist yet — silently return empty
  }

  // ─── Cross-project summary ───
  const summary = byProject.reduce((acc, r) => ({
    total:    (acc.total    || 0) + r.total,
    errors:   (acc.errors   || 0) + r.errors,
    messages: (acc.messages || 0) + r.messages,
  }), {});

  return { summary, byProject, byDay, stored };
}
