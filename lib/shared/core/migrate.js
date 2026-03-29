// shared-dashboard/lib/core/migrate.js
// Shared migration runner
//
// Usage from project scripts/migrate.js:
//   import { runMigrations } from 'shared-dashboard/core/migrate';
//   import { fileURLToPath } from 'url';
//   import { dirname, join } from 'path';
//   const __dirname = dirname(fileURLToPath(import.meta.url));
//   runMigrations(join(__dirname, '..', 'migrations'));

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import pg from 'pg';

export async function runMigrations(migrationsDir) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: url,
    ssl: process.env.DATABASE_SSL !== '0' ? { rejectUnauthorized: false } : false,
  });

  await client.connect();
  console.log('Connected to database');

  // Track applied migrations
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const applied = await client.query('SELECT name FROM _migrations ORDER BY name');
  const appliedSet = new Set(applied.rows.map(r => r.name));

  // Read and sort migration files
  const files = (await readdir(migrationsDir))
    .filter(f => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`  skip: ${file} (already applied)`);
      continue;
    }

    const sql = await readFile(join(migrationsDir, file), 'utf-8');
    console.log(`  applying: ${file} ...`);
    await client.query(sql);
    await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
    count++;
    console.log(`  done: ${file}`);
  }

  console.log(`\nMigrations complete: ${count} applied, ${appliedSet.size} skipped`);
  await client.end();
}
