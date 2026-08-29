#!/usr/bin/env node
// Applies the migrations and exits. Safe to run repeatedly; each file is
// applied once and recorded.

import { connect, close } from '../src/db.js';
import { ensureStore } from '../src/catalog.js';
import { signingKey } from '../src/tokens.js';
import { config } from '../src/config.js';

await connect();
await signingKey();
await ensureStore({ ...config.defaultStore, kind: 'local' });
console.log(`migrated  ${config.databaseUrl?.replace(/:[^:@/]*@/, ':***@')}`);
await close();
