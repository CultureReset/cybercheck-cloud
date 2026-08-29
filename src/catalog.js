// The catalog: publishing an app, and reading the index.
//
// Publishing is the only path by which a manifest enters the platform, and it
// is a one-way door — a published version is immutable. Fixing a mistake means
// publishing 1.0.1, which is the same thing every other package registry
// learned to do the hard way.

import { q, one, tx } from './db.js';
import { validate, normalise } from './manifest.js';
import { badRequest, conflict, notFound } from './errors.js';
import { provisionTables } from './appdata.js';
import { config } from './config.js';

export async function knownPermissions() {
  return new Set((await q('select id from platform.permissions')).map(r => r.id));
}

export async function ensureStore({ slug, name, kind = 'local', url = null, publicKey = null }) {
  const existing = await one('select * from platform.stores where slug = $1', [slug]);
  if (existing) return existing;
  return one(
    `insert into platform.stores (slug, name, kind, url, public_key)
     values ($1, $2, $3, $4, $5) returning *`,
    [slug, name, kind, url, publicKey]
  );
}

export async function listStores() {
  return q('select id, slug, name, kind, url, enabled, added_at from platform.stores order by added_at');
}

export async function publish({ manifest, storeSlug = config.defaultStore.slug, channel = 'stable' }) {
  validate(manifest, { knownPermissions: await knownPermissions() });
  const normalised = normalise(manifest);

  const store = await one('select * from platform.stores where slug = $1', [storeSlug]);
  if (!store) throw notFound(`no such store: ${storeSlug}`);

  const published = await tx(async db => {
    const app = await upsertApp(db, store.id, normalised.app);

    const clash = await db.one(
      `select id from platform.app_versions where app_row_id = $1 and version = $2`,
      [app.id, normalised.version.version]
    );
    if (clash) throw conflict(`${manifest.id}@${manifest.version} is already published`);

    const version = await db.one(
      `insert into platform.app_versions (app_row_id, version, manifest, content_hash)
       values ($1, $2, $3, $4) returning *`,
      [app.id, normalised.version.version, JSON.stringify(manifest), normalised.version.content_hash]
    );

    await deriveRows(db, version.id, normalised);

    await db.one(
      `insert into platform.releases (app_row_id, channel, app_version_id)
       values ($1, $2, $3)
       on conflict (app_row_id, channel)
         do update set app_version_id = excluded.app_version_id, released_at = now()
       returning *`,
      [app.id, channel, version.id]
    );

    return { app, version };
  });

  // Tables belong to the app, not to one installation, so they are provisioned
  // once at publish rather than N times at install.
  if (Object.keys(normalised.tables).length) {
    await provisionTables({
      appRowId: published.app.id,
      namespace: normalised.app.data_namespace,
      tables: normalised.tables,
    });
  }

  return { appId: manifest.id, version: manifest.version, contentHash: normalised.version.content_hash };
}

async function upsertApp(db, storeId, app) {
  const existing = await db.one(
    'select * from platform.apps where store_id = $1 and app_id = $2', [storeId, app.app_id]
  );
  if (existing) {
    // The namespace is where an app's data lives. Moving it between versions
    // would orphan every row already written.
    if (existing.data_namespace && app.data_namespace && existing.data_namespace !== app.data_namespace) {
      throw conflict(
        `${app.app_id} already owns namespace "${existing.data_namespace}" and cannot change it to "${app.data_namespace}"`
      );
    }
    return db.one(
      `update platform.apps set name = $2, summary = $3, icon = $4, categories = $5,
              data_namespace = coalesce(data_namespace, $6)
       where id = $1 returning *`,
      [existing.id, app.name, app.summary, app.icon, JSON.stringify(app.categories), app.data_namespace]
    );
  }
  return db.one(
    `insert into platform.apps (store_id, app_id, publisher, name, summary, icon, categories, data_namespace)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
    [storeId, app.app_id, app.publisher, app.name, app.summary, app.icon,
     JSON.stringify(app.categories), app.data_namespace]
  );
}

async function deriveRows(db, versionId, n) {
  for (const p of n.permissions) {
    await db.q(
      `insert into platform.app_declared_permissions (app_version_id, permission_id, reason, optional)
       values ($1, $2, $3, $4)`,
      [versionId, p.permission_id, p.reason, p.optional]
    );
  }
  for (const s of n.surfaces) {
    await db.q(
      `insert into platform.app_declared_surfaces
         (app_version_id, surface_id, kind, title, icon, path, display_modes, requires_permission)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [versionId, s.surface_id, s.kind, s.title, s.icon, s.path,
       JSON.stringify(s.display_modes), s.requires_permission]
    );
  }
  for (const c of n.capabilities) {
    await db.q(
      `insert into platform.app_declared_capabilities (app_version_id, capability_id, direction, summary, path)
       values ($1, $2, $3, $4, $5)`,
      [versionId, c.capability_id, c.direction, c.summary, c.path]
    );
  }
  for (const e of n.events) {
    await db.q(
      `insert into platform.app_declared_events (app_version_id, event_id, direction, path)
       values ($1, $2, $3, $4)`,
      [versionId, e.event_id, e.direction, e.path]
    );
  }
  await db.q(
    `insert into platform.app_pricing (app_version_id, model, amount, currency, interval)
     values ($1, $2, $3, $4, $5)`,
    [versionId, n.pricing.model, n.pricing.amount ?? null, n.pricing.currency ?? null, n.pricing.interval ?? null]
  );
}

