// End-to-end, against a real Postgres and real HTTP.
//
// Every case below asserts one specific rejection or one specific success. A
// platform whose tests only ever assert success is a platform whose boundaries
// have never been tried.

import { connect, reset, close, q, one } from '../src/db.js';
import { createServer } from '../src/http/server.js';
import { ensureStore } from '../src/catalog.js';
import { signingKey } from '../src/tokens.js';
import { deliverPending } from '../src/events.js';
import { app as serviceApp } from './fixtures/service-app/server.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let passed = 0, failed = 0;

// Printed as each case finishes rather than collected and dumped at the end: a
// suite that only speaks once cannot tell you which case it hung on.
async function check(name, fn) {
  const started = Date.now();
  try {
    await withTimeout(fn(), 20_000, name);
    passed++;
    console.log(`  ok    ${name}${slow(started)}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n          ${e.message}`);
  }
}

const slow = started => (Date.now() - started > 1000 ? `  (${Date.now() - started}ms)` : '');

const withTimeout = (promise, ms, name) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref()),
]);

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, message) =>
  assert(actual === expected, `${message ?? 'mismatch'}: expected ${expected}, got ${actual}`);

// -- harness ----------------------------------------------------------------

let PLATFORM, NOTIFIER, session, workspaceId;

async function api(path, { method = 'GET', body, token, origin, raw = false } = {}) {
  const response = await fetch(PLATFORM + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => null);
  if (raw) return { status: response.status, body: parsed };
  if (!response.ok) {
    const error = new Error(parsed?.error?.message ?? `HTTP ${response.status}`);
    error.status = response.status;
    error.code = parsed?.error?.code;
    error.detail = parsed?.error?.detail;
    throw error;
  }
  return parsed;
}

async function rejects(fn, status, hint = '') {
  try {
    await fn();
  } catch (e) {
    if (e.status === status) return e;
    throw new Error(`expected ${status}${hint ? ` (${hint})` : ''}, got ${e.status}: ${e.message}`);
  }
  throw new Error(`expected ${status}${hint ? ` (${hint})` : ''}, but the call succeeded`);
}

// A fixture manifest carries no address. The suite supplies one at publish
// time, exactly as the CLI does, so nothing below depends on where an app
// happens to be served from.
const fixture = (name, runtime) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', name, 'manifest.json'), 'utf8'));
  return { ...manifest, runtime: { ...manifest.runtime, ...runtime } };
};
const clone = value => JSON.parse(JSON.stringify(value));

// -- run --------------------------------------------------------------------

await connect({ url: process.env.DATABASE_URL });
await reset();
await signingKey();
await ensureStore({ slug: 'official', name: 'Official Store', kind: 'local' });

const platformServer = createServer().listen(0);
await new Promise(r => platformServer.once('listening', r));
PLATFORM = `http://localhost:${platformServer.address().port}`;

const notifierServer = serviceApp.listen(0);
await new Promise(r => notifierServer.once('listening', r));
NOTIFIER = `http://localhost:${notifierServer.address().port}`;
process.env.PLATFORM_URL = PLATFORM;

// The hosted fixture is never fetched by the platform — only its origin is,
// for the binding checks — so it needs an address, not a server.
const SONG_ORIGIN = 'http://localhost:59101';
const songRequest = fixture('hosted-app', { url: SONG_ORIGIN });
const notifier = fixture('service-app', { base_url: NOTIFIER });

console.log(`\nplatform ${PLATFORM}   notifier ${NOTIFIER}\n`);

// -- identity ---------------------------------------------------------------

await check('registering creates a user, an organisation and a workspace', async () => {
  const result = await api('/v1/auth/register', {
    method: 'POST',
    body: { email: 'Owner@Example.com', name: 'Sam Owner', password: 'correct-horse-battery', organizationName: 'Blue Bar' },
  });
  session = result.session.token;
  workspaceId = result.workspace.id;
  equal(result.user.email, 'owner@example.com', 'email is normalised');
  assert(workspaceId, 'a workspace was created');
});

await check('a second account cannot take the same email', () =>
  rejects(() => api('/v1/auth/register', {
    method: 'POST', body: { email: 'owner@example.com', name: 'Impostor', password: 'correct-horse-battery' },
  }), 409));

await check('a short password is refused', () =>
  rejects(() => api('/v1/auth/register', {
    method: 'POST', body: { email: 'other@example.com', name: 'Other', password: 'short' },
  }), 400));

