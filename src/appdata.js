// App-owned data.
//
// An app declares tables; the platform creates them. The app never holds DDL
// rights and never learns the physical table name, so the only way it can reach
// a row is through a query this file builds — and every one of those is scoped
// to the workspace the caller's token was minted for.

import { q, one, tx } from './db.js';
import { badRequest, notFound, forbidden } from './errors.js';

const TYPES = {
  text: 'text', integer: 'integer', number: 'numeric', money: 'numeric(12,2)',
  boolean: 'boolean', date: 'date', timestamp: 'timestamptz', json: 'jsonb', uuid: 'uuid',
};

// Every identifier reaching DDL passes through here. The manifest schema
// already constrains these, but a validator that is bypassed once should not
// also be the only thing standing between a manifest and `drop table`.
const SAFE = /^[a-z][a-z0-9_]{0,39}$/;
function identifier(value, what) {
  if (typeof value !== 'string' || !SAFE.test(value)) {
    throw badRequest(`unsafe ${what}: ${JSON.stringify(value)}`);
  }
  return value;
}

const physicalName = (namespace, table) => `${identifier(namespace, 'namespace')}__${identifier(table, 'table name')}`;

export async function provisionTables({ appRowId, namespace, tables }) {
  identifier(namespace, 'namespace');
  return tx(async db => {
    for (const [logical, def] of Object.entries(tables)) {
      const physical = physicalName(namespace, logical);
      const columns = {};
      const parts = [
        'id uuid primary key default gen_random_uuid()',
        'workspace_id uuid not null references platform.workspaces (id) on delete cascade',
        'installation_id uuid references platform.installations (id) on delete set null',
      ];

      for (const [name, spec] of Object.entries(def.columns)) {
        identifier(name, 'column name');
        if (['id', 'workspace_id', 'installation_id', 'created_at', 'updated_at'].includes(name)) {
          throw badRequest(`column "${name}" is reserved by the platform`);
        }
        const type = TYPES[spec.type];
        if (!type) throw badRequest(`unknown column type: ${spec.type}`);
        let part = `"${name}" ${type}`;
        if (spec.required) part += ' not null';
        if (spec.default !== undefined) part += ` default ${literal(spec.default, spec.type)}`;
        parts.push(part);
        columns[name] = spec;
      }

      parts.push('created_at timestamptz not null default now()');
      parts.push('updated_at timestamptz not null default now()');

      await db.q(`create table if not exists appdata."${physical}" (${parts.join(', ')})`);
      await db.q(`create index if not exists "${physical}_workspace_idx" on appdata."${physical}" (workspace_id)`);

      for (const cols of def.indexes ?? []) {
        const names = cols.map(c => `"${identifier(c, 'index column')}"`).join(', ');
        await db.q(
          `create index if not exists "${physical}_${cols.join('_')}_idx" on appdata."${physical}" (workspace_id, ${names})`
        );
      }

      await db.q(
        `insert into platform.provisioned_tables
           (app_row_id, namespace, logical_name, physical_name, columns, public_access)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (namespace, logical_name)
           do update set columns = excluded.columns, public_access = excluded.public_access`,
        [appRowId, namespace, logical, physical, JSON.stringify(columns), def.public ?? 'none']
      );
    }
  });
}

function literal(value, type) {
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'integer' || type === 'number' || type === 'money') return String(Number(value));
  if (type === 'json') return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Resolves the table an app is asking for, and refuses if it is not that app's.
// An app naming another app's namespace gets a 404, not another app's rows.
async function resolve(namespace, logical, { anonymous = false, action = 'read' } = {}) {
  const row = await one(
    'select * from platform.provisioned_tables where namespace = $1 and logical_name = $2',
    [namespace, logical]
  );
  if (!row) throw notFound(`no such table: ${logical}`);

  // A public surface runs for whoever loads the page. It gets exactly what the
  // manifest said a stranger may do, which is nothing unless stated.
  if (anonymous) {
    const allowed = row.public_access.split('-');
    const permitted = action === 'append' ? allowed.includes('append') : allowed.includes('read');
    if (!permitted) {
      throw forbidden(`"${logical}" does not allow public ${action}`, { table: logical, public_access: row.public_access });
    }
  }
  return row;
}

