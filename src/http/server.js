// The platform HTTP surface.
//
//   /v1/auth        humans signing in
//   /v1/catalog     what apps exist
//   /v1/workspaces  what one workspace has installed
//   /v1/oauth       apps trading a handoff code for a scoped token
//   /v1/app         what an app may do with that token
//   /public         published surfaces for a workspace's customer-facing page
//   /sdk            the client libraries: app.js for apps, host.js for hosts
//
// There are no pages here. The platform renders nothing — it answers, and the
// dashboard embedding it draws. A store that ships its own website is a second
// place for a customer to log in and a second thing to restyle.

import path from 'node:path';
import express from 'express';
import { connect } from '../db.js';
import { ensureStore } from '../catalog.js';
import { signingKey } from '../tokens.js';
import { deliverPending } from '../events.js';
import { PlatformError } from '../errors.js';
import { config, ROOT } from '../config.js';

import { router as auth } from './routes/auth.js';
import { router as catalog } from './routes/catalog.js';
import { router as workspace } from './routes/workspace.js';
import { router as oauth } from './routes/oauth.js';
import { router as appApi } from './routes/app.js';
import { router as publicApi } from './routes/public.js';

export function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Carries the version so a developer's tooling can pin a compatibility range
  // without being told what to pin it to.
  // A dashboard embedding the store runs on its own origin and authenticates
  // with a bearer token, never a cookie — so credentials are deliberately not
  // allowed here, and an origin that is not on the list gets no CORS headers
  // at all rather than a partial set that half works.
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && config.dashboardOrigins.includes(origin.replace(/\/$/, ''))) {
      res.set('access-control-allow-origin', origin);
      res.set('access-control-allow-headers', 'authorization, content-type');
      res.set('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.set('access-control-max-age', '600');
      res.set('vary', 'origin');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true, version: config.version }));

  app.use('/v1/auth', auth);
  app.use('/v1/catalog', catalog);
  app.use('/v1/workspaces', workspace);
  app.use('/v1/oauth', oauth);
  app.use('/v1/app', appApi);
  app.use('/public', publicApi);

  // The SDK, served by the platform and versioned with it. Apps load app.js;
  // whatever dashboard is embedding the store loads host.js. Both come from
  // here so the origin check that the whole security model rests on has one
  // implementation, not one per front end.
  app.use('/sdk', express.static(path.join(ROOT, 'sdk'), {
    setHeaders: res => res.set('access-control-allow-origin', '*'),
  }));

  app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'No such route' } }));

  app.use((error, req, res, next) => {
    if (error instanceof PlatformError) {
      return res.status(error.status).json({
        error: { code: error.code, message: error.message, detail: error.detail },
      });
    }
    // An unexpected error is a bug, not a message for the caller. It goes to the
    // log in full and to the client as five words.
    console.error(`[${req.method} ${req.originalUrl}]`, error);
    res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong' } });
  });

  return app;
}

export async function start({ port = config.port } = {}) {
  await connect();
  await signingKey();
  await ensureStore({ ...config.defaultStore, kind: 'local' });

  const app = createServer();
  const server = app.listen(port, () => console.log(`platform listening on ${config.platformUrl}`));

  // Delivery is a loop, not a request. An app that is down delays its own
  // events and nobody else's.
  const timer = setInterval(() => {
    deliverPending().catch(e => console.error('event delivery:', e.message));
  }, config.eventDeliveryIntervalMs);
  timer.unref();

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().catch(e => { console.error(e); process.exit(1); });
}