await check('the wrong password does not sign in', () =>
  rejects(() => api('/v1/auth/sign-in', {
    method: 'POST', body: { email: 'owner@example.com', password: 'wrong-password-here' },
  }), 401));

await check('a session reaches every app without signing in again', async () => {
  const me = await api('/v1/auth/me', { token: session });
  equal(me.workspaces.length, 1, 'one workspace');
  equal(me.workspaces[0].role, 'owner', 'as owner');
});

// -- publishing -------------------------------------------------------------

await check('publishing a valid manifest puts an app in the catalog', async () => {
  const result = await api('/v1/catalog/publish', { method: 'POST', token: session, body: { manifest: songRequest } });
  equal(result.appId, 'fixture.song-request');
  assert(result.contentHash.startsWith('sha256:'), 'the version is content-addressed');
});

await check('publishing the same version twice is refused', () =>
  rejects(() => api('/v1/catalog/publish', { method: 'POST', token: session, body: { manifest: songRequest } }), 409));

await check('a permission the platform does not define is refused at publish', () =>
  rejects(() => {
    const bad = clone(songRequest);
    bad.version = '1.0.1';
    bad.permissions.push({ id: 'database.root', reason: 'Because I would like it very much.' });
    return api('/v1/catalog/publish', { method: 'POST', token: session, body: { manifest: bad } });
  }, 400, 'unknown permission'));

await check('a public surface without surface.public is refused at publish', () =>
  rejects(() => {
    const bad = clone(songRequest);
    bad.version = '1.0.2';
    bad.permissions = bad.permissions.filter(p => p.id !== 'surface.public');
    bad.surfaces = bad.surfaces.map(s => ({ ...s, requires_permission: undefined }));
    return api('/v1/catalog/publish', { method: 'POST', token: session, body: { manifest: bad } });
  }, 400));

await check('an id that does not carry its publisher prefix is refused', () =>
  rejects(() => {
    const bad = clone(songRequest);
    bad.id = 'someoneelse.song-request';
    return api('/v1/catalog/publish', { method: 'POST', token: session, body: { manifest: bad } });
  }, 400));

await check('an app targeting a platform major that does not exist is refused', () =>
  rejects(() => {
    const bad = clone(songRequest);
    bad.version = '1.0.3';
    bad.requires = { platform: '^9' };
    return api('/v1/catalog/publish', { method: 'POST', token: session, body: { manifest: bad } });
  }, 400));

await check('the catalog index renders from columns, not from the manifest', async () => {
  const { apps } = await api(`/v1/catalog/apps?workspace=${workspaceId}`, { token: session });
  const entry = apps.find(a => a.id === 'fixture.song-request');
  assert(entry, 'the app is listed');
  equal(entry.installed, false, 'not installed yet');
  assert(entry.surfaceKinds.includes('public'), 'surface kinds are derived');
  assert(!('manifest' in entry), 'no raw manifest reaches the index');
});

await check('publishing the notifier registers a service app with no surfaces', async () => {
  const result = await api('/v1/catalog/publish', { method: 'POST', token: session, body: { manifest: notifier } });
  equal(result.appId, 'fixture.notifier');
});

// -- installing -------------------------------------------------------------

let installationId, notifierInstallationId, notifierSecret;

await check('installing without every required permission is refused', () =>
  rejects(() => api(`/v1/workspaces/${workspaceId}/installations`, {
    method: 'POST', token: session, body: { appId: 'fixture.song-request', grants: ['surface.public'] },
  }), 400, 'events.emit is required'));

await check('granting a permission the app never asked for is refused', () =>
  rejects(() => api(`/v1/workspaces/${workspaceId}/installations`, {
    method: 'POST', token: session,
    body: { appId: 'fixture.song-request', grants: ['surface.public', 'events.emit', 'contacts.delete'] },
  }), 400));

await check('installing pins the manifest and records the grants', async () => {
  const result = await api(`/v1/workspaces/${workspaceId}/installations`, {
    method: 'POST', token: session,
    body: { appId: 'fixture.song-request', grants: ['surface.public', 'events.emit', 'contacts.write', 'capability.invoke'] },
  });
  installationId = result.installationId;
  const row = await one('select pinned_manifest, app_version_id from platform.installations where id = $1', [installationId]);
  equal(row.pinned_manifest.version, '1.0.0', 'the manifest is copied, not referenced');
});

