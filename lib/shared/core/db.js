// shared-dashboard/lib/core/db.js
// Shared PostgreSQL database factory
//
// Usage:
//   import { createDb } from 'shared-dashboard/core/db';
//   import { config } from './config.js';
//   const { query, transaction, healthCheck } = createDb({
//     url: config.database.url,
//     ssl: config.database.ssl,
//   });

import pg from 'pg';
import { logger } from './logger.js';

const { Pool } = pg;

export function createDb({ url, ssl = true } = {}) {
  if (!url) {
    logger.warn('DATABASE_URL not set — DB will not work');
  }

  // Mode-aware pool sizing
  const mode = process.env.PROJECT_MODE || 'full';
  const maxConns = mode === 'light' ? 3 : mode === 'full' ? 8 : 5;

  const pool = new Pool({
    connectionString: url,
    ssl: ssl ? { rejectUnauthorized: false } : false,
    max: maxConns,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });

  pool.on('error', (err) => {
    logger.error({ err }, 'PostgreSQL pool error');
  });

  pool.on('connect', () => {
    logger.debug({ mode, max: maxConns }, 'New PostgreSQL connection opened');
  });

  // Connection storm detection
  let acquireCount = 0;
  const STORM_THRESHOLD = 50; // per minute
  pool.on('acquire', () => { acquireCount++; });
  const stormTimer = setInterval(() => {
    if (acquireCount > STORM_THRESHOLD) {
      logger.warn({ count: acquireCount, threshold: STORM_THRESHOLD }, 'DB connection storm detected');
    }
    acquireCount = 0;
  }, 60_000);
  stormTimer.unref();

  async function query(text, params) {
    const start = Date.now();
    try {
      const res = await pool.query(text, params);
      logger.debug({ query: text, duration: Date.now() - start, rows: res.rowCount }, 'DB query');
      return res;
    } catch (err) {
      logger.error({ err, query: text, params }, 'DB query failed');
      throw err;
    }
  }

  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err }, 'Transaction failed — rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  async function healthCheck() {
    const res = await query('SELECT NOW() as ts');
    return { ok: true, ts: res.rows[0].ts };
  }

  function poolStats() {
    return {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      max: maxConns,
      mode,
    };
  }

  return { query, transaction, healthCheck, pool, poolStats };
}
