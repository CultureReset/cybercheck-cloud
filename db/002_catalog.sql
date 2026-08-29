-- The catalog: what apps exist.
--
-- A store is a source of apps, not the platform itself. A workspace can enable
-- several, which is the whole difference between an app store and an ecosystem
-- somebody else controls.

create table platform.stores (
  id         uuid primary key default gen_random_uuid(),
  slug       platform.contract_id not null unique,
  name       text not null check (length(trim(name)) > 0),
  kind       text not null check (kind in ('local', 'remote')),
  url        text,
  public_key text,
  enabled    boolean not null default true,
  added_at   timestamptz not null default now(),

  -- A remote store is fetched over the network, so it needs somewhere to fetch
  -- from and a key to check the index it gets back.
  constraint remote_store_has_url check (kind <> 'remote' or url is not null)
);

create table platform.apps (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references platform.stores (id) on delete cascade,
  app_id         platform.contract_id not null,
  publisher      platform.contract_id not null,
  name           text not null,
  summary        text,
  icon           text,
  categories     jsonb not null default '[]'::jsonb,
  data_namespace platform.contract_id,
  created_at     timestamptz not null default now(),

  unique (store_id, app_id)
);

-- Two apps sharing a data namespace would share tables. The namespace is the
-- boundary, so it is unique across every store this platform trusts.
create unique index apps_namespace_idx on platform.apps (data_namespace)
  where data_namespace is not null;

create table platform.app_versions (
  id           uuid primary key default gen_random_uuid(),
  app_row_id   uuid not null references platform.apps (id) on delete cascade,
  version      platform.semver not null,
  manifest     jsonb not null,
  content_hash text not null,
  published_at timestamptz not null default now(),

  unique (app_row_id, version),
  -- The manifest is the source of truth and it is immutable once published.
  -- The id lets a release point at a version and prove it belongs to this app.
  unique (id, app_row_id)
);

-- A channel points at exactly one current version. Two versions both claiming
-- to be current stable is the ambiguity this prevents.
create table platform.releases (
  id             uuid primary key default gen_random_uuid(),
  app_row_id     uuid not null references platform.apps (id) on delete cascade,
  channel        text not null check (channel in ('stable', 'beta', 'dev')),
  app_version_id uuid not null,
  released_at    timestamptz not null default now(),

  unique (app_row_id, channel),
  foreign key (app_version_id, app_row_id)
    references platform.app_versions (id, app_row_id) on delete cascade
);

-- Everything below is derived from the manifest at publish time. The store UI
-- reads these rows, never the raw manifest: a malformed manifest that got past
-- validation still cannot reach a rendering path.

create table platform.app_declared_permissions (
  app_version_id uuid not null references platform.app_versions (id) on delete cascade,
  permission_id  platform.contract_id not null references platform.permissions (id),
  reason         text not null,
  optional       boolean not null default false,
  primary key (app_version_id, permission_id)
);

create table platform.app_declared_surfaces (
  id             uuid primary key default gen_random_uuid(),
  app_version_id uuid not null references platform.app_versions (id) on delete cascade,
  surface_id     platform.contract_id not null,
  kind           text not null check (kind in ('dashboard', 'settings', 'public', 'widget', 'standalone')),
  title          text,
  icon           text,
  path           text not null check (path like '/%'),
  display_modes  jsonb not null default '[]'::jsonb,
  requires_permission platform.contract_id,

  unique (app_version_id, surface_id)
);

create table platform.app_declared_capabilities (
  app_version_id uuid not null references platform.app_versions (id) on delete cascade,
  capability_id  platform.contract_id not null,
  direction      text not null check (direction in ('provides', 'consumes')),
  summary        text,
  path           text,
  primary key (app_version_id, capability_id, direction),

  -- A provided capability is reachable at a path on the app; a consumed one is
  -- a name the app calls. Only one of the two carries a path.
  constraint provided_capability_has_path check (direction <> 'provides' or path is not null)
);

create table platform.app_declared_events (
  app_version_id uuid not null references platform.app_versions (id) on delete cascade,
  event_id       platform.contract_id not null,
  direction      text not null check (direction in ('emits', 'subscribes')),
  path           text,
  primary key (app_version_id, event_id, direction),

  constraint subscription_has_path check (direction <> 'subscribes' or path is not null)
);

create table platform.app_pricing (
  app_version_id uuid primary key references platform.app_versions (id) on delete cascade,
  model          text not null check (model in ('free', 'flat', 'usage')),
  amount         numeric(12,2),
  currency       text check (currency ~ '^[A-Z]{3}$'),
  interval       text check (interval in ('month', 'year')),

  -- A free app carries no price; a priced one carries both halves of a price.
  constraint pricing_matches_model check (
    (model = 'free' and amount is null and currency is null)
    or (model <> 'free' and amount is not null and currency is not null)
  )
);