await check('installing the same app twice in one workspace is refused', () =>
  rejects(() => api(`/v1/workspaces/${workspaceId}/installations`, {
    method: 'POST', token: session,
    body: { appId: 'fixture.song-request', grants: ['surface.public', 'events.emit'] },
  }), 409));

await check('installing a service app issues a client secret', async () => {
  const result = await api(`/v1/workspaces/${workspaceId}/installations`, {
    method: 'POST', token: session,
    body: { appId: 'fixture.notifier', grants: ['contacts.read', 'events.subscribe'] },
  });
  notifierInstallationId = result.installationId;
  notifierSecret = result.clientSecret;
  assert(notifierSecret?.length > 20, 'a secret was issued');
  const row = await one('select client_secret_hash from platform.installations where id = $1', [notifierInstallationId]);
  assert(row.client_secret_hash && row.client_secret_hash !== notifierSecret, 'the secret is stored hashed');
  process.env.INSTALLATION_ID = notifierInstallationId;
  process.env.CLIENT_SECRET = notifierSecret;
});

// -- the handoff ------------------------------------------------------------

let appToken, handoffUrl;

await check('opening a surface produces a code bound to the app origin', async () => {
  const handoff = await api(
    `/v1/workspaces/${workspaceId}/installations/${installationId}/surfaces/queue/handoff`,
    { method: 'POST', token: session }
  );
  handoffUrl = handoff.url;
  equal(handoff.origin, SONG_ORIGIN, 'bound to the manifest origin');
  assert(new URL(handoffUrl).searchParams.get('cc_code'), 'a code is in the URL');
  assert(new URL(handoffUrl).searchParams.get('cc_platform'), 'the app is told where the platform is');
});

await check('a code redeemed from the wrong origin is refused', async () => {
  const code = new URL(handoffUrl).searchParams.get('cc_code');
  await rejects(() => api('/v1/oauth/token', {
    method: 'POST', origin: 'https://attacker.example',
    body: { grant_type: 'authorization_code', code },
  }), 403);
});

await check('a code redeemed from the app origin returns a scoped token', async () => {
  const code = new URL(handoffUrl).searchParams.get('cc_code');
  const grant = await api('/v1/oauth/token', {
    method: 'POST', origin: SONG_ORIGIN, body: { grant_type: 'authorization_code', code },
  });
  appToken = grant.access_token;
  equal(grant.context.appId, 'fixture.song-request');
  equal(grant.context.workspace.id, workspaceId);
  assert(grant.scope.includes('events.emit'), 'the granted scope is in the token');
  assert(!grant.scope.includes('contacts.read'), 'an ungranted permission is not');
});

await check('a code cannot be redeemed twice', async () => {
  const code = new URL(handoffUrl).searchParams.get('cc_code');
  await rejects(() => api('/v1/oauth/token', {
    method: 'POST', origin: SONG_ORIGIN, body: { grant_type: 'authorization_code', code },
  }), 401);
});

await check('a platform session is not an app token', () =>
  rejects(() => api('/v1/app/context', { token: session }), 401));

// -- what an app may do -----------------------------------------------------

let rowId;

await check('an app writes to its own table without asking permission', async () => {
  const result = await api('/v1/app/data/requests', {
    method: 'POST', token: appToken, body: { song: 'Free Bird', requested_by: 'Dana' },
  });
  rowId = result.row.id;
  equal(result.row.workspace_id, workspaceId, 'the row is scoped to the workspace');
  equal(result.row.status, 'pending', 'the declared default applied');
});

await check('a column the manifest never declared is refused', () =>
  rejects(() => api('/v1/app/data/requests', {
    method: 'POST', token: appToken, body: { song: 'Hey Jude', is_admin: true },
  }), 400));

await check('another app\'s table is not visible', () =>
  rejects(() => api('/v1/app/data/messages', { token: appToken }), 404));

await check('a permission that was not granted is refused', () =>
  rejects(() => api('/v1/app/contacts', { token: appToken }), 403));

await check('a granted permission works', async () => {
  const result = await api('/v1/app/contacts', {
    method: 'POST', token: appToken, body: { name: 'Dana', email: 'dana@example.com', tags: ['song-request'] },
  });
  equal(result.contact.name, 'Dana');
});

await check('revoking a permission takes effect on the next request, not in fifteen minutes', async () => {
  await api(`/v1/workspaces/${workspaceId}/installations/${installationId}/permissions/contacts.write`, {
    method: 'DELETE', token: session,
  });
  await rejects(() => api('/v1/app/contacts', {
    method: 'POST', token: appToken, body: { name: 'Nope', email: 'nope@example.com' },
  }), 403);
  await api(`/v1/workspaces/${workspaceId}/installations/${installationId}/permissions`, {
    method: 'POST', token: session, body: { permissionId: 'contacts.write' },
  });
});