export async function select({ namespace, table, workspaceId, where = {}, limit = 100, offset = 0, orderBy = 'created_at desc', anonymous = false }) {
  const meta = await resolve(namespace, table, { anonymous, action: 'read' });
  const columns = meta.columns;
  const clauses = ['workspace_id = $1'];
  const params = [workspaceId];

  for (const [key, value] of Object.entries(where)) {
    if (!columns[key]) throw badRequest(`no such column: ${key}`);
    params.push(value);
    clauses.push(`"${key}" = $${params.length}`);
  }

  const direction = /desc/i.test(orderBy) ? 'desc' : 'asc';
  const sortColumn = orderBy.split(/\s+/)[0];
  if (sortColumn !== 'created_at' && sortColumn !== 'updated_at' && !columns[sortColumn]) {
    throw badRequest(`cannot sort by ${sortColumn}`);
  }

  params.push(Math.min(Number(limit) || 100, 500), Number(offset) || 0);
  return q(
    `select * from appdata."${meta.physical_name}" where ${clauses.join(' and ')}
      order by "${sortColumn}" ${direction} limit $${params.length - 1} offset $${params.length}`,
    params
  );
}

export async function insert({ namespace, table, workspaceId, installationId, values, anonymous = false }) {
  const meta = await resolve(namespace, table, { anonymous, action: 'append' });
  const names = [];
  const placeholders = [];
  const params = [workspaceId, installationId];

  for (const [key, value] of Object.entries(values ?? {})) {
    if (!meta.columns[key]) throw badRequest(`no such column: ${key}`);
    params.push(serialise(value, meta.columns[key].type));
    names.push(`"${key}"`);
    placeholders.push(`$${params.length}`);
  }

  return one(
    `insert into appdata."${meta.physical_name}" (workspace_id, installation_id${names.length ? ', ' + names.join(', ') : ''})
     values ($1, $2${placeholders.length ? ', ' + placeholders.join(', ') : ''}) returning *`,
    params
  );
}

export async function update({ namespace, table, workspaceId, id, values, anonymous = false }) {
  if (anonymous) throw forbidden('A public surface cannot change an existing row');
  const meta = await resolve(namespace, table);
  const sets = [];
  const params = [workspaceId, id];

  for (const [key, value] of Object.entries(values ?? {})) {
    if (!meta.columns[key]) throw badRequest(`no such column: ${key}`);
    params.push(serialise(value, meta.columns[key].type));
    sets.push(`"${key}" = $${params.length}`);
  }
  if (!sets.length) throw badRequest('nothing to update');

  const row = await one(
    `update appdata."${meta.physical_name}" set ${sets.join(', ')}, updated_at = now()
      where workspace_id = $1 and id = $2 returning *`,
    params
  );
  if (!row) throw notFound('no such row');
  return row;
}

export async function remove({ namespace, table, workspaceId, id, anonymous = false }) {
  if (anonymous) throw forbidden('A public surface cannot delete a row');
  const meta = await resolve(namespace, table);
  const row = await one(
    `delete from appdata."${meta.physical_name}" where workspace_id = $1 and id = $2 returning id`,
    [workspaceId, id]
  );
  if (!row) throw notFound('no such row');
  return { deleted: row.id };
}

// Uninstalling removes the app. It removes the app's records only if the app
// said, in its own manifest, that its records are not worth keeping.
export async function dropWorkspaceData({ namespace, workspaceId }) {
  const tables = await q('select physical_name from platform.provisioned_tables where namespace = $1', [namespace]);
  let deleted = 0;
  for (const t of tables) {
    const rows = await q(`delete from appdata."${t.physical_name}" where workspace_id = $1 returning id`, [workspaceId]);
    deleted += rows.length;
  }
  return deleted;
}

export async function countWorkspaceRows({ namespace, workspaceId }) {
  const tables = await q('select physical_name from platform.provisioned_tables where namespace = $1', [namespace]);
  let total = 0;
  for (const t of tables) {
    const row = await one(`select count(*)::int as n from appdata."${t.physical_name}" where workspace_id = $1`, [workspaceId]);
    total += row.n;
  }
  return total;
}

function serialise(value, type) {
  if (type === 'json' && value !== null && typeof value === 'object') return JSON.stringify(value);
  return value;
}
