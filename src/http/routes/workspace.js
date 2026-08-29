import { Router } from 'express';
import * as installs from '../../installs.js';
import * as identity from '../../identity.js';
import * as audit from '../../audit.js';
import * as oauth from '../../oauth.js';
import { requireUser, requireWorkspaceRole } from '../auth.js';
import { config } from '../../config.js';

export const router = Router({ mergeParams: true });

router.use('/:workspaceId', requireUser, requireWorkspaceRole(['owner', 'admin', 'member', 'viewer']));

const admin = requireWorkspaceRole(['owner', 'admin']);

router.get('/:workspaceId', async (req, res, next) => {
  try {
    res.json({ workspace: req.workspace, members: await identity.membersOf(req.workspace.id) });
  } catch (e) { next(e); }
});

router.get('/:workspaceId/installations', async (req, res, next) => {
  try { res.json({ installations: await installs.listInstalled(req.workspace.id) }); } catch (e) { next(e); }
});

router.post('/:workspaceId/installations', admin, async (req, res, next) => {
  try {
    res.status(201).json(await installs.install({
      workspaceId: req.workspace.id,
      userId: req.user.id,
      appId: req.body?.appId,
      grants: req.body?.grants ?? [],
      surfaces: req.body?.surfaces ?? null,
      settings: req.body?.settings ?? {},
    }));
  } catch (e) { next(e); }
});

router.delete('/:workspaceId/installations/:installationId', admin, async (req, res, next) => {
  try {
    res.json(await installs.uninstall({
      workspaceId: req.workspace.id,
      installationId: req.params.installationId,
      userId: req.user.id,
      deleteData: req.query.delete_data === 'true',
    }));
  } catch (e) { next(e); }
});

router.post('/:workspaceId/installations/:installationId/enabled', admin, async (req, res, next) => {
  try {
    res.json(await installs.setEnabled({
      workspaceId: req.workspace.id, installationId: req.params.installationId,
      userId: req.user.id, enabled: req.body?.enabled,
    }));
  } catch (e) { next(e); }
});

router.post('/:workspaceId/installations/:installationId/update', admin, async (req, res, next) => {
  try {
    res.json(await installs.update({
      workspaceId: req.workspace.id, installationId: req.params.installationId,
      userId: req.user.id, grants: req.body?.grants ?? [],
    }));
  } catch (e) { next(e); }
});

router.patch('/:workspaceId/installations/:installationId/surfaces/:surfaceId', admin, async (req, res, next) => {
  try {
    res.json(await installs.setSurface({
      workspaceId: req.workspace.id, installationId: req.params.installationId,
      surfaceId: req.params.surfaceId, userId: req.user.id, patch: req.body ?? {},
    }));
  } catch (e) { next(e); }
});

router.post('/:workspaceId/installations/:installationId/permissions', admin, async (req, res, next) => {
  try {
    res.json(await installs.grantPermission({
      workspaceId: req.workspace.id, installationId: req.params.installationId,
      userId: req.user.id, permissionId: req.body?.permissionId,
    }));
  } catch (e) { next(e); }
});

router.delete('/:workspaceId/installations/:installationId/permissions/:permissionId', admin, async (req, res, next) => {
  try {
    res.json(await installs.revokePermission({
      workspaceId: req.workspace.id, installationId: req.params.installationId,
      userId: req.user.id, permissionId: req.params.permissionId,
    }));
  } catch (e) { next(e); }
});

// The URL to put in an iframe, with a one-time code inside it.
router.post('/:workspaceId/installations/:installationId/surfaces/:surfaceId/handoff', async (req, res, next) => {
  try {
    res.json(await oauth.handoff({
      workspaceId: req.workspace.id, installationId: req.params.installationId,
      surfaceId: req.params.surfaceId, userId: req.user.id,
      platformOrigin: config.platformUrl,
    }));
  } catch (e) { next(e); }
});

router.get('/:workspaceId/audit', admin, async (req, res, next) => {
  try { res.json({ entries: await audit.forWorkspace(req.workspace.id) }); } catch (e) { next(e); }
});
