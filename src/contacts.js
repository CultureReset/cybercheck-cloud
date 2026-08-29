// A canonical object.
//
// Contacts belong to the workspace, not to whichever app created them. That is
// the whole argument for installing a second app: it can see what the first one
// wrote. An app reaches these only with contacts.read / contacts.write, and
// uninstalling the app that created a contact does not take the contact away.

import { q, one } from './db.js';
import { badRequest, notFound } from './errors.js';

export async function list({ workspaceId, search = null, limit = 100, offset = 0 }) {
  return q(
    `select id, name, email, phone, tags, attributes, created_at, updated_at
       from platform.contacts
      where workspace_id = $1
        and ($2::text is null or name ilike '%' || $2 || '%' or coalesce(email,'') ilike '%' || $2 || '%')
      order by updated_at desc limit $3 offset $4`,
    [workspaceId, search, Math.min(Number(limit) || 100, 500), Number(offset) || 0]
  );
}

export async function upsert({ workspaceId, installationId, contact }) {
  const { name, email = null, phone = null, tags = [], attributes = {} } = contact ?? {};
  if (!String(name ?? '').trim()) throw badRequest('A contact needs a name');
  if (!email && !phone) throw badRequest('A contact needs an email address or a phone number');

  // Matching on email is what makes two apps agree they mean the same person.
  if (email) {
    const existing = await one(
      'select id from platform.contacts where workspace_id = $1 and lower(email) = lower($2)',
      [workspaceId, email]
    );
    if (existing) {
      return one(
        `update platform.contacts
            set name = $3, phone = coalesce($4, phone),
                tags = $5, attributes = attributes || $6, updated_at = now()
          where id = $1 and workspace_id = $2 returning *`,
        [existing.id, workspaceId, name.trim(), phone, JSON.stringify(tags), JSON.stringify(attributes)]
      );
    }
  }

  return one(
    `insert into platform.contacts (workspace_id, name, email, phone, tags, attributes, source_installation_id)
     values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [workspaceId, name.trim(), email, phone, JSON.stringify(tags), JSON.stringify(attributes), installationId]
  );
}

export async function remove({ workspaceId, id }) {
  const row = await one(
    'delete from platform.contacts where workspace_id = $1 and id = $2 returning id', [workspaceId, id]
  );
  if (!row) throw notFound('No such contact');
  return { deleted: row.id };
}