// The registry index. Flat, derived, and safe to render: every field here came
// out of a column, not out of a manifest.
export async function index({ workspaceId = null, category = null, search = null } = {}) {
  const rows = await q(
    `select a.app_id, a.publisher, a.name, a.summary, a.icon, a.categories,
            v.version, v.content_hash, r.channel,
            s.slug as store, s.name as store_name,
            p.model as pricing_model, p.amount as pricing_amount, p.currency as pricing_currency,
            (v.manifest -> 'runtime' ->> 'type') as runtime_type,
            (select count(*) from platform.app_declared_permissions dp where dp.app_version_id = v.id) as permission_count,
            (select coalesce(json_agg(distinct ds.kind), '[]'::json)
               from platform.app_declared_surfaces ds where ds.app_version_id = v.id) as surface_kinds,
            (select i.id from platform.installations i
              where i.app_row_id = a.id and i.workspace_id = $1 and i.status <> 'uninstalled') as installation_id
       from platform.releases r
       join platform.apps a on a.id = r.app_row_id
       join platform.app_versions v on v.id = r.app_version_id
       join platform.stores s on s.id = a.store_id
       left join platform.app_pricing p on p.app_version_id = v.id
      where r.channel = 'stable' and s.enabled
        and ($2::text is null or a.categories ? $2)
        and ($3::text is null or a.name ilike '%' || $3 || '%' or coalesce(a.summary,'') ilike '%' || $3 || '%')
      order by a.name`,
    [workspaceId, category, search]
  );
  return rows.map(toIndexEntry);
}

export async function detail(appId, { workspaceId = null } = {}) {
  const row = await one(
    `select a.id as app_row_id, a.app_id, a.publisher, a.name, a.summary, a.icon, a.categories,
            v.id as version_id, v.version, v.content_hash, v.manifest,
            s.slug as store,
            p.model as pricing_model, p.amount as pricing_amount, p.currency as pricing_currency,
            (v.manifest -> 'runtime' ->> 'type') as runtime_type,
            (select i.id from platform.installations i
              where i.app_row_id = a.id and i.workspace_id = $2 and i.status <> 'uninstalled') as installation_id
       from platform.releases r
       join platform.apps a on a.id = r.app_row_id
       join platform.app_versions v on v.id = r.app_version_id
       join platform.stores s on s.id = a.store_id
       left join platform.app_pricing p on p.app_version_id = v.id
      where a.app_id = $1 and r.channel = 'stable'`,
    [appId, workspaceId]
  );
  if (!row) throw notFound(`no such app: ${appId}`);

  const [permissions, surfaces, capabilities] = await Promise.all([
    q(`select dp.permission_id, dp.reason, dp.optional, pm.title, pm.description, pm.sensitive
         from platform.app_declared_permissions dp
         join platform.permissions pm on pm.id = dp.permission_id
        where dp.app_version_id = $1 order by pm.sensitive desc, dp.permission_id`, [row.version_id]),
    q(`select surface_id, kind, title, icon, path, display_modes, requires_permission
         from platform.app_declared_surfaces where app_version_id = $1 order by kind`, [row.version_id]),
    q(`select capability_id, direction, summary from platform.app_declared_capabilities
        where app_version_id = $1`, [row.version_id]),
  ]);

  return {
    ...toIndexEntry(row),
    versionId: row.version_id,
    description: row.manifest.description ?? null,
    homepage: row.manifest.homepage ?? null,
    permissions,
    surfaces,
    capabilities,
    config: row.manifest.config ?? [],
  };
}

export async function versionFor(appId, { channel = 'stable' } = {}) {
  const row = await one(
    `select a.id as app_row_id, a.app_id, a.data_namespace, v.id as version_id, v.version, v.manifest
       from platform.releases r
       join platform.apps a on a.id = r.app_row_id
       join platform.app_versions v on v.id = r.app_version_id
      where a.app_id = $1 and r.channel = $2`,
    [appId, channel]
  );
  if (!row) throw notFound(`no such app: ${appId}`);
  return row;
}

function toIndexEntry(row) {
  return {
    id: row.app_id,
    name: row.name,
    publisher: row.publisher,
    summary: row.summary,
    icon: row.icon,
    categories: row.categories ?? [],
    version: row.version,
    contentHash: row.content_hash,
    store: row.store,
    runtime: row.runtime_type,
    surfaceKinds: row.surface_kinds ?? [],
    permissionCount: Number(row.permission_count ?? 0),
    pricing: row.pricing_model
      ? { model: row.pricing_model, amount: row.pricing_amount, currency: row.pricing_currency }
      : { model: 'free' },
    installed: Boolean(row.installation_id),
    installationId: row.installation_id ?? null,
  };
}