// -- apps composing ---------------------------------------------------------

await check('an app calls a capability another app provides, without knowing which', async () => {
  const result = await api('/v1/app/capabilities/notify.send', {
    method: 'POST', token: appToken,
    body: { to: 'dana@example.com', body: 'Your song is queued.', reason: 'test' },
  });
  equal(result.provider, 'fixture.notifier', 'the platform resolved the provider');
  assert(result.result.sent, 'the provider did the work');
  equal(result.result.calledBy, 'fixture.song-request', 'the provider was told who called');
});

await check('an unprovided capability is a 404, not a hang', () =>
  rejects(() => api('/v1/app/capabilities/sms.blast', { method: 'POST', token: appToken, body: {} }), 404));

await check('an emitted event reaches the app that subscribed to it', async () => {
  await api('/v1/app/events', {
    method: 'POST', token: appToken,
    body: { event: 'song_request.created', payload: { id: rowId, song: 'Free Bird', by: 'Dana' } },
  });
  const { delivered } = await deliverPending();
  equal(delivered, 1, 'one event delivered');

  const messages = await q(`select * from appdata."notifier__messages" where reason = 'song_request.created'`);
  equal(messages.length, 1, 'the subscriber wrote a row of its own in response');
});

await check('emitting an event the manifest never declared is refused', () =>
  rejects(() => api('/v1/app/events', {
    method: 'POST', token: appToken, body: { event: 'payroll.transferred', payload: {} },
  }), 400));

await check('a service app authenticates with its client secret', async () => {
  const grant = await api('/v1/oauth/token', {
    method: 'POST',
    body: { grant_type: 'client_credentials', installation_id: notifierInstallationId, client_secret: notifierSecret },
  });
  equal(grant.context.appId, 'fixture.notifier');
  assert(grant.scope.includes('contacts.read'), 'with its own scope');
});

await check('a wrong client secret is refused', () =>
  rejects(() => api('/v1/oauth/token', {
    method: 'POST',
    body: { grant_type: 'client_credentials', installation_id: notifierInstallationId, client_secret: 'nope' },
  }), 401));

// -- the public page --------------------------------------------------------

let publicToken;

await check('nothing is on the public page until the owner publishes a surface', async () => {
  const before = await api('/public/blue-bar/surfaces');
  equal(before.surfaces.length, 0, 'installed is not published');

  await api(`/v1/workspaces/${workspaceId}/installations/${installationId}/surfaces/request_form`, {
    method: 'PATCH', token: session, body: { published: true },
  });
  const after = await api('/public/blue-bar/surfaces');
  equal(after.surfaces.length, 1, 'now it is on the page');
  assert(after.surfaces[0].url?.includes('cc_code'), 'with an anonymous code of its own');
  publicToken = after.surfaces[0].url;
});

await check('a dashboard surface cannot be published to the public page', () =>
  rejects(() => api(`/v1/workspaces/${workspaceId}/installations/${installationId}/surfaces/queue`, {
    method: 'PATCH', token: session, body: { published: true },
  }), 400));

await check('a public token is anonymous and narrower than the owner\'s grants', async () => {
  const code = new URL(publicToken).searchParams.get('cc_code');
  const grant = await api('/v1/oauth/token', {
    method: 'POST', origin: SONG_ORIGIN, body: { grant_type: 'authorization_code', code },
  });
  publicToken = grant.access_token;
  assert(grant.scope.includes('contacts.write'), 'a stranger may leave their details');
  assert(!grant.scope.includes('capability.invoke'), 'but not spend the owner\'s other apps');
});

await check('a stranger may append to a table the manifest opened, and only append', async () => {
  const created = await api('/v1/app/data/requests', {
    method: 'POST', token: publicToken, body: { song: 'Anonymous Request' },
  });
  assert(created.row.id, 'the request was accepted');
  await rejects(() => api('/v1/app/data/requests', { token: publicToken }), 403, 'public read');
  await rejects(() => api(`/v1/app/data/requests/${created.row.id}`, {
    method: 'PATCH', token: publicToken, body: { status: 'played' },
  }), 403, 'public update');
});

// -- lifecycle --------------------------------------------------------------

