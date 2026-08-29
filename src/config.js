// Every value the platform reads from its environment, in one place.
//
// Nothing below is a literal anywhere else in the source. A port, a store name,
// a token lifetime or the platform's own address changes here or in the
// environment, and nowhere in a handler.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..');

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  // The platform's own version. An app's `requires.platform` is checked against
  // this, so it is read from package.json rather than restated in the code.
  version: packageJson.version,

  databaseUrl: process.env.DATABASE_URL ?? null,
  port: number(process.env.PORT, 4000),

  // Where this platform is reachable. Apps are handed this address so they can
  // load the SDK and call back. It is deliberately not derived from the Host
  // header, which the caller controls.
  get platformUrl() {
    return (process.env.PLATFORM_URL ?? `http://localhost:${this.port}`).replace(/\/$/, '');
  },

  defaultStore: {
    slug: process.env.DEFAULT_STORE_SLUG ?? 'official',
    name: process.env.DEFAULT_STORE_NAME ?? 'Official Store',
  },

  // Origins allowed to call the user-facing API from a browser — the
  // dashboards embedding this platform. Empty means same-origin only, which is
  // the safe default for a deployment that has not said otherwise.
  get dashboardOrigins() {
    return (process.env.DASHBOARD_ORIGINS ?? '')
      .split(',').map(o => o.trim().replace(/\/$/, '')).filter(Boolean);
  },

  sessionTtlSeconds: number(process.env.SESSION_TTL_SECONDS, 60 * 60 * 24 * 30),
  accessTokenTtlSeconds: number(process.env.ACCESS_TOKEN_TTL_SECONDS, 900),
  handoffCodeTtlSeconds: number(process.env.HANDOFF_CODE_TTL_SECONDS, 60),

  // How long the platform waits on an app before giving up on it. An app that
  // hangs must not hold a platform request open.
  appCallTimeoutMs: number(process.env.APP_CALL_TIMEOUT_MS, 10_000),
  eventDeliveryIntervalMs: number(process.env.EVENT_DELIVERY_INTERVAL_MS, 5_000),
};
