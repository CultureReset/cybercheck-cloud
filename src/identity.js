// One login.
//
// This is the piece that makes the difference between an app store and a folder
// of separate products. A person signs in once, here, and every app they open
// afterwards is authorised from that one session without ever seeing it.

import crypto from 'node:crypto';
import { q, one, tx } from './db.js';
import { badRequest, unauthorized, forbidden, notFound, conflict } from './errors.js';
import { hash, randomToken } from './tokens.js';
import { config } from './config.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    throw badRequest('Password must be at least 10 characters');
  }
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function checkPassword(password, stored) {
  if (!stored?.startsWith('scrypt$')) return false;
  const [, salt, expected] = stored.split('$');
  const key = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), SCRYPT.keylen, SCRYPT);
  const expectedBuffer = Buffer.from(expected, 'base64url');
  return key.length === expectedBuffer.length && crypto.timingSafeEqual(key, expectedBuffer);
}

// Registering creates the person, their organisation and their first workspace
// together. A user with nowhere to install anything is not a state worth having.
export async function register({ email, name, password, organizationName }) {
  const normalisedEmail = String(email ?? '').trim().toLowerCase();
  if (!normalisedEmail.includes('@')) throw badRequest('A valid email address is required');
  if (!String(name ?? '').trim()) throw badRequest('A name is required');

  const passwordHash = hashPassword(password);
  const orgName = organizationName?.trim() || `${name.trim()}'s organisation`;

  return tx(async db => {
    const taken = await db.one('select id from platform.users where email = $1', [normalisedEmail]);
    if (taken) throw conflict('That email address is already registered');

    const user = await db.one(
      `insert into platform.users (email, name, password_hash) values ($1, $2, $3)
       returning id, email, name, created_at`,
      [normalisedEmail, name.trim(), passwordHash]
    );
    const org = await db.one(
      `insert into platform.organizations (slug, name) values ($1, $2) returning *`,
      [await freeSlug(db, 'platform.organizations', orgName), orgName]
    );
    await db.q(
      `insert into platform.org_members (organization_id, user_id, role) values ($1, $2, 'owner')`,
      [org.id, user.id]
    );
    const workspace = await db.one(
      `insert into platform.workspaces (organization_id, slug, name) values ($1, $2, $3) returning *`,
      [org.id, await freeSlug(db, 'platform.workspaces', orgName), orgName]
    );
    return { user, organization: org, workspace };
  });
}

export async function signIn({ email, password }) {
  const user = await one(
    'select * from platform.users where email = $1', [String(email ?? '').trim().toLowerCase()]
  );
  // The same message either way: which half was wrong is not the caller's
  // business, and telling them turns a login form into an account enumerator.
  if (!user || !checkPassword(password ?? '', user.password_hash)) {
    throw unauthorized('Email or password is incorrect');
  }
  if (user.status !== 'active') throw forbidden('This account is suspended');
  return { user: publicUser(user), session: await createSession(user.id) };
}

export async function createSession(userId) {
  const token = randomToken();
  const row = await one(
    `insert into platform.sessions (user_id, token_hash, expires_at)
     values ($1, $2, now() + ($3 || ' seconds')::interval) returning id, expires_at`,
    [userId, hash(token), String(config.sessionTtlSeconds)]
  );
  return { token, id: row.id, expiresAt: row.expires_at };
}

export async function resolveSession(token) {
  if (!token) throw unauthorized();
  const row = await one(
    `select s.id as session_id, u.*
       from platform.sessions s join platform.users u on u.id = s.user_id
      where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()`,
    [hash(token)]
  );
  if (!row) throw unauthorized('Session is not valid');
  if (row.status !== 'active') throw forbidden('This account is suspended');
  return { user: publicUser(row), sessionId: row.session_id };
}

export async function signOut(token) {
  await q('update platform.sessions set revoked_at = now() where token_hash = $1 and revoked_at is null', [hash(token)]);
  return { signedOut: true };
}

export async function workspacesFor(userId) {
  return q(
    `select w.id, w.slug, w.name, w.status, o.name as organization, m.role
       from platform.workspaces w
       join platform.organizations o on o.id = w.organization_id
       join platform.org_members m on m.organization_id = o.id and m.user_id = $1
      where w.status = 'active'
      order by w.created_at`,
    [userId]
  );
}

// Every request that names a workspace comes through here. The workspace id in
// a URL is a claim, not a fact, until this has agreed with it.
export async function requireWorkspace(userId, workspaceId, roles = ['owner', 'admin', 'member']) {
  const row = await one(
    `select w.id, w.slug, w.name, w.organization_id, m.role
       from platform.workspaces w
       join platform.org_members m on m.organization_id = w.organization_id and m.user_id = $2
      where w.id = $1 and w.status = 'active'`,
    [workspaceId, userId]
  );
  if (!row) throw notFound('No such workspace');
  if (!roles.includes(row.role)) {
    throw forbidden(`This action needs one of: ${roles.join(', ')}. You are ${row.role}.`);
  }
  return row;
}

export async function membersOf(workspaceId) {
  return q(
    `select u.id, u.name, m.role, m.added_at
       from platform.workspaces w
       join platform.org_members m on m.organization_id = w.organization_id
       join platform.users u on u.id = m.user_id
      where w.id = $1 order by m.added_at`,
    [workspaceId]
  );
}

const publicUser = u => ({ id: u.id, email: u.email, name: u.name, createdAt: u.created_at });

async function freeSlug(db, table, name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    || 'workspace';
  let candidate = base;
  for (let n = 2; await db.one(`select 1 from ${table} where slug = $1`, [candidate]); n++) {
    candidate = `${base}-${n}`;
  }
  return candidate;
}
