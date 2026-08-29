// The customer-facing page.
//
// No session and no logged-in human. Each published surface gets its own
// anonymous handoff code, narrowed to what is safe to hand a stranger, so a
// public form can still write while a public page can still not read the
// workspace's records back out.

import { Router } from 'express';
import * as installs from '../../installs.js';
import { publicHandoff } from '../../oauth.js';
import { config } from '../../config.js';

export const router = Router();

router.get('/:slug/surfaces', async (req, res, next) => {
  try {
    const rows = await installs.publicSurfaces(req.params.slug);

    const surfaces = [];
    for (const row of rows) {
      // One surface failing to produce a URL leaves a gap on the page, not an
      // error instead of the page.
      const url = await publicHandoff({
        workspaceSlug: req.params.slug,
        installationId: row.installation_id,
        surfaceId: row.surface_id,
        platformOrigin: config.platformUrl,
      }).catch(() => null);

      surfaces.push({
        installationId: row.installation_id,
        appId: row.app_id,
        appName: row.app_name,
        surfaceId: row.surface_id,
        title: row.title,
        displayMode: row.display_mode,
        position: row.position,
        url,
      });
    }

    res.json({
      workspace: { slug: req.params.slug, name: rows[0]?.workspace_name ?? null },
      surfaces,
    });
  } catch (e) { next(e); }
});
