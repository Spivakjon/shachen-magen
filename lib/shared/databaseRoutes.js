// shared-dashboard/lib/database/databaseRoutes.js
// Fastify plugin — registers database browser API endpoints
// Each project provides its own query/transaction + optional callAI

import { readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

/**
 * @param {Object} opts
 * @param {Function} opts.query          - async (sql, params?) => { rows }
 * @param {Function} opts.transaction    - async (cb) => result  (cb receives client)
 * @param {Function} [opts.callAI]       - async (systemPrompt, userMessage) => string (optional)
 * @param {Function} [opts.chatAI]       - async (messages, opts) => { content } — for analyze endpoint (optional)
 * @param {Object}   [opts.tableConsumers] - { tableName: { tabs, agents, skills } } (default: {})
 * @param {Object}   [opts.tableSources]   - { tableName: [{ type, name, file, ops }] } — static source mappings
 * @param {Array}    [opts.scanFiles]      - [{ path, name, type }] — project files to scan for table references
 * @param {string}   [opts.projectRoot]    - Root path for file scanning + migrations
 * @param {string}   [opts.cacheDir]       - Directory for context cache file (null = collect disabled)
 * @param {string}   [opts.projectName]    - Project name for markdown output header
 * @param {string}   [opts.prefix]         - Route prefix (default: '/api/database')
 * @param {string}   [opts.dialect]        - 'pg' (default) or 'sqlite'
 */
export function createDatabaseRoutes({
  query, transaction, callAI, chatAI,
  tableConsumers = {}, tableSources = {}, scanFiles = [],
  projectRoot = null, cacheDir = null, projectName = '',
  prefix = '/api/database', dialect = 'pg',
}) {
  const isSqlite = dialect === 'sqlite';

  // ── Helpers for collect-context cache ──
  const cacheFile = cacheDir ? join(cacheDir, 'db-context-cache.json') : null;

  async function readCache() {
    if (!cacheFile) return null;
    try {
      const raw = await readFile(cacheFile, 'utf-8');
      return JSON.parse(raw);
    } catch { return null; }
  }

  async function writeCache(data) {
    if (!cacheFile) return;
    try {
      if (!existsSync(cacheDir)) await mkdir(cacheDir, { recursive: true });
      await writeFile(cacheFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch { /* best effort */ }
  }

  /**
   * Scan project files for references to table names → build consumer map dynamically
   */
  async function detectAllConsumers(tableNames) {
    if (!projectRoot || scanFiles.length === 0) return {};

    const consumers = {};
    for (const t of tableNames) {
      consumers[t] = { tabs: new Set(), agents: new Set(), routes: new Set(), services: new Set() };
    }

    // Read all files in parallel
    const fileContents = await Promise.all(
      scanFiles.map(async (entry) => {
        try {
          const fullPath = entry.fullPath || join(projectRoot, entry.path);
          const content = await readFile(fullPath, 'utf-8');
          return { ...entry, content };
        } catch {
          return { ...entry, content: null };
        }
      })
    );

    // For each table, search each file
    for (const tableName of tableNames) {
      if (tableName === '_migrations') continue;
      for (const file of fileContents) {
        if (!file.content) continue;
        if (!file.content.includes(tableName)) continue;

        const c = consumers[tableName];
        if (file.type === 'tab')        c.tabs.add(file.name);
        else if (file.type === 'agent') c.agents.add(file.name);
        else if (file.type === 'route' || file.type === 'repository' || file.type === 'adapter')
                                         c.routes.add(file.name);
        else                             c.services.add(file.name);
      }
    }

    // Convert Sets to Arrays
    const result = {};
    for (const [table, c] of Object.entries(consumers)) {
      result[table] = {
        tabs:     [...c.tabs],
        agents:   [...c.agents],
        routes:   [...c.routes],
        services: [...c.services],
      };
    }
    return result;
  }

  return async function databaseRoutesPlugin(fastify) {

    // ── Helper: get table list + columns (dialect-aware) ──
    async function fetchTablesAndColumns() {
      if (isSqlite) {
        const tablesRes = await query(`SELECT name AS table_name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
        for (const t of tablesRes.rows) {
          try {
            const cnt = await query(`SELECT COUNT(*) AS cnt FROM "${t.table_name}"`);
            t.row_count = cnt.rows[0]?.cnt ?? 0;
          } catch { t.row_count = 0; }
        }
        const allColumns = [];
        for (const t of tablesRes.rows) {
          const cols = await query(`PRAGMA table_info("${t.table_name}")`);
          for (const col of cols.rows) {
            allColumns.push({
              table_name: t.table_name,
              column_name: col.name,
              data_type: col.type || 'TEXT',
              is_nullable: col.notnull ? 'NO' : 'YES',
              column_default: col.dflt_value,
            });
          }
        }
        return { tablesRows: tablesRes.rows, columnsRows: allColumns };
      }
      // PostgreSQL
      const tablesRes = await query(`
        SELECT t.table_name, COALESCE(s.n_live_tup, 0) AS row_count
        FROM information_schema.tables t
        LEFT JOIN pg_stat_user_tables s ON s.relname = t.table_name
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name
      `);
      const columnsRes = await query(`
        SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position
      `);
      return { tablesRows: tablesRes.rows, columnsRows: columnsRes.rows };
    }

    // ── Helper: validate table exists ──
    async function validateTable(name) {
      if (isSqlite) {
        const res = await query(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?`, [name]);
        return res.rows.length > 0;
      }
      const res = await query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name = $1`,
        [name]
      );
      return res.rows.length > 0;
    }

    // ── Helper: validate column exists ──
    async function validateColumn(table, column) {
      if (isSqlite) {
        const cols = await query(`PRAGMA table_info("${table}")`);
        return cols.rows.some(c => c.name === column);
      }
      const res = await query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table, column]
      );
      return res.rows.length > 0;
    }

    // ── List all tables + schema ──
    fastify.get(`${prefix}/tables`, async (request, reply) => {
      try {
        const { tablesRows, columnsRows } = await fetchTablesAndColumns();

        const columnsByTable = {};
        for (const col of columnsRows) {
          if (!columnsByTable[col.table_name]) columnsByTable[col.table_name] = [];
          columnsByTable[col.table_name].push({
            name: col.column_name,
            type: col.data_type,
            nullable: col.is_nullable === 'YES',
            default: col.column_default,
          });
        }

        const tables = tablesRows.map(t => ({
          name: t.table_name,
          rowCount: Number(t.row_count),
          columns: columnsByTable[t.table_name] || [],
          consumers: tableConsumers[t.table_name] || { tabs: [], agents: [], skills: [] },
        }));

        return {
          success: true,
          tables,
          aiEnabled: !!callAI,
          analyzeEnabled: !!chatAI,
          collectEnabled: !!cacheDir,
        };
      } catch (error) {
        request.log.error(error);
        reply.status(500).send({ error: 'שגיאה בטעינת מבנה הדאטהבייס', details: error.message });
      }
    });

    // ── Browse rows of a specific table ──
    fastify.get(`${prefix}/tables/:name/rows`, async (request, reply) => {
      try {
        const { name } = request.params;
        const { limit = '50', offset = '0', sort, dir = 'asc' } = request.query;

        if (!(await validateTable(name))) {
          return reply.status(404).send({ error: 'טבלה לא נמצאה' });
        }

        const lim = Math.min(parseInt(limit) || 50, 200);
        const off = parseInt(offset) || 0;
        const sortDir = dir === 'desc' ? 'DESC' : 'ASC';

        // Validate sort column if provided
        let orderClause = '';
        if (sort && await validateColumn(name, sort)) {
          orderClause = isSqlite
            ? `ORDER BY "${sort}" ${sortDir}`
            : `ORDER BY "${sort}" ${sortDir} NULLS LAST`;
        }

        // Get exact count
        const countRes = await query(`SELECT COUNT(*) AS total FROM "${name}"`);
        const total = Number(countRes.rows[0].total);

        // Get rows
        const rowsRes = await query(
          `SELECT * FROM "${name}" ${orderClause} LIMIT ${lim} OFFSET ${off}`
        );

        return {
          success: true,
          table: name,
          total,
          limit: lim,
          offset: off,
          rows: rowsRes.rows,
        };
      } catch (error) {
        request.log.error(error);
        reply.status(500).send({ error: 'שגיאה בטעינת נתונים', details: error.message });
      }
    });

    // ── CSV Export ──
    fastify.get(`${prefix}/tables/:name/export`, async (request, reply) => {
      try {
        const { name } = request.params;

        if (!(await validateTable(name))) {
          return reply.status(404).send({ error: 'טבלה לא נמצאה' });
        }

        // Get columns
        let columns;
        if (isSqlite) {
          const colsRes = await query(`PRAGMA table_info("${name}")`);
          columns = colsRes.rows.map(r => r.name);
        } else {
          const colsRes = await query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = $1
             ORDER BY ordinal_position`,
            [name]
          );
          columns = colsRes.rows.map(r => r.column_name);
        }

        // Get all rows
        const rowsRes = await query(`SELECT * FROM "${name}"`);

        // Build CSV (RFC 4180)
        const csvEscape = (val) => {
          if (val === null || val === undefined) return '';
          const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
          if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
            return '"' + str.replace(/"/g, '""') + '"';
          }
          return str;
        };

        const headerLine = columns.map(c => csvEscape(c)).join(',');
        const dataLines = rowsRes.rows.map(row =>
          columns.map(c => csvEscape(row[c])).join(',')
        );
        const csv = '\uFEFF' + headerLine + '\n' + dataLines.join('\n');

        const today = new Date().toISOString().slice(0, 10);
        reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="${name}-${today}.csv"`)
          .send(csv);
      } catch (error) {
        request.log.error(error);
        reply.status(500).send({ error: 'שגיאה בייצוא CSV', details: error.message });
      }
    });

    // ── AI Query (natural language → SELECT SQL) ──
    if (callAI) {
      fastify.post(`${prefix}/ai-query`, async (request, reply) => {
        try {
          const { question } = request.body || {};
          if (!question || typeof question !== 'string' || question.trim().length < 2) {
            return reply.status(400).send({ error: 'נדרשת שאלה בת 2 תווים לפחות' });
          }

          // Build dynamic schema
          const { columnsRows } = await fetchTablesAndColumns();

          const schemaByTable = {};
          for (const row of columnsRows) {
            if (!schemaByTable[row.table_name]) schemaByTable[row.table_name] = [];
            schemaByTable[row.table_name].push(`${row.column_name} (${row.data_type})`);
          }

          const schemaText = Object.entries(schemaByTable)
            .map(([table, cols]) => `${table}: ${cols.join(', ')}`)
            .join('\n');

          const dbType = isSqlite ? 'SQLite' : 'PostgreSQL';
          const systemPrompt = `You are a ${dbType} SQL assistant. Given the following database schema, generate a single SELECT query that answers the user's question.

SCHEMA:
${schemaText}

RULES:
- Return ONLY a single SELECT statement, nothing else
- No INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE, or any DDL/DML
- LIMIT results to 200 rows max
- Use double quotes for column/table names with special characters
- Do not wrap in markdown code fences
${isSqlite ? '- Use LIKE instead of ILIKE for case-insensitive matching\n- Use ? for parameters, not $1\n' : ''}- If the question cannot be answered with a SELECT, respond with: ERROR: <reason>`;

          let sql = await callAI(systemPrompt, question);
          sql = (sql || '').trim();

          // Strip markdown fences if present
          sql = sql.replace(/^```(?:sql)?\s*/i, '').replace(/\s*```$/i, '').trim();

          // Check for error responses from AI
          if (sql.startsWith('ERROR:')) {
            return { success: false, error: sql };
          }

          // Safety: block non-SELECT statements
          const forbidden = /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY)\b/i;
          if (forbidden.test(sql)) {
            return { success: false, error: 'רק שאילתות SELECT מותרות', sql };
          }

          // Execute query (PG uses transaction with timeout, SQLite runs directly)
          let result;
          if (isSqlite || !transaction) {
            result = await query(sql);
          } else {
            result = await transaction(async (client) => {
              await client.query(`SET LOCAL statement_timeout = '5000'`);
              return client.query(sql);
            });
          }

          const rows = (result.rows || []).slice(0, 200);
          const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

          return {
            success: true,
            sql,
            columns,
            rows,
            rowCount: rows.length,
          };
        } catch (error) {
          request.log.error(error);
          return {
            success: false,
            error: error.message,
            sql: error.sql || undefined,
          };
        }
      });
    }

    // ── DB Analyze Agent ──
    if (chatAI) {
      fastify.post(`${prefix}/analyze`, async (request, reply) => {
        try {
          const { tablesRows, columnsRows } = await fetchTablesAndColumns();

          // Foreign keys
          let fkRows = [];
          if (isSqlite) {
            for (const t of tablesRows) {
              try {
                const fks = await query(`PRAGMA foreign_key_list("${t.table_name}")`);
                for (const fk of fks.rows) {
                  fkRows.push({
                    source_table: t.table_name, source_column: fk.from,
                    target_table: fk.table, target_column: fk.to,
                    constraint_name: `fk_${t.table_name}_${fk.from}`,
                  });
                }
              } catch { /* skip */ }
            }
          } else {
            const fkRes = await query(`
              SELECT tc.table_name AS source_table, kcu.column_name AS source_column,
                ccu.table_name AS target_table, ccu.column_name AS target_column, tc.constraint_name
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
              JOIN information_schema.constraint_column_usage ccu
                ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
              WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
            `);
            fkRows = fkRes.rows;
          }

          // Indexes
          let indexRows = [];
          if (isSqlite) {
            const idxRes = await query(`SELECT name AS indexname, tbl_name AS tablename, sql AS indexdef FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY tbl_name, name`);
            indexRows = idxRes.rows;
          } else {
            const indexRes = await query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname`);
            indexRows = indexRes.rows;
          }

          const schemaByTable = {};
          for (const row of columnsRows) {
            if (!schemaByTable[row.table_name]) schemaByTable[row.table_name] = [];
            schemaByTable[row.table_name].push(
              `  ${row.column_name} ${row.data_type}${row.is_nullable === 'NO' ? ' NOT NULL' : ''}${row.column_default ? ` DEFAULT ${row.column_default}` : ''}`
            );
          }

          const rowCounts = {};
          for (const t of tablesRows) rowCounts[t.table_name] = Number(t.row_count);

          const schemaText = Object.entries(schemaByTable).map(([table, cols]) =>
            `TABLE ${table} (${rowCounts[table] || 0} rows):\n${cols.join('\n')}`
          ).join('\n\n');

          const fkText = fkRows.length > 0
            ? fkRows.map(fk => `${fk.source_table}.${fk.source_column} → ${fk.target_table}.${fk.target_column} (${fk.constraint_name})`).join('\n')
            : 'No foreign keys defined';

          const indexText = indexRows.map(idx => `${idx.tablename}: ${idx.indexname}`).join('\n');

          const consumersText = Object.entries(tableConsumers).map(([table, c]) =>
            `${table}: tabs=[${c.tabs.join(',')}] agents=[${c.agents.join(',')}] skills=[${c.skills.join(',')}]`
          ).join('\n');

          const systemPrompt = `You are a database optimization expert. Analyze the following ${isSqlite ? 'SQLite' : 'PostgreSQL'} database and provide a comprehensive report in JSON format.

DATABASE SCHEMA:
${schemaText}

FOREIGN KEYS:
${fkText}

INDEXES:
${indexText}

TABLE CONSUMERS (which tabs/agents/skills use each table):
${consumersText}

INSTRUCTIONS:
- Analyze each table's purpose based on its name, columns, and relationships
- Identify tables with overlapping schemas that could be merged
- Identify tables that appear unused (0 rows AND no consumers) or redundant
- Check for missing indexes on foreign key columns
- Look for potential data normalization issues
- Consider the TABLE_CONSUMERS mapping to understand dependencies

Respond ONLY with valid JSON (no markdown fences) in this exact structure:
{
  "summary": "Brief overall assessment of DB health in Hebrew",
  "tables": [
    {
      "name": "table_name",
      "purpose": "What this table stores (Hebrew)",
      "rowCount": 123,
      "status": "ok" | "warning" | "unused" | "redundant",
      "notes": "Any observations (Hebrew)"
    }
  ],
  "merge_suggestions": [
    {
      "tables": ["table_a", "table_b"],
      "reason": "Why these should be merged (Hebrew)",
      "priority": "high" | "medium" | "low"
    }
  ],
  "delete_suggestions": [
    {
      "table": "table_name",
      "reason": "Why this can be deleted (Hebrew)",
      "priority": "high" | "medium" | "low"
    }
  ],
  "optimizations": [
    {
      "type": "index" | "normalization" | "cleanup" | "other",
      "description": "What to do (Hebrew)",
      "priority": "high" | "medium" | "low"
    }
  ]
}`;

          const result = await chatAI(
            [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: 'נתח את מבנה הדאטהבייס ותן המלצות לאיזון וסדר.' },
            ],
            { maxTokens: 4000, temperature: 0.2 }
          );

          const raw = (result.content || '').trim()
            .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

          let analysis;
          try {
            analysis = JSON.parse(raw);
          } catch {
            return { success: false, error: 'תשובת AI לא תקינה', raw };
          }

          return { success: true, analysis };
        } catch (error) {
          request.log.error(error);
          reply.status(500).send({ error: 'שגיאה בניתוח הדאטהבייס', details: error.message });
        }
      });
    }

    // ── Collect DB Context — GET returns cache, POST forces rescan ──
    if (cacheDir) {
      fastify.get(`${prefix}/collect-context`, async (request, reply) => {
        try {
          const cached = await readCache();
          if (cached) {
            return { success: true, fromCache: true, scannedAt: cached.scannedAt, text: cached.text, stats: cached.stats };
          }
          return { success: true, fromCache: false, text: null };
        } catch (error) {
          request.log.error(error);
          reply.status(500).send({ error: 'שגיאה בטעינת cache', details: error.message });
        }
      });

      fastify.post(`${prefix}/collect-context`, async (request, reply) => {
        try {
          // 1+2. Full schema + tables with row counts
          const { tablesRows, columnsRows: schemaRows } = await fetchTablesAndColumns();

          // 3. Foreign keys
          let fkRows = [];
          if (isSqlite) {
            for (const t of tablesRows) {
              try {
                const fks = await query(`PRAGMA foreign_key_list("${t.table_name}")`);
                for (const fk of fks.rows) {
                  fkRows.push({
                    source_table: t.table_name, source_column: fk.from,
                    target_table: fk.table, target_column: fk.to,
                    constraint_name: `fk_${t.table_name}_${fk.from}`,
                  });
                }
              } catch { /* skip */ }
            }
          } else {
            const fkRes = await query(`
              SELECT tc.table_name AS source_table, kcu.column_name AS source_column,
                ccu.table_name AS target_table, ccu.column_name AS target_column, tc.constraint_name
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
              JOIN information_schema.constraint_column_usage ccu
                ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
              WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
            `);
            fkRows = fkRes.rows;
          }

          // 4. Indexes
          let indexRows = [];
          if (isSqlite) {
            const idxRes = await query(`SELECT name AS indexname, tbl_name AS tablename, sql AS indexdef FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY tbl_name, name`);
            indexRows = idxRes.rows;
          } else {
            const indexRes = await query(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname`);
            indexRows = indexRes.rows;
          }

          // 5. Primary keys and unique constraints
          let constraintRows = [];
          if (isSqlite) {
            for (const t of tablesRows) {
              const cols = await query(`PRAGMA table_info("${t.table_name}")`);
              const pkCols = cols.rows.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk);
              if (pkCols.length > 0) {
                constraintRows.push({
                  table_name: t.table_name,
                  constraint_name: `pk_${t.table_name}`,
                  constraint_type: 'PRIMARY KEY',
                  columns: pkCols.map(c => c.name).join(', '),
                });
              }
            }
          } else {
            const constraintRes = await query(`
              SELECT tc.table_name, tc.constraint_name, tc.constraint_type,
                STRING_AGG(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS columns
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
              WHERE tc.table_schema = 'public' AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
              GROUP BY tc.table_name, tc.constraint_name, tc.constraint_type
              ORDER BY tc.table_name
            `);
            constraintRows = constraintRes.rows;
          }

          // 6. Read migration files
          const migrationsDir = projectRoot ? join(projectRoot, 'migrations') : null;
          let migrations = [];
          if (migrationsDir) {
            try {
              const files = await readdir(migrationsDir);
              const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();
              for (const file of sqlFiles) {
                const content = await readFile(join(migrationsDir, file), 'utf-8');
                migrations.push({ file, content });
              }
            } catch { /* migrations dir not found */ }
          }

          // 7. Sample data (first 3 rows per table)
          const sampleData = {};
          for (const t of tablesRows) {
            if (Number(t.row_count) > 0) {
              try {
                const sampleRes = await query(`SELECT * FROM "${t.table_name}" LIMIT 3`);
                sampleData[t.table_name] = sampleRes.rows;
              } catch { /* skip */ }
            }
          }

          // 8. Dynamic consumer detection — scan project files for table references
          const allTableNames = tablesRows.map(t => t.table_name);
          const detectedConsumers = await detectAllConsumers(allTableNames);

          // ── Build structured text ──
          const lines = [];
          const scannedAt = new Date().toISOString();
          lines.push(`# Database Context — ${projectName || 'Project'}`);
          lines.push(`# Scanned: ${scannedAt}`);
          lines.push('');

          // Summary
          const totalRows = tablesRows.reduce((s, t) => s + Number(t.row_count), 0);
          lines.push(`## Summary`);
          lines.push(`Tables: ${tablesRows.length}`);
          lines.push(`Total rows: ${totalRows}`);
          lines.push('');

          // Schema per table
          const schemaByTable = {};
          for (const row of schemaRows) {
            if (!schemaByTable[row.table_name]) schemaByTable[row.table_name] = [];
            schemaByTable[row.table_name].push(row);
          }

          const rowCounts = {};
          for (const t of tablesRows) rowCounts[t.table_name] = Number(t.row_count);

          // Constraints by table
          const constraintsByTable = {};
          for (const c of constraintRows) {
            if (!constraintsByTable[c.table_name]) constraintsByTable[c.table_name] = [];
            constraintsByTable[c.table_name].push(c);
          }

          lines.push('## Tables');
          lines.push('');

          for (const [table, cols] of Object.entries(schemaByTable)) {
            const detected = detectedConsumers[table] || { tabs: [], agents: [], routes: [], services: [] };
            const sources = tableSources[table];
            lines.push(`### ${table} (${rowCounts[table] || 0} rows)`);

            // Constraints
            const tableConstraints = constraintsByTable[table] || [];
            for (const c of tableConstraints) {
              lines.push(`${c.constraint_type}: ${c.columns}`);
            }

            lines.push('');

            // ── Consumers — detected from file scan ──
            if (scanFiles.length > 0) {
              lines.push(`#### צרכנים — מי קורא/משתמש בטבלה (זוהה אוטומטית מסריקת קבצים)`);
              const hasTabs = detected.tabs.length > 0;
              const hasAgents = detected.agents.length > 0;
              const hasRoutes = detected.routes.length > 0;
              const hasServices = detected.services.length > 0;
              if (!hasTabs && !hasAgents && !hasRoutes && !hasServices) {
                lines.push('- לא נמצאו הפניות בקוד');
              } else {
                if (hasTabs)     lines.push(`- **טאבים:** ${detected.tabs.join(', ')}`);
                if (hasAgents)   lines.push(`- **אייג'נטים:** ${detected.agents.join(', ')}`);
                if (hasRoutes)   lines.push(`- **ראוטים/ריפוזיטוריז:** ${detected.routes.join(', ')}`);
                if (hasServices) lines.push(`- **שירותים/מערכת:** ${detected.services.join(', ')}`);
              }
              lines.push('');
            }

            // ── Sources (who writes/feeds) ──
            if (sources && sources.length > 0) {
              lines.push(`#### מקורות — מי מזין/כותב לטבלה`);
              for (const src of sources) {
                const typeLabel = { route: 'ראוט', agent: 'אייג\'נט', adapter: 'אדפטר', repository: 'ריפוזיטורי', system: 'מערכת' }[src.type] || src.type;
                lines.push(`- **[${typeLabel}]** ${src.name}`);
                lines.push(`  קובץ: \`${src.file}\``);
                lines.push(`  פעולות: ${src.ops}`);
              }
              lines.push('');
            }

            // ── Schema ──
            lines.push(`#### מבנה`);
            lines.push('| Column | Type | Nullable | Default |');
            lines.push('|--------|------|----------|---------|');
            for (const col of cols) {
              lines.push(`| ${col.column_name} | ${col.data_type} | ${col.is_nullable === 'YES' ? 'YES' : 'NO'} | ${col.column_default || '—'} |`);
            }
            lines.push('');

            // ── Sample data ──
            if (sampleData[table] && sampleData[table].length > 0) {
              const sampleCols = Object.keys(sampleData[table][0]);
              lines.push(`#### דוגמת נתונים (${sampleData[table].length} rows)`);
              lines.push('| ' + sampleCols.join(' | ') + ' |');
              lines.push('| ' + sampleCols.map(() => '---').join(' | ') + ' |');
              for (const row of sampleData[table]) {
                const vals = sampleCols.map(c => {
                  const v = row[c];
                  if (v === null) return 'NULL';
                  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
                  return s.length > 60 ? s.slice(0, 57) + '...' : s;
                });
                lines.push('| ' + vals.join(' | ') + ' |');
              }
              lines.push('');
            }

            lines.push('---');
            lines.push('');
          }

          // ── Foreign keys ──
          if (fkRows.length > 0) {
            lines.push('## Foreign Keys');
            lines.push('');
            for (const fk of fkRows) {
              lines.push(`- ${fk.source_table}.${fk.source_column} → ${fk.target_table}.${fk.target_column} (${fk.constraint_name})`);
            }
            lines.push('');
          }

          // ── Indexes ──
          if (indexRows.length > 0) {
            lines.push('## Indexes');
            lines.push('');
            for (const idx of indexRows) {
              lines.push(`- ${idx.tablename}: ${idx.indexname}`);
              lines.push(`  ${idx.indexdef || ''}`);
            }
            lines.push('');
          }

          // ── Consumers summary — auto-detected ──
          if (scanFiles.length > 0) {
            lines.push('## סיכום צרכנים — זוהה אוטומטית מסריקת קבצים');
            lines.push('');
            lines.push('| טבלה | טאבים | אייג\'נטים | ראוטים | שירותים |');
            lines.push('|------|-------|-----------|--------|---------|');
            for (const t of allTableNames) {
              const d = detectedConsumers[t] || { tabs: [], agents: [], routes: [], services: [] };
              lines.push(`| ${t} | ${d.tabs.join(', ') || '—'} | ${d.agents.join(', ') || '—'} | ${d.routes.join(', ') || '—'} | ${d.services.join(', ') || '—'} |`);
            }
            lines.push('');
          }

          // ── Sources summary (static mapping) ──
          if (Object.keys(tableSources).length > 0) {
            lines.push('## סיכום מקורות — מי מזין כל טבלה');
            lines.push('');
            for (const [table, srcs] of Object.entries(tableSources)) {
              lines.push(`### ${table}`);
              for (const src of srcs) {
                const typeLabel = { route: 'ראוט (API)', agent: 'אייג\'נט (AI)', adapter: 'אדפטר (Sync)', repository: 'ריפוזיטורי (CRUD)', system: 'מערכת' }[src.type] || src.type;
                lines.push(`- **${typeLabel}** — ${src.name}`);
                lines.push(`  קובץ: \`${src.file}\``);
                lines.push(`  פעולות: ${src.ops}`);
              }
              lines.push('');
            }
          }

          // ── Migrations ──
          if (migrations.length > 0) {
            lines.push('## Migration Files');
            lines.push('');
            for (const m of migrations) {
              lines.push(`### ${m.file}`);
              lines.push('```sql');
              lines.push(m.content.trim());
              lines.push('```');
              lines.push('');
            }
          }

          const text = lines.join('\n');
          const stats = {
            tables: tablesRows.length,
            totalRows,
            foreignKeys: fkRows.length,
            indexes: indexRows.length,
            migrations: migrations.length,
          };

          // ── Save to cache ──
          await writeCache({ scannedAt, text, stats });

          return { success: true, fromCache: false, scannedAt, text, stats };
        } catch (error) {
          request.log.error(error);
          reply.status(500).send({ error: 'שגיאה באיסוף מידע', details: error.message });
        }
      });
    }

    // ── Global Search ──
    fastify.get(`${prefix}/search`, async (request, reply) => {
      try {
        const { q, limit = '5' } = request.query;
        if (!q || q.trim().length < 2) {
          return reply.status(400).send({ error: 'נדרש מונח חיפוש בן 2 תווים לפחות' });
        }

        const searchTerm = `%${q.trim()}%`;
        const perTableLimit = Math.min(parseInt(limit) || 5, 20);

        // Get all text/varchar/uuid columns per table
        let colsRows;
        if (isSqlite) {
          const { tablesRows, columnsRows } = await fetchTablesAndColumns();
          colsRows = columnsRows.filter(c =>
            /text|varchar|char|clob/i.test(c.data_type)
          );
        } else {
          const colsRes = await query(`
            SELECT table_name, column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND data_type IN ('text', 'character varying', 'uuid', 'character')
            ORDER BY table_name, ordinal_position
          `);
          colsRows = colsRes.rows;
        }

        const tableColumns = {};
        for (const row of colsRows) {
          if (!tableColumns[row.table_name]) tableColumns[row.table_name] = [];
          tableColumns[row.table_name].push(row.column_name);
        }

        const results = [];

        for (const [table, columns] of Object.entries(tableColumns)) {
          if (columns.length === 0) continue;
          try {
            const likeOp = isSqlite ? 'LIKE' : 'ILIKE';
            const param = isSqlite ? '?' : '$1';
            const castExpr = (c) => isSqlite ? `"${c}"` : `"${c}"::text`;
            const whereClauses = columns.map(c => `${castExpr(c)} ${likeOp} ${param}`).join(' OR ');
            const paramArr = isSqlite ? columns.map(() => searchTerm) : [searchTerm];
            const tableRes = await query(
              `SELECT * FROM "${table}" WHERE ${whereClauses} LIMIT ${perTableLimit}`,
              paramArr
            );

            if (tableRes.rows.length > 0) {
              const matchedColumns = [];
              for (const col of columns) {
                const lowerQ = q.trim().toLowerCase();
                for (const row of tableRes.rows) {
                  if (row[col] && String(row[col]).toLowerCase().includes(lowerQ)) {
                    matchedColumns.push(col);
                    break;
                  }
                }
              }

              const countRes = await query(
                `SELECT COUNT(*) AS cnt FROM "${table}" WHERE ${whereClauses}`,
                paramArr
              );

              results.push({
                table,
                matchedColumns,
                matchCount: Number(countRes.rows[0].cnt),
                rows: tableRes.rows,
              });
            }
          } catch {
            // Skip tables that cause errors
          }
        }

        return { success: true, results, query: q.trim() };
      } catch (error) {
        request.log.error(error);
        reply.status(500).send({ error: 'שגיאה בחיפוש', details: error.message });
      }
    });
  };
}
