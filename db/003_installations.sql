-- Installation state: what one workspace actually has.
--
-- Installed, enabled, published and data-deleted are four different things and
-- they stay four different things. Collapsing them is how a platform ends up
-- deleting a customer's records because they hid a card.

create table platform.installations (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references platform.workspaces (id) on delete cascade,
  app_row_id         uuid not null references platform.apps (id) on delete restrict,
  app_version_id     uuid not null references platform.app_versions (id) on delete restrict,

  -- A copy, not a reference. A later catalog change must never retroactively
  -- widen what a running install is allowed to do.
  pinned_manifest    jsonb not null,

  status             text not null default 'pending'
                       check (status in ('pending', 'installed', 'failed', 'uninstalled')),
  enabled            boolean not null default true,
  settings           jsonb not null default '{}'::jsonb,

  -- Hashed, like any other credential. Used by service-runtime apps that call
  -- the platform without a user in the room.
  client_secret_hash text,

  installed_by       uuid references platform.users (id),
  installed_at       timestamptz,
  uninstalled_at     timestamptz,
  failure_reason     text,
  created_at         timestamptz not null default now(),

  constraint installed_records_when check (status <> 'installed' or installed_at is not null),
  constraint failed_records_why check (status <> 'failed' or failure_reason is not null),
  constraint uninstalled_records_when check (status <> 'uninstalled' or uninstalled_at is not null)
);

-- One live installation per app per workspace. Uninstalled rows stay, so
-- history survives and reinstalling is a real operation rather than a lie.
create unique index installations_one_live_idx
  on platform.installations (workspace_id, app_row_id)
  where status <> 'uninstalled';

create index installations_workspace_idx on platform.installations (workspace_id)
  where status = 'installed';

create table platform.installation_permissions (
  installation_id uuid not null references platform.installations (id) on delete cascade,
  permission_id   platform.contract_id not null references platform.permissions (id),
  granted_at      timestamptz not null default now(),
  granted_by      uuid references platform.users (id),
  revoked_at      timestamptz,
  primary key (installation_id, permission_id)
);

-- The scope check runs on every app request, so it reads from an index.
create index installation_permissions_live_idx
  on platform.installation_permissions (installation_id)
  where revoked_at is null;

-- An app declares where it *can* appear. This table is where the owner said it
-- may. A surface the owner never enabled is never rendered and never handed a
-- token.
create table platform.installation_surfaces (
  id              uuid primary key default gen_random_uuid(),
  installation_id uuid not null references platform.installations (id) on delete cascade,
  surface_id      platform.contract_id not null,
  kind            text not null check (kind in ('dashboard', 'settings', 'public', 'widget', 'standalone')),
  title           text,
  path            text not null check (path like '/%'),
  display_mode    text,
  enabled         boolean not null default true,
  published       boolean not null default false,
  position        integer not null default 0,

  unique (installation_id, surface_id),

  -- Only a public surface can be published to the customer-facing page.
  constraint only_public_surfaces_publish check (published = false or kind = 'public')
);

-- Physical tables the platform created on an app's behalf. The app never holds
-- DDL rights; it declares tables and the platform provisions them.
create table platform.provisioned_tables (
  id            uuid primary key default gen_random_uuid(),
  app_row_id    uuid not null references platform.apps (id) on delete cascade,
  namespace     platform.contract_id not null,
  logical_name  platform.contract_id not null,
  physical_name text not null unique,
  columns       jsonb not null,

  -- What an anonymous visitor on a public surface may do here. Default none:
  -- a table is private until the manifest says otherwise.
  public_access text not null default 'none'
                  check (public_access in ('none', 'append', 'read', 'read-append')),
  created_at    timestamptz not null default now(),

  unique (namespace, logical_name)
);

-- One-time codes exchanged for a scoped app token. Short-lived, single-use,
-- and redeemable from exactly one origin: the app's own. A code that leaks out
-- of the frame is not redeemable anywhere it could do harm.
create table platform.authorization_codes (
  code_hash       text primary key,
  installation_id uuid not null references platform.installations (id) on delete cascade,
  user_id         uuid references platform.users (id) on delete cascade,
  surface_id      platform.contract_id,
  bound_origin    text not null,
  code_challenge  text,
  scope           jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  used_at         timestamptz,

  constraint codes_expire_after_creation check (expires_at > created_at)
);

create table platform.audit_log (
  id              bigserial primary key,
  workspace_id    uuid references platform.workspaces (id) on delete set null,
  installation_id uuid references platform.installations (id) on delete set null,
  actor_user_id   uuid references platform.users (id) on delete set null,
  action          text not null,
  detail          jsonb not null default '{}'::jsonb,
  at              timestamptz not null default now()
);

create index audit_log_workspace_idx on platform.audit_log (workspace_id, at desc);

-- Events an app emitted, waiting to be delivered to apps that subscribed.
create table platform.event_outbox (
  id              bigserial primary key,
  workspace_id    uuid not null references platform.workspaces (id) on delete cascade,
  installation_id uuid references platform.installations (id) on delete set null,
  event           platform.contract_id not null,
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz,
  attempts        integer not null default 0,
  last_error      text
);

create index event_outbox_pending_idx on platform.event_outbox (created_at)
  where delivered_at is null;
