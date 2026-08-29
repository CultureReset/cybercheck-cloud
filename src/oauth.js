// The handoff: a logged-in human, in the platform, opening an app.
//
// The app is on its own origin in an iframe. It cannot read the platform's
// cookies and must not be handed them. Instead the platform mints a one-time
// code into the frame URL, and the app trades that code — from its own origin,
// within a minute, once — for a token scoped to exactly what the owner granted.

import crypto from 'node:crypto';
import { q, one } from './db.js';
import { badRequest, unauthorized, forbidden, notFound } from './errors.js';
import { sign, hash, randomToken, challengeFor } from './tokens.js';
import { config } from './config.js';
import { requireInstallation } from './installs.js';

// What a stranger on the public page may carry: the intersection of what the
// owner granted and what the permissions table marks public_safe. Adding a
// permission is one row, not a row and an edit to this file.
async function publicSafeScope(installationId) {
  const rows = await q(
    `select ip.permission_id from platform.installation_permissions ip
       join platform.permissions p on p.id = ip.permission_id
      where ip.installation_id = $1 and ip.revoked_at is null and p.public_safe
      order by ip.permission_id`,
    [installationId]
  );
  return rows.map(r => r.permission_id);
}

export const originOf = url => {
  try { return new URL(url).origin; } catch { return null; }
};

// Called by the platform UI, with a session. Produces the URL to put in the
// iframe. The code inside it is worthless to anyone but this app.
export async function handoff({ workspaceId, installationId, surfaceId, userId, platformOrigin }) {
  const installation = await requireInstallation(workspaceId, installationId);
  if (!installation.enabled) throw forbidden('This app is disabled');

  const surface = await one(
    `select * from platform.installation_surfaces
      where installation_id = $1 and surface_id = $2 and enabled`,
    [installationId, surfaceId]
  );
  if (!surface) throw notFound('That surface is not enabled for this installation');

  const manifest = installation.pinned_manifest;
  const base = manifest.runtime?.url;
  const origin = originOf(base);
  if (!origin) throw badRequest('This app has no hosted runtime to open');

  const scope = await liveScope(installationId);
  const code = randomToken(24);

  await q(
    `insert into platform.authorization_codes
       (code_hash, installation_id, user_id, surface_id, bound_origin, scope, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + ($7 || ' seconds')::interval)`,
    [hash(code), installationId, userId, surfaceId, origin, JSON.stringify(scope),
     String(config.handoffCodeTtlSeconds)]
  );

  const url = frameUrl(base, surface.path, { code, installationId, surfaceId, platformOrigin });

  return {
    url,
    origin,
    surface: { id: surface.surface_id, kind: surface.kind, displayMode: surface.display_mode, title: surface.title },
    expiresIn: config.handoffCodeTtlSeconds,
  };
}

// The same handoff for the customer-facing page, where there is no logged-in
// human to authorise anything. Anonymous, narrower, and marked as such in the
// token so every downstream check can tell the difference.
export async function publicHandoff({ workspaceSlug, installationId, surfaceId, platformOrigin }) {
  const row = await one(
    `select i.id, i.pinned_manifest, s.path, s.display_mode, s.title, s.surface_id
       from platform.installations i
       join platform.workspaces w on w.id = i.workspace_id
       join platform.installation_surfaces s on s.installation_id = i.id
      where w.slug = $1 and i.id = $2 and s.surface_id = $3
        and i.status = 'installed' and i.enabled
        and s.kind = 'public' and s.enabled and s.published`,
    [workspaceSlug, installationId, surfaceId]
  );
  if (!row) throw notFound('That surface is not published');

  const base = row.pinned_manifest.runtime?.url;
  const origin = originOf(base);
  if (!origin) return null;

  const scope = await publicSafeScope(installationId);
  const code = randomToken(24);

  await q(
    `insert into platform.authorization_codes
       (code_hash, installation_id, user_id, surface_id, bound_origin, scope, expires_at)
     values ($1, $2, null, $3, $4, $5, now() + ($6 || ' seconds')::interval)`,
    [hash(code), installationId, surfaceId, origin, JSON.stringify(scope),
     String(config.handoffCodeTtlSeconds)]
  );

  return frameUrl(base, row.path, { code, installationId, surfaceId, platformOrigin });
}

