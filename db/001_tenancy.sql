-- Tenancy and human identity.
--
-- One login reaches every app, so the login has to live here and nowhere else.
-- An app never sees a password, a session, or another app's token.

create schema if not exists platform;
create schema if not exists appdata;

-- A lowercase, dotted or hyphenated identifier that appears in a contract:
-- app ids, permission ids, slugs. Anything a developer types into a manifest
-- and the platform later matches on.
create domain platform.contract_id as text
  check (value ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$' and length(value) <= 96);

create domain platform.semver as text
  check (value ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$');

create table platform.users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique check (email = lower(email) and email like '%@%'),
  name          text not null check (length(trim(name)) > 0),
  password_hash text,
  status        text not null default 'active' check (status in ('active', 'suspended')),
  created_at    timestamptz not null default now()
);

create table platform.organizations (
  id         uuid primary key default gen_random_uuid(),
  slug       platform.contract_id not null unique,
  name       text not null check (length(trim(name)) > 0),
  status     text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now()
);

create table platform.org_members (
  organization_id uuid not null references platform.organizations (id) on delete cascade,
  user_id         uuid not null references platform.users (id) on delete cascade,
  role            text not null check (role in ('owner', 'admin', 'member', 'viewer')),
  added_at        timestamptz not null default now(),
  primary key (organization_id, user_id)
);

-- A workspace is the thing an app is installed into. Everything an app can
-- read or write is scoped to exactly one of these.
create table platform.workspaces (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references platform.organizations (id) on delete cascade,
  slug            platform.contract_id not null unique,
  name            text not null check (length(trim(name)) > 0),
  status          text not null default 'active' check (status in ('active', 'suspended')),
  created_at      timestamptz not null default now()
);

-- Browser sessions for the platform itself. Apps never receive one of these;
-- they receive a scoped token minted from one.
create table platform.sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references platform.users (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint sessions_expire_after_creation check (expires_at > created_at)
);

create index sessions_user_idx on platform.sessions (user_id) where revoked_at is null;

-- The permissions an app may ask for. An app requesting one that is not in
-- this table fails to publish, so the consent screen can never show an
-- invented permission with an invented explanation.
create table platform.permissions (
  id          platform.contract_id primary key,
  title       text not null,
  description text not null,
  sensitive   boolean not null default false,

  -- May an anonymous visitor on a public surface carry this? A public surface
  -- runs for whoever loads the page, so anything that reads the workspace's own
  -- records back out must not travel with it.
  public_safe boolean not null default false
);

-- Signing keys for app access tokens. Rotating means inserting a new row;
-- old tokens keep verifying against the retired key until they expire.
create table platform.signing_keys (
  kid         text primary key,
  algorithm   text not null default 'RS256' check (algorithm = 'RS256'),
  public_pem  text not null,
  private_pem text not null,
  created_at  timestamptz not null default now(),
  retired_at  timestamptz
);
