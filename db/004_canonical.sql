-- Canonical objects and the permission vocabulary.
--
-- An app's own tables need no permission — they belong to it. Permissions
-- exist for the things every app shares: the workspace, its people, and the
-- records below. This is the part that makes two apps worth more than one.

create table platform.contacts (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references platform.workspaces (id) on delete cascade,
  name         text not null check (length(trim(name)) > 0),
  email        text check (email is null or email like '%@%'),
  phone        text,
  tags         jsonb not null default '[]'::jsonb,
  attributes   jsonb not null default '{}'::jsonb,

  -- Which installation last wrote this row. Not ownership — a contact belongs
  -- to the workspace — but an app that uninstalls should not take it away.
  source_installation_id uuid references platform.installations (id) on delete set null,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint contact_is_reachable check (email is not null or phone is not null)
);

create index contacts_workspace_idx on platform.contacts (workspace_id);
create unique index contacts_email_idx on platform.contacts (workspace_id, lower(email))
  where email is not null;

insert into platform.permissions (id, title, description, sensitive, public_safe) values
  ('workspace.profile.read', 'Read workspace profile',
   'See the workspace name, slug and organisation.', false, false),
  ('workspace.profile.write', 'Update workspace profile',
   'Change the workspace name and public details.', true, false),
  ('workspace.members.read', 'See who is in the workspace',
   'List members and their roles. Does not include email addresses.', false, false),
  ('contacts.read', 'Read contacts',
   'Read the shared contact records in this workspace.', true, false),
  ('contacts.write', 'Create and update contacts',
   'Add contacts and change existing ones. Cannot delete.', true, true),
  ('contacts.delete', 'Delete contacts',
   'Permanently remove contact records.', true, false),
  ('events.emit', 'Publish events',
   'Announce that something happened so other installed apps can react.', false, true),
  ('events.subscribe', 'Receive events',
   'Be notified when other apps publish events in this workspace.', false, false),
  ('capability.invoke', 'Call other apps',
   'Invoke capabilities that other installed apps provide.', false, false),
  ('surface.public', 'Appear on the public page',
   'Render on the workspace''s customer-facing page.', false, true);
