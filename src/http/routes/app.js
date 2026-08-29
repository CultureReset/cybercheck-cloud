// Everything an app can do, and nothing else.
//
// This router is the entire attack surface an app is given. Every route below
// either touches the app's own namespace — which needs no permission, because
// it is the app's — or is gated on a permission the owner granted by name.

import { Router } from 'express';
import * as appdata from '../../appdata.js';
import * as contacts from '../../contacts.js';
import * as events from '../../events.js';
import * as capabilities from '../../capabilities.js';
import * as identity from '../../identity.js';
import { one } from '../../db.js';
import { requireApp, requireScope } from '../auth.js';
import { badRequest } from '../../errors.js';

export const router = Router();

// Apps call from their own origin in an iframe, so every response here is
// cross-origin. Credentials are never allowed: the bearer token is the only
// thing that authenticates, and cookies must not ride along.
router.use((req, res, next) => {
  res.set('access-control-allow-origin', req.get('origin') ?? '*');
  res.set('access-control-allow-headers', 'authorization, content-type');
  res.set('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.set('vary', 'origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

router.use(requireApp);

router.get('/context', async (req, res, next) => {
  try {
    const installation = await one(
      `select i.settings, w.slug, w.name from platform.installations i
         join platform.workspaces w on w.id = i.workspace_id where i.id = $1`,
      [req.app_ctx.installationId]
    );
    res.json({
      appId: req.app_ctx.appId,
      installationId: req.app_ctx.installationId,
      surfaceId: req.app_ctx.surfaceId,
      workspace: { id: req.app_ctx.workspaceId, slug: installation.slug, name: installation.name },
      settings: installation.settings,
      scope: [...req.app_ctx.scope],
    });
  } catch (e) { next(e); }
});

router.get('/workspace', requireScope('workspace.profile.read'), async (req, res, next) => {
  try {
    const workspace = await one(
      `select w.id, w.slug, w.name, o.name as organization
         from platform.workspaces w join platform.organizations o on o.id = w.organization_id
        where w.id = $1`,
      [req.app_ctx.workspaceId]
    );
    res.json({ workspace });
  } catch (e) { next(e); }
});

router.get('/members', requireScope('workspace.members.read'), async (req, res, next) => {
  try {
    const members = await identity.membersOf(req.app_ctx.workspaceId);
    // An app that can see who is in a workspace does not thereby get their
    // email addresses.
    res.json({ members: members.map(({ id, name, role }) => ({ id, name, role })) });
  } catch (e) { next(e); }
});

// -- the app's own tables ---------------------------------------------------
// No permission gate. These rows exist because this app declared them.

const own = (req, table) => ({
  namespace: req.app_ctx.namespace,
  table,
  workspaceId: req.app_ctx.workspaceId,
  anonymous: req.app_ctx.anonymous,
});

router.get('/data/:table', async (req, res, next) => {
  try {
    const { limit, offset, order, ...where } = req.query;
    res.json({
      rows: await appdata.select({
        ...own(req, req.params.table),
        where, limit: limit ?? 100, offset: offset ?? 0, orderBy: order ?? 'created_at desc',
      }),
    });
  } catch (e) { next(e); }
});

router.post('/data/:table', async (req, res, next) => {
  try {
    res.status(201).json({
      row: await appdata.insert({
        ...own(req, req.params.table),
        installationId: req.app_ctx.installationId,
        values: req.body ?? {},
      }),
    });
  } catch (e) { next(e); }
});

router.patch('/data/:table/:id', async (req, res, next) => {
  try {
    res.json({ row: await appdata.update({ ...own(req, req.params.table), id: req.params.id, values: req.body ?? {} }) });
  } catch (e) { next(e); }
});

router.delete('/data/:table/:id', async (req, res, next) => {
  try {
    res.json(await appdata.remove({ ...own(req, req.params.table), id: req.params.id }));
  } catch (e) { next(e); }
});

// -- shared records ---------------------------------------------------------

router.get('/contacts', requireScope('contacts.read'), async (req, res, next) => {
  try {
    res.json({
      contacts: await contacts.list({
        workspaceId: req.app_ctx.workspaceId,
        search: req.query.q ?? null, limit: req.query.limit, offset: req.query.offset,
      }),
    });
  } catch (e) { next(e); }
});

router.post('/contacts', requireScope('contacts.write'), async (req, res, next) => {
  try {
    res.status(201).json({
      contact: await contacts.upsert({
        workspaceId: req.app_ctx.workspaceId,
        installationId: req.app_ctx.installationId,
        contact: req.body ?? {},
      }),
    });
  } catch (e) { next(e); }
});

router.delete('/contacts/:id', requireScope('contacts.delete'), async (req, res, next) => {
  try {
    res.json(await contacts.remove({ workspaceId: req.app_ctx.workspaceId, id: req.params.id }));
  } catch (e) { next(e); }
});

// -- talking to other apps --------------------------------------------------

router.post('/events', requireScope('events.emit'), async (req, res, next) => {
  try {
    if (!req.body?.event) throw badRequest('event is required');
    res.status(202).json(await events.emit({
      workspaceId: req.app_ctx.workspaceId,
      installationId: req.app_ctx.installationId,
      event: req.body.event,
      payload: req.body.payload ?? {},
    }));
  } catch (e) { next(e); }
});

router.post('/capabilities/:capabilityId', requireScope('capability.invoke'), async (req, res, next) => {
  try {
    res.json(await capabilities.invoke({
      workspaceId: req.app_ctx.workspaceId,
      capabilityId: req.params.capabilityId,
      payload: req.body ?? {},
      caller: { appId: req.app_ctx.appId, installationId: req.app_ctx.installationId },
    }));
  } catch (e) { next(e); }
});
