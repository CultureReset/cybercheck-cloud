// The platform HTTP surface.
//
//   /v1/auth        humans signing in
//   /v1/catalog     what apps exist
//   /v1/workspaces  what one workspace has installed
//   /v1/oauth       apps trading a handoff code for a scoped token
//   /v1/app         what an app may do with that token
//   /public         the customer-facing page, unauthenticated
//   /sdk            the client library apps load

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
  app.get('/health', (req, res) => res.json({ ok: true, version: config.version }));

  app.use('/v1/auth', auth);
  app.use('/v1/catalog', catalog);
  app.use('/v1/workspaces', workspace);
  app.use('/v1/oauth', oauth);
  app.use('/v1/app', appApi);
  app.use('/public', publicApi);

  // The SDK is served by the platform, from the platform, so an app loads one
  // script tag and never vendors a copy that drifts.
  app.use('/sdk', express.static(path.join(ROOT, 'sdk'), {
    setHeaders: res => res.set('access-control-allow-origin', '*'),
  }));
  // The customer-facing page for one workspace. Same file for every slug; the
  // page reads the slug out of its own URL.
  app.get('/p/:slug', (req, res) => res.sendFile(path.join(ROOT, 'ui', 'public.html')));
  app.use('/', express.static(path.join(ROOT, 'ui')));

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
