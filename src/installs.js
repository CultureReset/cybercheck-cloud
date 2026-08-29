// Installing, and the four states people confuse for each other.
//
//   installed   the app exists in this workspace
//   enabled     it is allowed to run
//   published   one of its public surfaces is on the customer-facing page
//   data        the owner's records, which outlive all three
//
// Collapsing any two of these is how a platform ends up deleting a customer's
// records because they hid a card.

import { q, one, tx } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { versionFor } from './catalog.js';
import { dropWorkspaceData, countWorkspaceRows } from './appdata.js';
import { hash, randomToken } from './tokens.js';
import { record } from './audit.js';

export async function install({ workspaceId, appId, userId, grants = [], surfaces = null, settings = {} }) {
  const target = await versionFor(appId);
  const declared = await declarationsFor(target.version_id);

  const requested = new Set(grants);
  const missing = declared.permissions
    .filter(p => !p.optional && !requested.has(p.permission_id))
    .map(p => p.permission_id);
  if (missing.length) {
    throw badRequest('This app cannot run without every required permission', missing);
  }
  const undeclared = [...requested].filter(g => !declared.permissions.some(p => p.permission_id === g));
  if (undeclared.length) {
    // Granting a permission the app never asked for would make the consent
    // screen a lie in the other direction.
    throw badRequest('Cannot grant a permission this app did not request', undeclared);
  }

  const clientSecret = target.manifest.runtime.type === 'service' ? randomToken() : null;

  const installation = await tx(async db => {
    const live = await db.one(
      `select id, status from platform.installations
        where workspace_id = $1 and app_row_id = $2 and status <> 'uninstalled'`,
      [workspaceId, target.app_row_id]
    );
    if (live) throw conflict(`${appId} is already installed in this workspace`);

    const row = await db.one(
      `insert into platform.installations
         (workspace_id, app_row_id, app_version_id, pinned_manifest, status, settings,
          client_secret_hash, installed_by, installed_at)
       values ($1, $2, $3, $4, 'installed', $5, $6, $7, now()) returning *`,
      [workspaceId, target.app_row_id, target.version_id, JSON.stringify(target.manifest),
       JSON.stringify(settings), clientSecret ? hash(clientSecret) : null, userId]
    );

    for (const permission of requested) {
      await db.q(
        `insert into platform.installation_permissions (installation_id, permission_id, granted_by)
         values ($1, $2, $3)`,
        [row.id, permission, userId]
      );
    }

    const chosen = surfaces
      ? declared.surfaces.filter(s => surfaces.includes(s.surface_id))
      : declared.surfaces;
    for (const [position, surface] of chosen.entries()) {
      await db.q(
        `insert into platform.installation_surfaces
           (installation_id, surface_id, kind, title, path, display_mode, position)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [row.id, surface.surface_id, surface.kind, surface.title, surface.path,
         (surface.display_modes ?? ['page'])[0], position]
      );
    }
    return row;
  });

  await record({ workspaceId, installationId: installation.id, userId, action: 'app.installed',
                 detail: { appId, version: target.version, permissions: [...requested] } });

  return { installationId: installation.id, appId, version: target.version, clientSecret };
}

export async function uninstall({ workspaceId, installationId, userId, deleteData = false }) {
  const installation = await requireInstallation(workspaceId, installationId);
  const manifest = installation.pinned_manifest;
  const namespace = manifest.data?.namespace ?? null;

  // The manifest's own answer wins unless the owner explicitly overrides it,
  // and either way the choice is recorded.
  const shouldDelete = deleteData || manifest.data?.delete_on_uninstall === true;
  let deletedRows = 0;
  if (namespace && shouldDelete) {
    deletedRows = await dropWorkspaceData({ namespace, workspaceId });
  }

  await q(
    `update platform.installations
        set status = 'uninstalled', enabled = false, uninstalled_at = now()
      where id = $1`,
    [installationId]
  );
  await q(
    `update platform.installation_permissions set revoked_at = now()
      where installation_id = $1 and revoked_at is null`,
    [installationId]
  );

  const retained = namespace && !shouldDelete ? await countWorkspaceRows({ namespace, workspaceId }) : 0;

  await record({ workspaceId, installationId, userId, action: 'app.uninstalled',
                 detail: { appId: manifest.id, deletedRows, retainedRows: retained } });

  return { uninstalled: true, deletedRows, retainedRows: retained };
}

export async function setEnabled({ workspaceId, installationId, userId, enabled }) {
  await requireInstallation(workspaceId, installationId);
  await q('update platform.installations set enabled = $2 where id = $1', [installationId, Boolean(enabled)]);
  await record({ workspaceId, installationId, userId, action: enabled ? 'app.enabled' : 'app.disabled' });
  return { enabled: Boolean(enabled) };
}

export async function setSurface({ workspaceId, installationId, surfaceId, userId, patch }) {
  await requireInstallation(workspaceId, installationId);
  const surface = await one(
    'select * from platform.installation_surfaces where installation_id = $1 and surface_id = $2',
    [installationId, surfaceId]
  );
  if (!surface) throw notFound('This app does not have that surface');

  if (patch.published === true && surface.kind !== 'public') {
    throw badRequest('Only a public surface can be published to the customer-facing page');
  }

  const row = await one(
    `update platform.installation_surfaces
        set enabled = coalesce($3, enabled),
            published = coalesce($4, published),
            display_mode = coalesce($5, display_mode),
            position = coalesce($6, position)
      where id = $1 and installation_id = $2 returning *`,
    [surface.id, installationId, patch.enabled ?? null, patch.published ?? null,
     patch.display_mode ?? null, patch.position ?? null]
  );
  await record({ workspaceId, installationId, userId, action: 'surface.updated', detail: { surfaceId, patch } });
  return row;
}

export async function grantPermission({ workspaceId, installationId, userId, permissionId }) {
  const installation = await requireInstallation(workspaceId, installationId);
  const declared = await one(
    `select 1 from platform.app_declared_permissions
      where app_version_id = $1 and permission_id = $2`,
    [installation.app_version_id, permissionId]
  );
  if (!declared) throw forbidden('This app did not request that permission');

  await q(
    `insert into platform.installation_permissions (installation_id, permission_id, granted_by)
     values ($1, $2, $3)
     on conflict (installation_id, permission_id)
       do update set revoked_at = null, granted_at = now(), granted_by = excluded.granted_by`,
    [installationId, permissionId, userId]
  );
  await record({ workspaceId, installationId, userId, action: 'permission.granted', detail: { permissionId } });
  return { granted: permissionId };
}

export async function revokePermission({ workspaceId, installationId, userId, permissionId }) {
  await requireInstallation(workspaceId, installationId);
  const row = await one(
    `update platform.installation_permissions set revoked_at = now()
      where installation_id = $1 and permission_id = $2 and revoked_at is null returning permission_id`,
    [installationId, permissionId]
  );
  if (!row) throw notFound('That permission is not currently granted');
  await record({ workspaceId, installationId, userId, action: 'permission.revoked', detail: { permissionId } });
  return { revoked: permissionId };
}

// Updating is deliberate and explicit: it writes a new pinned manifest. A
// permission the new version added is not carried over, so an update can never
// silently widen what an app may do.
export async function update({ workspaceId, installationId, userId, grants = [] }) {
  const installation = await requireInstallation(workspaceId, installationId);
  const appId = installation.pinned_manifest.id;
  const target = await versionFor(appId);
  if (target.version_id === installation.app_version_id) {
    throw conflict(`${appId} is already at ${target.version}`);
  }

  const declared = await declarationsFor(target.version_id);
  const held = new Set((await q(
    `select permission_id from platform.installation_permissions
      where installation_id = $1 and revoked_at is null`, [installationId]
  )).map(r => r.permission_id));

  const newlyRequired = declared.permissions
    .filter(p => !p.optional && !held.has(p.permission_id) && !grants.includes(p.permission_id))
    .map(p => p.permission_id);
  if (newlyRequired.length) {
    throw badRequest('This version needs permissions you have not granted', newlyRequired);
  }

  await tx(async db => {
    await db.q(
      `update platform.installations set app_version_id = $2, pinned_manifest = $3 where id = $1`,
      [installationId, target.version_id, JSON.stringify(target.manifest)]
    );
    for (const permission of grants) {
      await db.q(
        `insert into platform.installation_permissions (installation_id, permission_id, granted_by)
         values ($1, $2, $3)
         on conflict (installation_id, permission_id)
           do update set revoked_at = null, granted_at = now()`,
        [installationId, permission, userId]
      );
    }
    // A surface the new version dropped stops existing; one it added arrives
    // disabled, because the owner has not seen it yet.
    const ids = declared.surfaces.map(s => s.surface_id);
    await db.q(
      `delete from platform.installation_surfaces
        where installation_id = $1 and not (surface_id = any($2::text[]))`,
      [installationId, ids]
    );
    for (const surface of declared.surfaces) {
      await db.q(
        `insert into platform.installation_surfaces
           (installation_id, surface_id, kind, title, path, display_mode, enabled)
         values ($1, $2, $3, $4, $5, $6, false)
         on conflict (installation_id, surface_id)
           do update set kind = excluded.kind, title = excluded.title, path = excluded.path`,
        [installationId, surface.surface_id, surface.kind, surface.title, surface.path,
         (surface.display_modes ?? ['page'])[0]]
      );
    }
  });

  await record({ workspaceId, installationId, userId, action: 'app.updated',
                 detail: { appId, to: target.version } });
  return { appId, version: target.version };
}

export async function listInstalled(workspaceId) {
  const rows = await q(
    `select i.id, i.status, i.enabled, i.installed_at, i.settings,
            a.app_id, a.name, a.icon, a.publisher, a.data_namespace,
            v.version,
            (select v2.version from platform.releases r
               join platform.app_versions v2 on v2.id = r.app_version_id
              where r.app_row_id = a.id and r.channel = 'stable') as latest_version
       from platform.installations i
       join platform.apps a on a.id = i.app_row_id
       join platform.app_versions v on v.id = i.app_version_id
      where i.workspace_id = $1 and i.status = 'installed'
      order by a.name`,
    [workspaceId]
  );

  for (const row of rows) {
    row.surfaces = await q(
      `select surface_id, kind, title, path, display_mode, enabled, published, position
         from platform.installation_surfaces where installation_id = $1 order by position`,
      [row.id]
    );
    row.permissions = await q(
      `select ip.permission_id, ip.granted_at, p.title, p.sensitive
         from platform.installation_permissions ip
         join platform.permissions p on p.id = ip.permission_id
        where ip.installation_id = $1 and ip.revoked_at is null`,
      [row.id]
    );
    row.updateAvailable = row.latest_version !== row.version;
  }
  return rows;
}

// The public page: every published surface across every enabled app, in order.
export async function publicSurfaces(workspaceSlug) {
  return q(
    `select w.id as workspace_id, w.name as workspace_name,
            i.id as installation_id, a.app_id, a.name as app_name,
            s.surface_id, s.path, s.display_mode, s.title, s.position,
            i.pinned_manifest -> 'runtime' ->> 'url' as app_origin
       from platform.workspaces w
       join platform.installations i on i.workspace_id = w.id and i.status = 'installed' and i.enabled
       join platform.apps a on a.id = i.app_row_id
       join platform.installation_surfaces s on s.installation_id = i.id
      where w.slug = $1 and s.kind = 'public' and s.enabled and s.published
      order by s.position, a.name`,
    [workspaceSlug]
  );
}

export async function requireInstallation(workspaceId, installationId) {
  const row = await one(
    `select * from platform.installations
      where id = $1 and workspace_id = $2 and status <> 'uninstalled'`,
    [installationId, workspaceId]
  );
  if (!row) throw notFound('No such installation');
  return row;
}

async function declarationsFor(versionId) {
  const [permissions, surfaces] = await Promise.all([
    q(`select permission_id, reason, optional from platform.app_declared_permissions where app_version_id = $1`,
      [versionId]),
    q(`select surface_id, kind, title, path, display_modes from platform.app_declared_surfaces where app_version_id = $1`,
      [versionId]),
  ]);
  return { permissions, surfaces };
}