await check('disabling an app stops it opening but keeps it installed', async () => {
  await api(`/v1/workspaces/${workspaceId}/installations/${installationId}/enabled`, {
    method: 'POST', token: session, body: { enabled: false },
  });
  await rejects(() => api(
    `/v1/workspaces/${workspaceId}/installations/${installationId}/surfaces/queue/handoff`,
    { method: 'POST', token: session }
  ), 403);
  await api(`/v1/workspaces/${workspaceId}/installations/${installationId}/enabled`, {
    method: 'POST', token: session, body: { enabled: true },
  });
});

await check('uninstalling keeps the records the manifest said to keep', async () => {
  const before = await q('select count(*)::int as n from appdata."song_request__requests"');
  const result = await api(`/v1/workspaces/${workspaceId}/installations/${installationId}`, {
    method: 'DELETE', token: session,
  });
  equal(result.deletedRows, 0, 'nothing was deleted');
  equal(result.retainedRows, before[0].n, 'every row survived');
});

await check('uninstalling revokes every grant', async () => {
  const live = await q(
    'select 1 from platform.installation_permissions where installation_id = $1 and revoked_at is null',
    [installationId]
  );
  equal(live.length, 0, 'no permission survives an uninstall');
});

await check('the uninstalled row stays, and the app reinstalls onto its old data', async () => {
  const history = await q(
    `select status from platform.installations where workspace_id = $1 and status = 'uninstalled'`, [workspaceId]
  );
  equal(history.length, 1, 'history survives');

  const again = await api(`/v1/workspaces/${workspaceId}/installations`, {
    method: 'POST', token: session,
    body: { appId: 'fixture.song-request', grants: ['surface.public', 'events.emit'] },
  });
  assert(again.installationId !== installationId, 'a new installation');
  const rows = await q('select count(*)::int as n from appdata."song_request__requests"');
  assert(rows[0].n > 0, 'the old rows are still there');
  installationId = again.installationId;
});

await check('an explicit delete_data uninstall does remove the records', async () => {
  const result = await api(`/v1/workspaces/${workspaceId}/installations/${installationId}?delete_data=true`, {
    method: 'DELETE', token: session,
  });
  assert(result.deletedRows > 0, 'rows were deleted because the owner asked');
});

// -- tenancy ----------------------------------------------------------------

await check('another workspace cannot reach this one\'s installation', async () => {
  const outsider = await api('/v1/auth/register', {
    method: 'POST',
    body: { email: 'rival@example.com', name: 'Rival', password: 'another-long-password', organizationName: 'Red Bar' },
  });
  await rejects(() => api(`/v1/workspaces/${workspaceId}/installations`, { token: outsider.session.token }), 404);
});

await check('an app token from one workspace sees no rows from another', async () => {
  const rival = await api('/v1/auth/register', {
    method: 'POST',
    body: { email: 'rival2@example.com', name: 'Rival Two', password: 'another-long-password', organizationName: 'Green Bar' },
  });
  await api(`/v1/workspaces/${rival.workspace.id}/installations`, {
    method: 'POST', token: rival.session.token,
    body: { appId: 'fixture.song-request', grants: ['surface.public', 'events.emit'] },
  });
  const installations = await api(`/v1/workspaces/${rival.workspace.id}/installations`, { token: rival.session.token });
  const handoff = await api(
    `/v1/workspaces/${rival.workspace.id}/installations/${installations.installations[0].id}/surfaces/queue/handoff`,
    { method: 'POST', token: rival.session.token }
  );
  const grant = await api('/v1/oauth/token', {
    method: 'POST', origin: SONG_ORIGIN,
    body: { grant_type: 'authorization_code', code: new URL(handoff.url).searchParams.get('cc_code') },
  });
  const { rows } = await api('/v1/app/data/requests', { token: grant.access_token });
  equal(rows.length, 0, 'the same app, in another workspace, starts empty');
});

await check('every state change was written to the audit log', async () => {
  const { entries } = await api(`/v1/workspaces/${workspaceId}/audit`, { token: session });
  const actions = new Set(entries.map(e => e.action));
  for (const expected of ['app.installed', 'app.uninstalled', 'permission.revoked', 'permission.granted']) {
    assert(actions.has(expected), `${expected} was recorded`);
  }
});

// -- nothing about an app is compiled into the platform ---------------------

