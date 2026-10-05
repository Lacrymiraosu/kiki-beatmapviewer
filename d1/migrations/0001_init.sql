create table if not exists users (
  osu_id integer primary key check (osu_id > 0),
  username text not null check (length(username) between 1 and 64),
  avatar_url text check (avatar_url is null or length(avatar_url) <= 300),
  country text check (country is null or length(country) <= 4),
  status text not null default 'active' check (status in ('active', 'suspended')),
  status_reason text check (status_reason is null or length(status_reason) <= 300),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at text,
  last_seen_at text,
  role text not null default 'user' check (role in ('user', 'admin')),
  max_projects integer check (max_projects is null or max_projects between 0 and 1000),
  max_project_bytes integer check (max_project_bytes is null or max_project_bytes between 1000000 and 2000000000),
  retention_days integer check (retention_days is null or retention_days between 1 and 365),
  admin_note text check (admin_note is null or length(admin_note) <= 1000),
  access text not null default 'none' check (access in ('none', 'pending', 'approved', 'denied')),
  access_message text check (access_message is null or length(access_message) <= 300),
  access_requested_at text,
  access_decided_at text,
  access_decided_by integer,
  invite_code text,
  can_invite integer,
  invite_limit integer check (invite_limit is null or invite_limit between 0 and 1000),
  invited_by integer references users (osu_id) on delete set null,
  invited_at text,
  invited_via text,
  invite_fx integer not null default 0,
  invite_fx_allowed integer not null default 0,
  turn_relay integer not null default 0,
  allow_add integer not null default 1,
  prefs text check (prefs is null or length(prefs) <= 20000),
  prefs_at text
);
create unique index if not exists users_invite_code_idx on users (invite_code) where invite_code is not null;
create index if not exists users_invited_by_idx on users (invited_by);
create index if not exists users_access_idx on users (access, access_requested_at);

create table if not exists account_deletions (
  osu_id integer primary key,
  deleted_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

create table if not exists projects (
  id text primary key,
  owner_id integer not null references users (osu_id),
  client_key text not null check (length(client_key) between 8 and 64),
  title text not null default '' check (length(title) <= 300),
  artist text not null default '' check (length(artist) <= 300),
  creator text not null default '' check (length(creator) <= 64),
  source_set_id integer,
  revision integer not null default 0,
  manifest text not null default '[]',
  size_bytes integer not null default 0 check (size_bytes between 0 and 2000000000),
  saved_by integer,
  created_at text not null,
  updated_at text not null,
  expires_at text not null,
  status text not null default 'active' check (status in ('active', 'deleting')),
  delete_reason text,
  cleanup_attempts integer not null default 0,
  cleanup_error text,
  cleanup_at text,
  link_key text,
  expiry_v integer not null default 0,
  unique (owner_id, client_key)
);

CREATE TRIGGER IF NOT EXISTS projects_fix_expiry BEFORE UPDATE OF created_at, expires_at ON projects
WHEN new.created_at IS NOT old.created_at OR (new.expires_at IS NOT old.expires_at AND new.expiry_v IS old.expiry_v)
BEGIN
  SELECT RAISE(ABORT, 'expiry_immutable');
END;
create index if not exists projects_owner on projects (owner_id);
create index if not exists projects_expiry on projects (status, expires_at);

create table if not exists members (
  project_id text not null references projects (id) on delete cascade,
  user_id integer not null references users (osu_id),
  role text not null check (role in ('viewer', 'editor')),
  added_by integer,
  added_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (project_id, user_id)
);
create index if not exists members_user on members (user_id);

create table if not exists saves (
  id text primary key,
  project_id text not null references projects (id) on delete cascade,
  user_id integer not null,
  base_revision integer not null,
  manifest text not null,
  state text not null default 'open' check (state in ('open', 'committed', 'expired')),
  created_at text not null,
  committed_at text,
  revision integer
);
create index if not exists saves_project on saves (project_id, state);

create table if not exists blobs (
  key text primary key,
  project_id text not null references projects (id) on delete restrict,
  size integer not null check (size between 0 and 2000000000),
  sha256 text not null,
  state text not null check (state in ('pending', 'committed', 'orphaned')),
  save_id text,
  created_at text not null,
  orphaned_at text
);
create index if not exists blobs_project on blobs (project_id, state);
create index if not exists blobs_gc on blobs (state, created_at);

create table if not exists annotations (
  id text primary key,
  project_id text not null references projects (id) on delete cascade,
  author_id integer not null references users (osu_id),
  diff text not null check (length(diff) between 1 and 255),
  kind text not null check (kind in ('comment', 'arrow', 'highlight')),
  object_id text check (object_id is null or length(object_id) <= 40),
  time_ms integer not null,
  body text not null default '' check (length(body) <= 2000),
  data text not null default '{}',
  object_missing integer not null default 0,
  version integer not null default 1,
  created_at text not null,
  updated_at text not null
);
create index if not exists annotations_project on annotations (project_id);

create table if not exists settings (
  key text primary key,
  value text not null
);

create table if not exists audit_log (
  id integer primary key autoincrement,
  at text not null,
  actor_id integer,
  action text not null,
  target_type text,
  target_id text,
  detail text not null default '{}'
);
create index if not exists audit_at on audit_log (at);

create table if not exists job_runs (
  id integer primary key autoincrement,
  job text not null,
  started_at text not null,
  finished_at text,
  ok integer,
  detail text not null default '{}'
);

create table if not exists changelog (
  id text primary key,
  title text not null check (length(title) between 1 and 200),
  version_label text not null default '' check (length(version_label) <= 40),
  content_md text not null default '' check (length(content_md) <= 20000),
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at text,
  sort_order integer not null default 0,
  created_at text not null,
  updated_at text not null,
  created_by integer,
  updated_by integer
);
create index if not exists changelog_order on changelog (status, sort_order);

create table if not exists invite_links (
  code text primary key,
  created_by integer not null references users (osu_id),
  max_uses integer not null check (max_uses between 1 and 1000),
  uses integer not null default 0 check (uses >= 0),
  note text check (note is null or length(note) <= 80),
  created_at text not null,
  revoked_at text
);

create table if not exists user_logins (
  provider text not null check (provider = 'google'),
  subject text not null check (length(subject) between 1 and 255),
  osu_id integer not null references users (osu_id) on delete cascade,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at text,
  verified integer not null default 1,
  primary key (provider, subject),
  unique (provider, osu_id)
);

create table if not exists client_errors (
  sig text primary key,
  message text not null,
  source text,
  stack text,
  page text,
  version text,
  browser text,
  count integer not null default 1,
  first_at text not null,
  last_at text not null,
  resolved_at text,
  kind text not null default 'error' check (kind in ('error', 'report')),
  reporter text
);
create index if not exists client_errors_last on client_errors (last_at);

create table if not exists r2_usage (
  month text primary key,
  class_a integer not null default 0,
  class_b integer not null default 0,
  refused_a integer not null default 0,
  refused_b integer not null default 0
);

insert or ignore into settings (key, value) values
  ('access_required', 'true'), ('invitees_can_invite', 'false'), ('invites_per_user', '3'), ('max_annotations', '2000'),
  ('max_members_per_project', '20'), ('max_project_bytes', '30000000'), ('max_projects_per_user', '10'), ('retention_days', '15'),
  ('saving_enabled', 'true'), ('storage_budget_bytes', '900000000');
