// Manifest validation and normalisation.
//
// Two jobs, and they are deliberately separate. `validate` decides whether a
// manifest may enter the catalog at all. `normalise` turns an accepted manifest
// into the flat rows the store UI reads, so that nothing downstream ever has to
// trust a manifest again.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { badRequest } from './errors.js';
import { config } from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(HERE, '..', 'contract', 'app-manifest.v1.json');

export const SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const check = ajv.compile(SCHEMA);

export function contentHash(manifest) {
  return 'sha256:' + crypto.createHash('sha256')
    .update(JSON.stringify(manifest, Object.keys(manifest).sort()))
    .digest('hex');
}

// Everything the schema cannot express, because it needs to know what this
// platform actually offers. `knownPermissions` comes from the database.
export function validate(manifest, { knownPermissions = null } = {}) {
  const problems = [];

  if (!check(manifest)) {
    for (const e of check.errors) {
      problems.push(`${e.instancePath || '/'} ${e.message}`);
    }
    throw badRequest('Manifest does not match the app manifest schema', problems);
  }

  if (!satisfies(config.version, manifest.requires?.platform ?? '^1')) {
    problems.push(`requires.platform "${manifest.requires.platform}" is not satisfied by platform ${config.version}`);
  }

  // The id is publisher-prefixed so two publishers cannot fight over a name.
  if (!manifest.id.startsWith(manifest.publisher + '.')) {
    problems.push(`id "${manifest.id}" must start with the publisher prefix "${manifest.publisher}."`);
  }

  if (knownPermissions) {
    for (const p of manifest.permissions ?? []) {
      if (!knownPermissions.has(p.id)) {
        problems.push(`permission "${p.id}" is not a permission this platform grants`);
      }
    }
  }

  // A surface that needs a permission the app never asked for can never render,
  // and the owner would have no way to find out why.
  const asked = new Set((manifest.permissions ?? []).map(p => p.id));
  for (const s of manifest.surfaces ?? []) {
    if (s.requires_permission && !asked.has(s.requires_permission)) {
      problems.push(`surface "${s.id}" requires "${s.requires_permission}", which the manifest does not request`);
    }
  }
  if ((manifest.surfaces ?? []).some(s => s.kind === 'public') && !asked.has('surface.public')) {
    problems.push('a public surface requires the "surface.public" permission');
  }

  // Declaring tables without a namespace would put them somewhere shared.
  if (manifest.data?.tables && !manifest.data.namespace) {
    problems.push('data.tables requires data.namespace');
  }

  const emits = new Set(manifest.events?.emits ?? []);
  if (emits.size && !asked.has('events.emit')) {
    problems.push('emitting events requires the "events.emit" permission');
  }
  if ((manifest.events?.subscribes ?? []).length && !asked.has('events.subscribe')) {
    problems.push('subscribing to events requires the "events.subscribe" permission');
  }
  if ((manifest.capabilities?.consumes ?? []).length && !asked.has('capability.invoke')) {
    problems.push('consuming a capability requires the "capability.invoke" permission');
  }

  // A service-runtime app has no surfaces to render, and a hosted app that
  // declares none is an app the owner installs and can never open.
  if (manifest.runtime.type === 'hosted' && !(manifest.surfaces ?? []).length) {
    problems.push('a hosted app must declare at least one surface');
  }
  if (manifest.runtime.type === 'service' && (manifest.surfaces ?? []).length) {
    problems.push('a service app has no UI and cannot declare surfaces');
  }

  if (problems.length) throw badRequest('Manifest failed validation', problems);
  return true;
}

// The flat, safe projection. The store UI renders these fields and nothing else,
// so a manifest with a surprise in it cannot reach a render path.
export function normalise(manifest) {
  return {
    app: {
      app_id: manifest.id,
      publisher: manifest.publisher,
      name: manifest.name,
      summary: manifest.summary ?? null,
      icon: manifest.icon ?? null,
      categories: manifest.categories ?? [],
      data_namespace: manifest.data?.namespace ?? null,
    },
    version: {
      version: manifest.version,
      content_hash: contentHash(manifest),
    },
    permissions: (manifest.permissions ?? []).map(p => ({
      permission_id: p.id,
      reason: p.reason,
      optional: p.optional ?? false,
    })),
    surfaces: (manifest.surfaces ?? []).map(s => ({
      surface_id: s.id,
      kind: s.kind,
      title: s.title ?? manifest.name,
      icon: s.icon ?? null,
      path: s.path,
      display_modes: s.display_modes ?? ['page'],
      requires_permission: s.requires_permission ?? null,
    })),
    capabilities: [
      ...(manifest.capabilities?.provides ?? []).map(c => ({
        capability_id: c.id, direction: 'provides', summary: c.summary ?? null, path: c.path ?? '/capabilities/' + c.id,
      })),
      ...(manifest.capabilities?.consumes ?? []).map(id => ({
        capability_id: id, direction: 'consumes', summary: null, path: null,
      })),
    ],
    events: [
      ...(manifest.events?.emits ?? []).map(e => ({ event_id: e, direction: 'emits', path: null })),
      ...(manifest.events?.subscribes ?? []).map(s => ({ event_id: s.event, direction: 'subscribes', path: s.path })),
    ],
    pricing: manifest.pricing ?? { model: 'free' },
    tables: manifest.data?.tables ?? {},
  };
}

// Caret and bare ranges only. The manifest schema does not accept anything
// richer, so neither does this.
export function satisfies(version, range) {
  const v = version.split('-')[0].split('.').map(Number);
  const caret = range.startsWith('^');
  const r = range.replace(/^\^/, '').split('.').map(Number);
  if (v[0] !== r[0]) return false;
  if (caret) return r[1] === undefined || v[1] > r[1] || (v[1] === r[1] && (r[2] === undefined || v[2] >= r[2]));
  for (let i = 1; i < r.length; i++) if (v[i] !== r[i]) return false;
  return true;
}