await check('the same app publishes at a different address without changing', async () => {
  // The proof that an app is not bound to where it is served: same manifest,
  // same id, different origin, and the platform binds handoffs to the new one.
  const moved = { ...clone(songRequest), version: '2.0.0', runtime: { type: 'hosted', url: 'https://songs.example.com' } };
  await api('/v1/catalog/publish', { method: 'POST', token: session, body: { manifest: moved } });

  const fresh = await api('/v1/auth/register', {
    method: 'POST',
    body: { email: 'moved@example.com', name: 'Moved', password: 'another-long-password', organizationName: 'Moved Bar' },
  });
  await api(`/v1/workspaces/${fresh.workspace.id}/installations`, {
    method: 'POST', token: fresh.session.token,
    body: { appId: 'fixture.song-request', grants: ['surface.public', 'events.emit'] },
  });
  const { installations } = await api(`/v1/workspaces/${fresh.workspace.id}/installations`, { token: fresh.session.token });
  const handoff = await api(
    `/v1/workspaces/${fresh.workspace.id}/installations/${installations[0].id}/surfaces/queue/handoff`,
    { method: 'POST', token: fresh.session.token }
  );
  equal(handoff.origin, 'https://songs.example.com', 'bound to the new address');
});

await check('the platform tells an app where the platform is', async () => {
  const live = await api(`/v1/workspaces/${workspaceId}/installations`, { token: session });
  const installed = live.installations.find(i => i.app_id === 'fixture.song-request')
    ?? (await api(`/v1/workspaces/${workspaceId}/installations`, {
          method: 'POST', token: session,
          body: { appId: 'fixture.song-request', grants: ['surface.public', 'events.emit'] },
        }), (await api(`/v1/workspaces/${workspaceId}/installations`, { token: session }))
          .installations.find(i => i.app_id === 'fixture.song-request'));

  const handoff = await api(
    `/v1/workspaces/${workspaceId}/installations/${installed.id}/surfaces/queue/handoff`,
    { method: 'POST', token: session }
  );
  const told = new URL(handoff.url).searchParams.get('cc_platform');
  assert(told, 'cc_platform is passed to the frame');
  const { version } = await api('/health');
  assert(version, 'and /health reports the version an app pins against');
});

await check('the permission vocabulary is readable without an account', async () => {
  const { permissions } = await api('/v1/catalog/permissions');
  assert(permissions.length >= 10, 'the whole vocabulary is listed');
  assert(permissions.some(p => p.public_safe), 'public-safety is a property of the permission, not a list in the code');
});

await check('a manifest can be checked without an account and without publishing', async () => {
  const ok = await api('/v1/catalog/validate', {
    method: 'POST', body: { manifest: { ...clone(songRequest), version: '9.9.9' } },
  });
  equal(ok.valid, true);
  await rejects(() => api('/v1/catalog/validate', {
    method: 'POST', body: { manifest: { ...clone(songRequest), id: 'NOT VALID' } },
  }), 400);
  const after = await api(`/v1/catalog/apps?workspace=${workspaceId}`, { token: session });
  assert(!after.apps.some(a => a.version === '9.9.9'), 'validating published nothing');
});

await check('the scaffold produces an app the platform accepts', async () => {
  // The claim under test is "easy to add an app": one command produces a
  // manifest this platform validates, with nothing edited by hand.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-app-'));
  await promisify(execFile)(process.execPath, [
    path.join(ROOT, 'bin', 'cc.mjs'), 'init', target,
    '--publisher', 'scaffold', '--slug', 'notes', '--name', 'Notes',
  ], { env: { ...process.env, CC_PLATFORM: PLATFORM } });

  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));
  equal(manifest.id, 'scaffold.notes', 'the id is publisher-prefixed');
  assert(!manifest.runtime.url, 'the scaffold hard-codes no address');
  assert(fs.existsSync(path.join(target, 'index.html')), 'and there is something to serve');

  const result = await api('/v1/catalog/validate', {
    method: 'POST',
    body: { manifest: { ...manifest, runtime: { ...manifest.runtime, url: 'https://notes.example.com' } } },
  });
  equal(result.valid, true, 'a scaffolded app validates untouched');
});

// -- the contract -----------------------------------------------------------

await check('the vendored manifest schema has not drifted from the marketplace copy', async () => {
  const { drift, CANONICAL } = await import('../bin/sync-contract.mjs');
  const result = drift();
  if (result === null) return;                                  // marketplace not checked out
  assert(result === false, `contract/app-manifest.v1.json differs from ${CANONICAL}; run npm run sync:contract`);
});

// -- report -----------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed\n`);

platformServer.close();
notifierServer.close();
await close();
process.exit(failed ? 1 : 0);
