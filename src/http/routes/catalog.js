import { Router } from 'express';
import * as catalog from '../../catalog.js';
import { validate as validateManifest } from '../../manifest.js';
import { q } from '../../db.js';
import { requireUser } from '../auth.js';
import { config } from '../../config.js';

export const router = Router();

// Deliberately unauthenticated: the permission vocabulary is what a developer
// writes a manifest against, and needing an account to read a contract is a
// reason not to build on a platform.
router.get('/permissions', async (req, res, next) => {
  try {
    res.json({
      permissions: await q(
        'select id, title, description, sensitive, public_safe from platform.permissions order by id'
      ),
    });
  } catch (e) { next(e); }
});

// Same, and for the same reason: checking a manifest is not an act that needs
// an identity. It writes nothing.
router.post('/validate', async (req, res, next) => {
  try {
    validateManifest(req.body?.manifest ?? req.body, { knownPermissions: await catalog.knownPermissions() });
    res.json({ valid: true });
  } catch (e) { next(e); }
});

// Browsing does not require a workspace. Passing one only adds "installed"
// flags to the entries.
router.get('/apps', requireUser, async (req, res, next) => {
  try {
    res.json({
      apps: await catalog.index({
        workspaceId: req.query.workspace ?? null,
        category: req.query.category ?? null,
        search: req.query.q ?? null,
      }),
    });
  } catch (e) { next(e); }
});

router.get('/apps/:appId', requireUser, async (req, res, next) => {
  try {
    res.json(await catalog.detail(req.params.appId, { workspaceId: req.query.workspace ?? null }));
  } catch (e) { next(e); }
});

router.get('/stores', requireUser, async (req, res, next) => {
  try { res.json({ stores: await catalog.listStores() }); } catch (e) { next(e); }
});

// Publishing is how an app gets in. In this build any signed-in developer may
// publish to the local store; a hosted deployment puts an approval in front.
router.post('/publish', requireUser, async (req, res, next) => {
  try {
    const result = await catalog.publish({
      manifest: req.body?.manifest ?? req.body,
      storeSlug: req.body?.store ?? config.defaultStore.slug,
      channel: req.body?.channel ?? 'stable',
    });
    res.status(201).json(result);
  } catch (e) { next(e); }
});
