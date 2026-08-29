// The one place SQL is executed.
//
// Postgres only, no in-memory substitute. Every boundary in this platform is a
// constraint in db/*.sql — a fake database that ignores them would make the
// tests agree with themselves and disagree with production.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(HERE, '..', 'db');

let pool = null;

export async function connect({ url = process.env.DATABASE_URL, migrate: shouldMigrate = true } = {}) {
  if (!url) throw new Error('DATABASE_URL is not set. See platform/README.md.');
  pool = new pg.Pool({ connectionString: url, max: 10 });
  await pool.query('select 1');
  if (shouldMigrate) await migrate();
  return pool;
}

// Applied in filename order, once each, recorded so a restart is a no-op.
export async function migrate(dir = MIGRATIONS_DIR) {
  await pool.query(`
    create table if not exists public.schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )`);
  const applied = new Set(
    (await pool.query('select filename from public.schema_migrations')).rows.map(r => r.filename)
  );
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into public.schema_migrations (filename) values ($1)', [file]);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw new Error(`migration ${file} failed: ${e.message}`);
    } finally {
      client.release();
    }
  }
}

function ready() {
  if (!pool) throw new Error('db.connect() has not been called');
  return pool;
}

export async function q(sql, params = []) {
  const result = await ready().query(sql, params);
  return result.rows;
}

export async function one(sql, params = []) {
  const rows = await q(sql, params);
  return rows[0] ?? null;
}

// Installing an app writes to six tables and provisions schema. Half of that
// having happened is not a state the platform knows how to be in.
export async function tx(fn) {
  const client = await ready().connect();
  try {
    await client.query('begin');
    const result = await fn({
      q: async (sql, params = []) => (await client.query(sql, params)).rows,
      one: async (sql, params = []) => (await client.query(sql, params)).rows[0] ?? null,
    });
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

export async function close() {
  if (pool) await pool.end();
  pool = null;
}

export async function reset() {
  await ready().query('drop schema if exists platform cascade');
  await ready().query('drop schema if exists appdata cascade');
  await ready().query('drop table if exists public.schema_migrations');
  await migrate();
}
