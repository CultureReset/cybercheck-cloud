#!/usr/bin/env node
// The manifest schema is owned by cybercheck-marketplace — the catalog decides
// what an app may declare. The platform vendors a copy so it can boot without
// that checkout, and `npm test` fails if the two have drifted.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VENDORED = path.join(HERE, '..', 'contract', 'app-manifest.v1.json');
export const CANONICAL = process.env.MARKETPLACE_CONTRACT
  ?? path.join(HERE, '..', '..', 'cybercheck-marketplace', 'contract', 'app-manifest.v1.json');

const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function drift() {
  if (!fs.existsSync(CANONICAL)) return null;      // marketplace not checked out
  return hash(CANONICAL) === hash(VENDORED) ? false : true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!fs.existsSync(CANONICAL)) {
    console.error(`canonical contract not found at ${CANONICAL}`);
    process.exit(1);
  }
  fs.copyFileSync(CANONICAL, VENDORED);
  console.log(`synced ${path.basename(VENDORED)}  sha256:${hash(VENDORED).slice(0, 16)}`);
}