function frameUrl(base, path, { code, installationId, surfaceId, platformOrigin }) {
  const url = new URL(path, base);
  url.searchParams.set('cc_code', code);
  url.searchParams.set('cc_installation', installationId);
  url.searchParams.set('cc_surface', surfaceId);
  // The app loads the SDK from here, so it has to be told where "here" is.
  if (platformOrigin) url.searchParams.set('cc_platform', platformOrigin);
  return url.toString();
}

// Called by the app, from the app's own origin. `requestOrigin` is the browser's
// Origin header, which a page cannot forge for itself.
export async function exchangeCode({ code, codeVerifier = null, requestOrigin }) {
  const row = await one('select * from platform.authorization_codes where code_hash = $1', [hash(code ?? '')]);
  if (!row) throw unauthorized('Unknown authorization code');
  if (row.used_at) throw unauthorized('This code has already been used');
  if (new Date(row.expires_at) < new Date()) throw unauthorized('This code has expired');

  // The binding that makes a leaked code useless: it is only redeemable from
  // the origin the manifest pinned.
  if (requestOrigin && requestOrigin !== row.bound_origin) {
    throw forbidden(`This code may only be redeemed from ${row.bound_origin}`);
  }
  if (row.code_challenge && challengeFor(codeVerifier ?? '') !== row.code_challenge) {
    throw unauthorized('PKCE verifier does not match');
  }

  await q('update platform.authorization_codes set used_at = now() where code_hash = $1', [row.code_hash]);

  const installation = await one(
    `select i.*, a.app_id, a.data_namespace, w.slug as workspace_slug, w.name as workspace_name
       from platform.installations i
       join platform.apps a on a.id = i.app_row_id
       join platform.workspaces w on w.id = i.workspace_id
      where i.id = $1`,
    [row.installation_id]
  );
  if (installation.status !== 'installed' || !installation.enabled) {
    throw forbidden('This app is not currently enabled');
  }

  // A public code froze its narrowed scope at issue time. A user code did not,
  // so its token reflects the grants as they stand right now.
  return issue(installation, {
    userId: row.user_id,
    surfaceId: row.surface_id,
    scope: row.user_id === null ? row.scope : null,
  });
}

// Service apps have no browser and no user. They authenticate as themselves
// with the secret issued at install.
export async function clientCredentials({ installationId, clientSecret }) {
  const installation = await one(
    `select i.*, a.app_id, a.data_namespace, w.slug as workspace_slug, w.name as workspace_name
       from platform.installations i
       join platform.apps a on a.id = i.app_row_id
       join platform.workspaces w on w.id = i.workspace_id
      where i.id = $1 and i.status = 'installed'`,
    [installationId]
  );
  if (!installation?.client_secret_hash) throw unauthorized('Unknown installation');

  const provided = Buffer.from(hash(clientSecret ?? ''));
  const expected = Buffer.from(installation.client_secret_hash);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw unauthorized('Client authentication failed');
  }
  if (!installation.enabled) throw forbidden('This app is disabled');

  return issue(installation, { userId: null, surfaceId: null });
}

async function issue(installation, { userId, surfaceId, scope: fixedScope = null }) {
  // A code minted for the public page carries a narrowed scope. Re-reading the
  // live grants here would quietly widen it back out.
  const anonymous = userId === null && fixedScope !== null;
  const scope = fixedScope ?? await liveScope(installation.id);
  const { token, expiresIn } = await sign({
    sub: userId ?? `installation:${installation.id}`,
    aud: installation.app_id,
    inst: installation.id,
    ws: installation.workspace_id,
    ns: installation.data_namespace,
    surface: surfaceId,
    anon: anonymous,
    scope,
  }, { ttlSeconds: config.accessTokenTtlSeconds });

  return {
    access_token: token,
    token_type: 'Bearer',
    expires_in: expiresIn,
    scope: scope.join(' '),
    context: {
      installationId: installation.id,
      appId: installation.app_id,
      workspace: { id: installation.workspace_id, slug: installation.workspace_slug, name: installation.workspace_name },
      settings: installation.settings,
      surfaceId,
    },
  };
}

// Always read from the table, never from the pinned manifest. A permission the
// owner revoked five minutes ago must not appear in a token minted now.
export async function liveScope(installationId) {
  const rows = await q(
    `select permission_id from platform.installation_permissions
      where installation_id = $1 and revoked_at is null order by permission_id`,
    [installationId]
  );
  return rows.map(r => r.permission_id);
}
