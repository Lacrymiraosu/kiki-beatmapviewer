-- beatmap viewer: cloud projects, sharing, annotations, admin and the changelog.
--
-- How access works
-- * Every table lives in schema `obv`, which is NOT exposed through the Data API (PostgREST exposes `public`).
-- * The browser never talks to the database. The server (Vercel functions) verifies the osu! login, then calls the
--   public.obv_* functions below with the secret key. Only `service_role` may execute them.
-- * Every function re-checks the caller (p_actor = verified osu! user id): account status, project role, expiry.
-- * RLS is enabled on every table with no policy for anon/authenticated (deny all), except published changelog
--   entries, which anyone may read.
-- * Project files are in the private Storage bucket `obv-projects` (no Storage policies: only the server can sign URLs).
--
-- Limits: 30,000,000 bytes per project (all files together), projects expire 15 days after they were first created
-- in the cloud (saving never extends it), changelog entries never expire.

create schema if not exists obv;
revoke all on schema obv from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema obv from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on schema obv from authenticated'; end if;
end $$;
grant usage on schema obv to service_role;

-- ---------- constants ----------
create or replace function obv.max_project_bytes() returns bigint language sql immutable as $$ select 30000000::bigint $$;
create or replace function obv.retention() returns interval language sql immutable as $$ select interval '15 days' $$;
create or replace function obv.bucket() returns text language sql immutable as $$ select 'obv-projects'::text $$;

-- tunables (change with SQL; read by the functions)
create table obv.settings (
  key text primary key,
  value jsonb not null
);
insert into obv.settings (key, value) values
  ('max_projects_per_user', '10'),          -- active cloud projects one user may own
  ('storage_budget_bytes', '900000000'),    -- refuse new uploads above this total (Free plan storage is 1 GB)
  ('max_annotations', '2000');              -- per project
create or replace function obv.setting(p_key text) returns jsonb language sql stable set search_path = obv, pg_temp
  as $$ select value from obv.settings where key = p_key $$;

-- raise an error the server understands: message "OBV:<code>", optional JSON detail
create or replace function obv.err(p_code text, p_detail jsonb default null) returns void language plpgsql as $$
begin
  raise exception using message = 'OBV:' || p_code, detail = coalesce(p_detail::text, '');
end $$;

-- ---------- tables ----------
create table obv.users (
  osu_id bigint primary key check (osu_id > 0),
  username text not null check (char_length(username) between 1 and 64),
  avatar_url text check (avatar_url is null or char_length(avatar_url) <= 300),
  country text check (country is null or char_length(country) <= 4),
  status text not null default 'active' check (status in ('active', 'suspended')),
  status_reason text check (status_reason is null or char_length(status_reason) <= 300),
  created_at timestamptz not null default now(),
  last_login_at timestamptz,
  last_seen_at timestamptz
);

create table obv.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id bigint not null references obv.users (osu_id),
  client_key text not null check (char_length(client_key) between 8 and 64),  -- idempotency key from the browser
  title text not null default '' check (char_length(title) <= 300),
  artist text not null default '' check (char_length(artist) <= 300),
  creator text not null default '' check (char_length(creator) <= 64),
  source_set_id bigint,                          -- osu! beatmapset id when the map came from osu!
  revision int not null default 0,               -- 0 = created, nothing committed yet
  manifest jsonb not null default '[]'::jsonb,   -- [{path, key, size, sha256}] of the committed revision
  size_bytes bigint not null default 0 check (size_bytes between 0 and 30000000),
  saved_by bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'deleting')),
  delete_reason text,
  cleanup_attempts int not null default 0,
  cleanup_error text,
  cleanup_at timestamptz,
  unique (owner_id, client_key)
);
create index projects_owner on obv.projects (owner_id);
create index projects_expiry on obv.projects (status, expires_at);

-- expiry is fixed when the project is created and can never change (saving, opening or admin edits don't extend it)
create or replace function obv.projects_fix_expiry() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.expires_at := new.created_at + obv.retention();
  elsif new.expires_at is distinct from old.expires_at or new.created_at is distinct from old.created_at then
    perform obv.err('expiry_immutable');
  end if;
  return new;
end $$;
create trigger projects_fix_expiry before insert or update on obv.projects for each row execute function obv.projects_fix_expiry();

create table obv.members (
  project_id uuid not null references obv.projects (id) on delete cascade,
  user_id bigint not null references obv.users (osu_id),
  role text not null check (role in ('viewer', 'editor')),
  added_by bigint,
  added_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index members_user on obv.members (user_id);

-- every Storage object the app ever signs an upload for is recorded here first, so nothing can be left behind:
-- a project row can only be deleted after all of its blob rows are gone (on delete restrict), and a blob row is only
-- deleted after the object is confirmed gone from storage.objects.
create table obv.blobs (
  key text primary key check (key ~ '^p/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
  project_id uuid not null references obv.projects (id) on delete restrict,
  size bigint not null check (size between 0 and 30000000),   -- declared at upload, verified against storage at commit
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('pending', 'committed', 'orphaned')),
  save_id uuid,
  created_at timestamptz not null default now(),
  orphaned_at timestamptz
);
create index blobs_project on obv.blobs (project_id, state);
create index blobs_gc on obv.blobs (state, created_at);

create table obv.saves (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references obv.projects (id) on delete cascade,
  user_id bigint not null,
  base_revision int not null,
  manifest jsonb not null,
  state text not null default 'open' check (state in ('open', 'committed', 'expired')),
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  revision int
);
create index saves_project on obv.saves (project_id, state);

-- modding annotations: stored apart from the .osu data, attached to a stable object id + time
create table obv.annotations (
  id uuid primary key,
  project_id uuid not null references obv.projects (id) on delete cascade,
  author_id bigint not null references obv.users (osu_id),
  diff text not null check (char_length(diff) between 1 and 255),         -- the .osu file inside the project
  kind text not null check (kind in ('comment', 'arrow', 'highlight')),
  object_id text check (object_id is null or char_length(object_id) <= 40),  -- stable object id (null = time only)
  time_ms int not null,
  body text not null default '' check (char_length(body) <= 2000),
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) <= 2048),
  object_missing boolean not null default false,  -- the object was deleted: never re-attached to another one
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index annotations_project on obv.annotations (project_id);

create table obv.audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_id bigint,
  action text not null,
  target_type text,
  target_id text,
  detail jsonb not null default '{}'::jsonb
);
create index audit_at on obv.audit_log (at desc);

create table obv.job_runs (
  id bigserial primary key,
  job text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  detail jsonb not null default '{}'::jsonb
);

-- release notes: permanent content, never touched by project expiry or cleanup
create table obv.changelog (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 200),
  version_label text not null default '' check (char_length(version_label) <= 40),
  content_md text not null default '' check (char_length(content_md) <= 20000),
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  updated_by bigint
);
create index changelog_order on obv.changelog (status, sort_order desc);

-- ---------- row level security (deny by default) ----------
alter table obv.settings enable row level security;
alter table obv.users enable row level security;
alter table obv.projects enable row level security;
alter table obv.members enable row level security;
alter table obv.blobs enable row level security;
alter table obv.saves enable row level security;
alter table obv.annotations enable row level security;
alter table obv.audit_log enable row level security;
alter table obv.job_runs enable row level security;
alter table obv.changelog enable row level security;

revoke all on all tables in schema obv from public;
revoke all on all sequences in schema obv from public;
grant all on all tables in schema obv to service_role;
grant usage, select on all sequences in schema obv to service_role;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema obv from anon';
    execute 'grant usage on schema obv to anon';
    execute 'grant select on obv.changelog to anon';
    execute 'create policy changelog_published_read_anon on obv.changelog for select to anon using (status = ''published'')';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema obv from authenticated';
    execute 'grant usage on schema obv to authenticated';
    execute 'grant select on obv.changelog to authenticated';
    execute 'create policy changelog_published_read_auth on obv.changelog for select to authenticated using (status = ''published'')';
  end if;
end $$;

-- ---------- private Storage bucket ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('obv-projects', 'obv-projects', false, 30000000)
on conflict (id) do update set public = false, file_size_limit = 30000000;

-- ---------- helpers ----------
create or replace function obv.active_user(p_actor bigint) returns obv.users language plpgsql stable set search_path = obv, pg_temp as $$
declare u obv.users;
begin
  select * into u from obv.users where osu_id = p_actor;
  if not found then perform obv.err('no_user'); end if;
  if u.status <> 'active' then perform obv.err('suspended', jsonb_build_object('reason', u.status_reason)); end if;
  return u;
end $$;

-- the caller's role in a live project: owner | editor | viewer. Raises not_found / expired otherwise.
create or replace function obv.access(p_actor bigint, p_project uuid) returns text language plpgsql stable set search_path = obv, pg_temp as $$
declare p obv.projects; r text;
begin
  select * into p from obv.projects where id = p_project;
  if not found then perform obv.err('not_found'); end if;
  if p.owner_id = p_actor then r := 'owner';
  else select role into r from obv.members where project_id = p_project and user_id = p_actor; end if;
  if r is null then perform obv.err('not_found'); end if;              -- don't reveal other people's projects
  if p.status <> 'active' then perform obv.err('not_found'); end if;
  if p.expires_at <= now() then perform obv.err('expired', jsonb_build_object('expires_at', p.expires_at)); end if;
  return r;
end $$;

create or replace function obv.project_json(p obv.projects, p_role text) returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object(
    'id', p.id, 'title', p.title, 'artist', p.artist, 'creator', p.creator, 'source_set_id', p.source_set_id,
    'revision', p.revision, 'size_bytes', p.size_bytes, 'limit_bytes', obv.max_project_bytes(),
    'created_at', p.created_at, 'updated_at', p.updated_at, 'expires_at', p.expires_at,
    'owner', (select jsonb_build_object('id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url) from obv.users u where u.osu_id = p.owner_id),
    'saved_by', (select jsonb_build_object('id', u.osu_id, 'username', u.username) from obv.users u where u.osu_id = p.saved_by),
    'role', p_role)
$$;

create or replace function obv.audit(p_actor bigint, p_action text, p_type text, p_id text, p_detail jsonb default '{}'::jsonb)
returns void language sql set search_path = obv, pg_temp as $$
  insert into obv.audit_log (actor_id, action, target_type, target_id, detail) values (p_actor, p_action, p_type, p_id, coalesce(p_detail, '{}'::jsonb))
$$;

create or replace function obv.to_int(p text) returns int language plpgsql immutable as $$
begin
  if p is null or p !~ '^-?\d{1,10}(\.\d+)?$' then return null; end if;
  return round(p::numeric)::int;
exception when others then return null;
end $$;
create or replace function obv.to_bool(p text) returns boolean language sql immutable as $$
  select case lower(coalesce(p, '')) when 'true' then true when 'false' then false end
$$;

create or replace function obv.valid_path(p text) returns boolean language sql immutable as $$
  select p is not null and char_length(p) between 1 and 255 and p !~ '[\x00-\x1f\\]' and left(p, 1) <> '/'
     and p !~ '(^|/)\.\.?(/|$)' and p !~ '//'
$$;

-- ---------- users ----------
create or replace function public.obv_user_login(p_id bigint, p_username text, p_avatar text, p_country text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users;
begin
  if p_id is null or p_id <= 0 then perform obv.err('bad_user'); end if;
  insert into obv.users (osu_id, username, avatar_url, country, last_login_at, last_seen_at)
  values (p_id, left(p_username, 64), left(p_avatar, 300), left(p_country, 4), now(), now())
  on conflict (osu_id) do update set username = excluded.username, avatar_url = excluded.avatar_url,
    country = excluded.country, last_login_at = now(), last_seen_at = now()
  returning * into u;
  return jsonb_build_object('id', u.osu_id, 'username', u.username, 'status', u.status, 'status_reason', u.status_reason);
end $$;

-- called on API use by an existing session (keeps the name/avatar fresh, creates the row for sessions from before)
create or replace function public.obv_user_touch(p_id bigint, p_username text, p_avatar text, p_country text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users;
begin
  if p_id is null or p_id <= 0 then perform obv.err('bad_user'); end if;
  insert into obv.users (osu_id, username, avatar_url, country, last_seen_at)
  values (p_id, left(p_username, 64), left(p_avatar, 300), left(p_country, 4), now())
  on conflict (osu_id) do update set last_seen_at = now(),
    username = coalesce(excluded.username, obv.users.username), avatar_url = coalesce(excluded.avatar_url, obv.users.avatar_url)
  returning * into u;
  return jsonb_build_object('id', u.osu_id, 'username', u.username, 'status', u.status, 'status_reason', u.status_reason);
end $$;

-- a collaborator added by id/name (looked up on osu! by the server) gets a row before their first login
create or replace function obv.ensure_user(p_id bigint, p_username text, p_avatar text) returns void language sql set search_path = obv, pg_temp as $$
  insert into obv.users (osu_id, username, avatar_url) values (p_id, left(p_username, 64), left(p_avatar, 300))
  on conflict (osu_id) do nothing
$$;

-- ---------- projects ----------
create or replace function public.obv_project_create(p_actor bigint, p_client_key text, p_title text, p_artist text, p_creator text, p_set_id bigint)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare p obv.projects; n int;
begin
  perform obv.active_user(p_actor);
  if p_client_key is null or p_client_key !~ '^[A-Za-z0-9_-]{8,64}$' then perform obv.err('bad_request', '{"field":"client_key"}'); end if;
  -- the same browser retrying (double click, lost response) gets the same project back
  select * into p from obv.projects where owner_id = p_actor and client_key = p_client_key;
  if found then
    if p.status <> 'active' or p.expires_at <= now() then perform obv.err('expired', jsonb_build_object('expires_at', p.expires_at)); end if;
    return obv.project_json(p, 'owner') || jsonb_build_object('existing', true);
  end if;
  select count(*) into n from obv.projects where owner_id = p_actor and status = 'active' and expires_at > now();
  if n >= (obv.setting('max_projects_per_user'))::int then
    perform obv.err('too_many_projects', jsonb_build_object('limit', obv.setting('max_projects_per_user')));
  end if;
  insert into obv.projects (owner_id, client_key, title, artist, creator, source_set_id, expires_at)
  values (p_actor, p_client_key, left(coalesce(p_title, ''), 300), left(coalesce(p_artist, ''), 300), left(coalesce(p_creator, ''), 64),
          case when p_set_id > 0 then p_set_id end, now())  -- expires_at is overwritten by the trigger
  on conflict (owner_id, client_key) do nothing
  returning * into p;
  if not found then select * into p from obv.projects where owner_id = p_actor and client_key = p_client_key; end if;
  return obv.project_json(p, 'owner') || jsonb_build_object('existing', false);
end $$;

create or replace function public.obv_project_get(p_actor bigint, p_project uuid)
returns jsonb language plpgsql stable set search_path = obv, pg_temp as $$
declare r text; p obv.projects;
begin
  perform obv.active_user(p_actor);
  r := obv.access(p_actor, p_project);
  select * into p from obv.projects where id = p_project;
  return obv.project_json(p, r) || jsonb_build_object(
    'manifest', p.manifest,
    'members', case when r = 'owner' then coalesce((select jsonb_agg(jsonb_build_object('id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url, 'role', m.role) order by m.added_at)
                  from obv.members m join obv.users u on u.osu_id = m.user_id where m.project_id = p.id), '[]'::jsonb) else '[]'::jsonb end,
    'annotations', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'author', jsonb_build_object('id', u.osu_id, 'username', u.username),
                  'diff', a.diff, 'kind', a.kind, 'object_id', a.object_id, 'time_ms', a.time_ms, 'body', a.body, 'data', a.data,
                  'object_missing', a.object_missing, 'version', a.version, 'created_at', a.created_at, 'updated_at', a.updated_at) order by a.time_ms)
                  from obv.annotations a join obv.users u on u.osu_id = a.author_id where a.project_id = p.id), '[]'::jsonb));
end $$;

-- the caller's role without the rest (collab tickets)
create or replace function public.obv_project_role(p_actor bigint, p_project uuid)
returns jsonb language plpgsql stable set search_path = obv, pg_temp as $$
declare r text; p obv.projects;
begin
  perform obv.active_user(p_actor);
  r := obv.access(p_actor, p_project);
  select * into p from obv.projects where id = p_project;
  return jsonb_build_object('role', r, 'expires_at', p.expires_at, 'revision', p.revision);
end $$;

create or replace function public.obv_projects_list(p_actor bigint)
returns jsonb language plpgsql stable set search_path = obv, pg_temp as $$
begin
  perform obv.active_user(p_actor);
  return coalesce((
    select jsonb_agg(x.j order by x.updated_at desc) from (
      select obv.project_json(p, case when p.owner_id = p_actor then 'owner' else m.role end)
               || jsonb_build_object('members', (select count(*) from obv.members mm where mm.project_id = p.id)) as j, p.updated_at
      from obv.projects p left join obv.members m on m.project_id = p.id and m.user_id = p_actor
      where (p.owner_id = p_actor or m.user_id is not null) and p.status = 'active' and p.expires_at > now()
    ) x), '[]'::jsonb);
end $$;

-- owner deletes before expiry: access stops now; the server then deletes the files and calls obv_cleanup_finish
create or replace function public.obv_project_delete(p_actor bigint, p_project uuid)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare r text;
begin
  perform obv.active_user(p_actor);
  r := obv.access(p_actor, p_project);
  if r <> 'owner' then perform obv.err('forbidden'); end if;
  update obv.projects set status = 'deleting', delete_reason = 'owner', cleanup_at = now() where id = p_project;
  update obv.saves set state = 'expired' where project_id = p_project and state = 'open';
  return jsonb_build_object('id', p_project, 'status', 'deleting');
end $$;

-- share / change role / revoke (p_role = 'viewer' | 'editor' | 'none'); the server resolved p_user on osu!
create or replace function public.obv_member_set(p_actor bigint, p_project uuid, p_user bigint, p_username text, p_avatar text, p_role text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare r text; n int;
begin
  perform obv.active_user(p_actor);
  r := obv.access(p_actor, p_project);
  if r <> 'owner' then perform obv.err('forbidden'); end if;
  if p_user is null or p_user <= 0 or p_user = p_actor then perform obv.err('bad_request', '{"field":"user"}'); end if;
  if p_role = 'none' then
    delete from obv.members where project_id = p_project and user_id = p_user;
  elsif p_role in ('viewer', 'editor') then
    select count(*) into n from obv.members where project_id = p_project;
    if n >= 20 and not exists (select 1 from obv.members where project_id = p_project and user_id = p_user) then perform obv.err('too_many_members'); end if;
    perform obv.ensure_user(p_user, p_username, p_avatar);
    insert into obv.members (project_id, user_id, role, added_by) values (p_project, p_user, p_role, p_actor)
    on conflict (project_id, user_id) do update set role = excluded.role;
  else perform obv.err('bad_request', '{"field":"role"}');
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url, 'role', m.role) order by m.added_at)
          from obv.members m join obv.users u on u.osu_id = m.user_id where m.project_id = p_project), '[]'::jsonb);
end $$;

-- ---------- saving: begin (reserve keys) -> browser uploads to signed URLs -> commit (verify + switch revision) ----------
create or replace function public.obv_save_begin(p_actor bigint, p_project uuid, p_base_revision int, p_files jsonb)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare
  r text; p obv.projects; f jsonb; n int; total bigint := 0; new_bytes bigint := 0; pend bigint; used bigint;
  sid uuid := gen_random_uuid(); k text; sz bigint; sha text; mf jsonb := '[]'::jsonb; ups jsonb := '[]'::jsonb;
  plan jsonb := '[]'::jsonb; e jsonb;
begin
  perform obv.active_user(p_actor);
  r := obv.access(p_actor, p_project);
  if r not in ('owner', 'editor') then perform obv.err('forbidden'); end if;
  select * into p from obv.projects where id = p_project for update;
  if p.revision <> p_base_revision then
    perform obv.err('conflict', jsonb_build_object('revision', p.revision, 'updated_at', p.updated_at,
      'saved_by', (select username from obv.users where osu_id = p.saved_by)));
  end if;
  if jsonb_typeof(p_files) is distinct from 'array' then perform obv.err('bad_files'); end if;
  n := jsonb_array_length(p_files);
  if n < 1 or n > 500 then perform obv.err('bad_files', jsonb_build_object('count', n)); end if;
  for f in select value from jsonb_array_elements(p_files) loop
    if not obv.valid_path(f ->> 'path') then perform obv.err('bad_files', jsonb_build_object('path', left(f ->> 'path', 80))); end if;
    if jsonb_typeof(f -> 'size') is distinct from 'number' or (f ->> 'size') !~ '^\d{1,9}$' then perform obv.err('bad_files', jsonb_build_object('size', f -> 'size')); end if;
    if coalesce(f ->> 'sha256', '') !~ '^[0-9a-f]{64}$' then perform obv.err('bad_files', jsonb_build_object('sha256', left(f ->> 'sha256', 80))); end if;
    total := total + (f ->> 'size')::bigint;
  end loop;
  if (select count(distinct lower(value ->> 'path')) from jsonb_array_elements(p_files)) <> n then perform obv.err('bad_files', '{"reason":"duplicate path"}'); end if;
  if total > obv.max_project_bytes() then perform obv.err('too_large', jsonb_build_object('size', total, 'limit', obv.max_project_bytes())); end if;

  -- unchanged content (same sha256 + size already committed in this project) is reused, everything else gets a new key
  for f in select value from jsonb_array_elements(p_files) loop
    sz := (f ->> 'size')::bigint; sha := f ->> 'sha256';
    select b.key into k from obv.blobs b where b.project_id = p_project and b.state = 'committed' and b.sha256 = sha and b.size = sz limit 1;
    if k is null then
      select value ->> 'key' into k from jsonb_array_elements(plan) where value ->> 'sha256' = sha and (value ->> 'size')::bigint = sz and value ->> 'new' = 'true' limit 1;
      if k is null then
        k := 'p/' || p_project || '/' || gen_random_uuid();
        new_bytes := new_bytes + sz;
        plan := plan || jsonb_build_array(jsonb_build_object('path', f ->> 'path', 'key', k, 'size', sz, 'sha256', sha, 'new', true, 'upload', true));
      else
        plan := plan || jsonb_build_array(jsonb_build_object('path', f ->> 'path', 'key', k, 'size', sz, 'sha256', sha, 'new', false, 'upload', false));
      end if;
    else
      plan := plan || jsonb_build_array(jsonb_build_object('path', f ->> 'path', 'key', k, 'size', sz, 'sha256', sha, 'new', false, 'upload', false));
    end if;
  end loop;

  select coalesce(sum(size), 0) into pend from obv.blobs where project_id = p_project and state = 'pending';
  if pend + new_bytes > 2 * obv.max_project_bytes() then perform obv.err('too_many_pending'); end if;
  select coalesce(sum(size), 0) into used from obv.blobs;
  if used + new_bytes > (obv.setting('storage_budget_bytes'))::bigint then perform obv.err('storage_full'); end if;

  insert into obv.saves (id, project_id, user_id, base_revision, manifest)
  values (sid, p_project, p_actor, p_base_revision,
          (select jsonb_agg(jsonb_build_object('path', value ->> 'path', 'key', value ->> 'key', 'size', (value ->> 'size')::bigint, 'sha256', value ->> 'sha256')) from jsonb_array_elements(plan)));
  for e in select value from jsonb_array_elements(plan) where value ->> 'upload' = 'true' loop
    insert into obv.blobs (key, project_id, size, sha256, state, save_id) values (e ->> 'key', p_project, (e ->> 'size')::bigint, e ->> 'sha256', 'pending', sid);
    ups := ups || jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'key', e ->> 'key', 'size', (e ->> 'size')::bigint));
  end loop;
  return jsonb_build_object('save_id', sid, 'uploads', ups, 'reused', n - jsonb_array_length(ups), 'size', total, 'limit', obv.max_project_bytes());
end $$;

-- annotations sent with a save: {"upsert": [...], "delete": [{id, base_version}]}
create or replace function obv.apply_annotations(p_actor bigint, p_role text, p_project uuid, p_changes jsonb)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare a jsonb; cur obv.annotations; done int := 0; conflicts jsonb := '[]'::jsonb; denied jsonb := '[]'::jsonb; lim int; aid uuid;
begin
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then return jsonb_build_object('applied', 0, 'conflicts', conflicts, 'denied', denied); end if;
  lim := (obv.setting('max_annotations'))::int;
  for a in select value from jsonb_array_elements(coalesce(p_changes -> 'delete', '[]'::jsonb)) loop
    begin aid := (a ->> 'id')::uuid; exception when others then continue; end;
    select * into cur from obv.annotations where id = aid and project_id = p_project for update;
    if not found then continue; end if;
    if cur.author_id <> p_actor and p_role <> 'owner' then denied := denied || to_jsonb(aid); continue; end if;
    if a ? 'base_version' and obv.to_int(a ->> 'base_version') is distinct from cur.version then conflicts := conflicts || to_jsonb(aid); continue; end if;
    delete from obv.annotations where id = aid; done := done + 1;
  end loop;
  for a in select value from jsonb_array_elements(coalesce(p_changes -> 'upsert', '[]'::jsonb)) loop
    begin aid := (a ->> 'id')::uuid; exception when others then continue; end;
    if coalesce(a ->> 'kind', '') not in ('comment', 'arrow', 'highlight') or not obv.valid_path(coalesce(a ->> 'diff', ''))
       or (a ? 'data' and (jsonb_typeof(a -> 'data') <> 'object' or pg_column_size(a -> 'data') > 2048)) then denied := denied || to_jsonb(aid); continue; end if;
    select * into cur from obv.annotations where id = aid for update;
    if not found then
      if (select count(*) from obv.annotations where project_id = p_project) >= lim then conflicts := conflicts || to_jsonb(aid); continue; end if;
      insert into obv.annotations (id, project_id, author_id, diff, kind, object_id, time_ms, body, data, object_missing)
      values (aid, p_project, p_actor, a ->> 'diff', a ->> 'kind', left(a ->> 'object_id', 40), coalesce(obv.to_int(a ->> 'time_ms'), 0),
              left(coalesce(a ->> 'body', ''), 2000), coalesce(a -> 'data', '{}'::jsonb), coalesce(obv.to_bool(a ->> 'object_missing'), false));
      done := done + 1;
    elsif cur.project_id <> p_project then
      denied := denied || to_jsonb(aid);
    elsif cur.author_id = p_actor or p_role = 'owner' then
      if a ? 'base_version' and obv.to_int(a ->> 'base_version') is distinct from cur.version then conflicts := conflicts || to_jsonb(aid); continue; end if;
      update obv.annotations set kind = a ->> 'kind', object_id = left(a ->> 'object_id', 40), time_ms = coalesce(obv.to_int(a ->> 'time_ms'), 0),
        body = left(coalesce(a ->> 'body', ''), 2000), data = coalesce(a -> 'data', '{}'::jsonb), object_missing = coalesce(obv.to_bool(a ->> 'object_missing'), false),
        version = version + 1, updated_at = now()
      where id = aid;
      done := done + 1;
    else
      -- other editors may only keep the anchor current (the object moved in time / was deleted), not change the text
      update obv.annotations set time_ms = coalesce(obv.to_int(a ->> 'time_ms'), time_ms), object_missing = coalesce(obv.to_bool(a ->> 'object_missing'), object_missing)
      where id = aid and (time_ms is distinct from coalesce(obv.to_int(a ->> 'time_ms'), time_ms) or object_missing is distinct from coalesce(obv.to_bool(a ->> 'object_missing'), object_missing));
    end if;
  end loop;
  return jsonb_build_object('applied', done, 'conflicts', conflicts, 'denied', denied);
end $$;

-- verify every upload against Storage's own record (storage.objects), then switch the project to the new revision in one
-- transaction. On any error nothing changes: the previous revision stays complete and usable.
create or replace function public.obv_save_commit(p_actor bigint, p_save uuid, p_annotations jsonb)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare sv obv.saves; r text; p obv.projects; bl obv.blobs; act bigint; total bigint; missing int; ann jsonb;
begin
  select * into sv from obv.saves where id = p_save for update;
  if not found or sv.user_id <> p_actor then perform obv.err('not_found'); end if;
  if sv.state = 'committed' then  -- a retry after a lost response
    select * into p from obv.projects where id = sv.project_id;
    return jsonb_build_object('revision', sv.revision, 'already', true, 'size_bytes', p.size_bytes, 'expires_at', p.expires_at, 'updated_at', p.updated_at);
  end if;
  if sv.state <> 'open' or sv.created_at < now() - interval '3 hours' then perform obv.err('save_expired'); end if;
  perform obv.active_user(p_actor);
  r := obv.access(p_actor, sv.project_id);
  if r not in ('owner', 'editor') then perform obv.err('forbidden'); end if;
  select * into p from obv.projects where id = sv.project_id for update;
  if p.revision <> sv.base_revision then
    perform obv.err('conflict', jsonb_build_object('revision', p.revision, 'updated_at', p.updated_at,
      'saved_by', (select username from obv.users where osu_id = p.saved_by)));
  end if;
  for bl in select * from obv.blobs where save_id = p_save and state = 'pending' loop
    select (o.metadata ->> 'size')::bigint into act from storage.objects o where o.bucket_id = obv.bucket() and o.name = bl.key;
    if act is null then perform obv.err('missing_upload', jsonb_build_object('key', bl.key)); end if;
    if act <> bl.size then perform obv.err('size_mismatch', jsonb_build_object('key', bl.key, 'declared', bl.size, 'stored', act)); end if;
  end loop;
  -- every file of the new revision must be a verified upload of this save or already committed in this project
  select count(*) into missing from jsonb_array_elements(sv.manifest) m
  where not exists (select 1 from obv.blobs b where b.key = m.value ->> 'key' and b.project_id = p.id
                    and (b.state = 'committed' or (b.state = 'pending' and b.save_id = p_save)));
  if missing > 0 then perform obv.err('bad_manifest'); end if;
  select coalesce(sum(b.size), 0) into total from jsonb_array_elements(sv.manifest) m join obv.blobs b on b.key = m.value ->> 'key';
  if total > obv.max_project_bytes() then perform obv.err('too_large', jsonb_build_object('size', total, 'limit', obv.max_project_bytes())); end if;

  update obv.blobs set state = 'committed' where save_id = p_save and state = 'pending';
  update obv.blobs set state = 'orphaned', orphaned_at = now()
  where project_id = p.id and state = 'committed' and key not in (select m.value ->> 'key' from jsonb_array_elements(sv.manifest) m);
  update obv.projects set revision = revision + 1, manifest = sv.manifest, size_bytes = total, updated_at = now(), saved_by = p_actor
  where id = p.id returning * into p;
  ann := obv.apply_annotations(p_actor, r, p.id, p_annotations);
  update obv.saves set state = 'committed', committed_at = now(), revision = p.revision where id = p_save;
  return jsonb_build_object('revision', p.revision, 'size_bytes', p.size_bytes, 'expires_at', p.expires_at, 'updated_at', p.updated_at,
    'annotations', ann, 'manifest', p.manifest);
end $$;

-- ---------- cleanup (cron, owner/admin deletes) ----------
-- expired projects stop being accessible at expires_at (obv.access); this marks them for deletion and returns the
-- projects whose files still have to be removed (including earlier failed attempts, oldest first)
create or replace function public.obv_cleanup_due(p_limit int)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
begin
  update obv.projects set status = 'deleting', delete_reason = 'expired', cleanup_at = now()
  where status = 'active' and expires_at <= now();
  update obv.saves set state = 'expired' where state = 'open' and (created_at < now() - interval '3 hours'
    or project_id in (select id from obv.projects where status = 'deleting'));
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'attempts', p.cleanup_attempts,
            'keys', coalesce((select jsonb_agg(b.key) from obv.blobs b where b.project_id = p.id), '[]'::jsonb)) order by p.cleanup_attempts, p.cleanup_at)
          from (select * from obv.projects where status = 'deleting' order by cleanup_attempts, cleanup_at limit greatest(1, least(p_limit, 200))) p), '[]'::jsonb);
end $$;

create or replace function public.obv_cleanup_keys(p_project uuid)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object('id', p.id, 'status', p.status,
    'keys', coalesce((select jsonb_agg(b.key) from obv.blobs b where b.project_id = p.id), '[]'::jsonb))
  from obv.projects p where p.id = p_project and p.status = 'deleting'
$$;

-- after the server deleted the files: drop the rows of objects that are really gone; delete the project (and with it
-- members, saves and annotations) only when nothing of it is left in storage. Otherwise count the attempt and retry later.
create or replace function public.obv_cleanup_finish(p_project uuid, p_error text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare p obv.projects; left_rows int; left_objs int;
begin
  select * into p from obv.projects where id = p_project for update;
  if not found then return jsonb_build_object('done', true, 'gone', true); end if;
  if p.status <> 'deleting' then perform obv.err('not_deleting'); end if;
  delete from obv.blobs b where b.project_id = p.id
    and not exists (select 1 from storage.objects o where o.bucket_id = obv.bucket() and o.name = b.key);
  select count(*) into left_rows from obv.blobs where project_id = p.id;
  select count(*) into left_objs from storage.objects o where o.bucket_id = obv.bucket() and o.name like 'p/' || p.id || '/%';
  if left_rows > 0 or left_objs > 0 then
    update obv.projects set cleanup_attempts = cleanup_attempts + 1, cleanup_at = now(),
      cleanup_error = left(coalesce(p_error, format('%s file(s) still in storage', greatest(left_rows, left_objs))), 500)
    where id = p.id;
    return jsonb_build_object('done', false, 'remaining', greatest(left_rows, left_objs));
  end if;
  delete from obv.projects where id = p.id;
  perform obv.audit(null, 'project.purged', 'project', p.id::text, jsonb_build_object('reason', p.delete_reason, 'title', p.title, 'owner', p.owner_id, 'size', p.size_bytes));
  return jsonb_build_object('done', true);
end $$;

-- replaced / abandoned uploads: orphaned > 30 min (readers get 10-minute download links), pending > 3 h (upload links last 2 h)
create or replace function public.obv_gc_list(p_limit int)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select coalesce(jsonb_agg(b.key), '[]'::jsonb) from (
    select key from obv.blobs
    where (state = 'orphaned' and orphaned_at < now() - interval '30 minutes')
       or (state = 'pending' and created_at < now() - interval '3 hours')
    order by created_at limit greatest(1, least(p_limit, 1000))) b
$$;

create or replace function public.obv_gc_finish(p_keys text[])
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare n int;
begin
  delete from obv.blobs b where b.key = any (p_keys) and b.state in ('orphaned', 'pending')
    and (b.state = 'orphaned' or b.created_at < now() - interval '3 hours')
    and not exists (select 1 from storage.objects o where o.bucket_id = obv.bucket() and o.name = b.key);
  get diagnostics n = row_count;
  return jsonb_build_object('deleted', n);
end $$;

create or replace function public.obv_job_log(p_job text, p_ok boolean, p_detail jsonb)
returns void language sql set search_path = obv, pg_temp as $$
  insert into obv.job_runs (job, finished_at, ok, detail) values (p_job, now(), p_ok, coalesce(p_detail, '{}'::jsonb));
  delete from obv.job_runs where id in (select id from obv.job_runs order by id desc offset 200);
$$;

-- ---------- admin (the server only calls these after checking the verified osu! id of the site owner) ----------
create or replace function public.obv_audit_add(p_actor bigint, p_action text, p_type text, p_id text, p_detail jsonb)
returns void language sql set search_path = obv, pg_temp as $$
  select obv.audit(p_actor, left(p_action, 80), left(p_type, 40), left(p_id, 120), p_detail)
$$;

create or replace function public.obv_admin_overview()
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object(
    'users', (select count(*) from obv.users),
    'suspended', (select count(*) from obv.users where status = 'suspended'),
    'projects', (select count(*) from obv.projects where status = 'active' and expires_at > now()),
    'expired_waiting', (select count(*) from obv.projects where status = 'active' and expires_at <= now()),
    'deleting', (select count(*) from obv.projects where status = 'deleting'),
    'expiring_24h', (select count(*) from obv.projects where status = 'active' and expires_at > now() and expires_at <= now() + interval '24 hours'),
    'tracked_bytes', jsonb_build_object(
      'committed', (select coalesce(sum(size), 0) from obv.blobs where state = 'committed'),
      'pending', (select coalesce(sum(size), 0) from obv.blobs where state = 'pending'),
      'orphaned', (select coalesce(sum(size), 0) from obv.blobs where state = 'orphaned')),
    'storage', (select jsonb_build_object('objects', count(*), 'bytes', coalesce(sum((metadata ->> 'size')::bigint), 0))
                from storage.objects where bucket_id = obv.bucket()),
    'untracked', (select jsonb_build_object('objects', count(*), 'bytes', coalesce(sum((o.metadata ->> 'size')::bigint), 0))
                from storage.objects o where o.bucket_id = obv.bucket() and not exists (select 1 from obv.blobs b where b.key = o.name)),
    'budget_bytes', (obv.setting('storage_budget_bytes'))::bigint,
    'limit_bytes', obv.max_project_bytes(),
    'last_cleanup', (select jsonb_build_object('at', finished_at, 'ok', ok, 'detail', detail) from obv.job_runs where job = 'cleanup' order by id desc limit 1))
$$;

create or replace function public.obv_admin_users(p_q text, p_limit int, p_offset int)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object('total', (select count(*) from obv.users u where p_q is null or p_q = '' or u.username ilike '%' || p_q || '%' or u.osu_id::text = p_q),
    'rows', coalesce(jsonb_agg(x.j order by x.last_seen_at desc nulls last), '[]'::jsonb))
  from (
    select jsonb_build_object('id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url, 'country', u.country, 'status', u.status,
             'status_reason', u.status_reason, 'created_at', u.created_at, 'last_login_at', u.last_login_at, 'last_seen_at', u.last_seen_at,
             'projects', (select count(*) from obv.projects p where p.owner_id = u.osu_id and p.status = 'active' and p.expires_at > now()),
             'bytes', (select coalesce(sum(p.size_bytes), 0) from obv.projects p where p.owner_id = u.osu_id and p.status = 'active')) as j,
           u.last_seen_at
    from obv.users u
    where p_q is null or p_q = '' or u.username ilike '%' || p_q || '%' or u.osu_id::text = p_q
    order by u.last_seen_at desc nulls last
    limit greatest(1, least(p_limit, 100)) offset greatest(0, p_offset)) x
$$;

create or replace function public.obv_admin_user_status(p_actor bigint, p_user bigint, p_status text, p_reason text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users;
begin
  if p_status not in ('active', 'suspended') then perform obv.err('bad_request', '{"field":"status"}'); end if;
  if p_user = p_actor then perform obv.err('bad_request', '{"reason":"cannot change your own account"}'); end if;
  update obv.users set status = p_status, status_reason = case when p_status = 'suspended' then left(p_reason, 300) end
  where osu_id = p_user returning * into u;
  if not found then perform obv.err('not_found'); end if;
  perform obv.audit(p_actor, 'user.' || p_status, 'user', p_user::text, jsonb_build_object('username', u.username, 'reason', left(p_reason, 300)));
  return jsonb_build_object('id', u.osu_id, 'status', u.status);
end $$;

create or replace function public.obv_admin_projects(p_q text, p_status text, p_limit int, p_offset int)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  with f as (
    select p.*, u.username from obv.projects p join obv.users u on u.osu_id = p.owner_id
    where (p_q is null or p_q = '' or p.title ilike '%' || p_q || '%' or u.username ilike '%' || p_q || '%' or p.id::text = p_q)
      and (p_status is null or p_status = '' or (p_status = 'active' and p.status = 'active' and p.expires_at > now())
           or (p_status = 'expired' and p.status = 'active' and p.expires_at <= now()) or (p_status = 'deleting' and p.status = 'deleting')))
  select jsonb_build_object('total', (select count(*) from f), 'rows', coalesce((
    select jsonb_agg(jsonb_build_object('id', f.id, 'title', f.title, 'artist', f.artist, 'owner', jsonb_build_object('id', f.owner_id, 'username', f.username),
      'size_bytes', f.size_bytes, 'revision', f.revision, 'created_at', f.created_at, 'updated_at', f.updated_at, 'expires_at', f.expires_at,
      'status', case when f.status = 'active' and f.expires_at <= now() then 'expired' else f.status end, 'delete_reason', f.delete_reason,
      'cleanup_attempts', f.cleanup_attempts, 'cleanup_error', f.cleanup_error, 'cleanup_at', f.cleanup_at,
      'members', (select count(*) from obv.members m where m.project_id = f.id),
      'files', (select count(*) from obv.blobs b where b.project_id = f.id),
      'stored_bytes', (select coalesce(sum(b.size), 0) from obv.blobs b where b.project_id = f.id)) order by f.created_at desc)
    from (select * from f order by created_at desc limit greatest(1, least(p_limit, 100)) offset greatest(0, p_offset)) f), '[]'::jsonb))
$$;

create or replace function public.obv_admin_project_delete(p_actor bigint, p_project uuid)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare p obv.projects;
begin
  update obv.projects set status = 'deleting', delete_reason = coalesce(case when status = 'deleting' then delete_reason end, 'admin'), cleanup_at = now()
  where id = p_project returning * into p;
  if not found then perform obv.err('not_found'); end if;
  update obv.saves set state = 'expired' where project_id = p_project and state = 'open';
  perform obv.audit(p_actor, 'project.delete', 'project', p.id::text, jsonb_build_object('title', p.title, 'owner', p.owner_id, 'size', p.size_bytes));
  return jsonb_build_object('id', p.id, 'status', p.status);
end $$;

create or replace function public.obv_admin_cleanup_status()
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object(
    'deleting', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'reason', p.delete_reason, 'attempts', p.cleanup_attempts,
                 'error', p.cleanup_error, 'at', p.cleanup_at, 'files', (select count(*) from obv.blobs b where b.project_id = p.id)) order by p.cleanup_at)
                 from obv.projects p where p.status = 'deleting'), '[]'::jsonb),
    'gc_waiting', (select jsonb_build_object('orphaned', count(*) filter (where state = 'orphaned'), 'pending_stale', count(*) filter (where state = 'pending' and created_at < now() - interval '3 hours'))
                   from obv.blobs),
    'runs', coalesce((select jsonb_agg(jsonb_build_object('job', j.job, 'at', j.finished_at, 'ok', j.ok, 'detail', j.detail) order by j.id desc)
             from (select * from obv.job_runs order by id desc limit 20) j), '[]'::jsonb))
$$;

create or replace function public.obv_admin_audit(p_limit int, p_offset int)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object('total', (select count(*) from obv.audit_log), 'rows', coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'at', a.at, 'actor', a.actor_id, 'actor_name', (select username from obv.users where osu_id = a.actor_id),
      'action', a.action, 'target_type', a.target_type, 'target_id', a.target_id, 'detail', a.detail) order by a.id desc)
    from (select * from obv.audit_log order by id desc limit greatest(1, least(p_limit, 200)) offset greatest(0, p_offset)) a), '[]'::jsonb))
$$;

-- ---------- changelog ----------
create or replace function obv.changelog_json(c obv.changelog) returns jsonb language sql stable as $$
  select jsonb_build_object('id', c.id, 'title', c.title, 'version_label', c.version_label, 'content_md', c.content_md, 'status', c.status,
    'published_at', c.published_at, 'sort_order', c.sort_order, 'created_at', c.created_at, 'updated_at', c.updated_at)
$$;

-- anyone: published entries only, administrator order first, then newest
create or replace function public.obv_changelog_public()
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'version_label', c.version_label, 'content_md', c.content_md,
    'published_at', c.published_at, 'updated_at', c.updated_at) order by c.sort_order desc, c.published_at desc nulls last, c.created_at desc), '[]'::jsonb)
  from obv.changelog c where c.status = 'published'
$$;

create or replace function public.obv_changelog_admin()
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select coalesce(jsonb_agg(obv.changelog_json(c) order by c.sort_order desc, c.published_at desc nulls last, c.created_at desc), '[]'::jsonb)
  from obv.changelog c
$$;

-- create (p_id null) or update; p_base_updated_at guards against overwriting a newer edit from another tab
create or replace function public.obv_changelog_save(p_actor bigint, p_id uuid, p_title text, p_version text, p_content text, p_status text,
  p_published_at timestamptz, p_base_updated_at timestamptz)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare c obv.changelog; was text;
begin
  if coalesce(btrim(p_title), '') = '' then perform obv.err('bad_request', '{"field":"title"}'); end if;
  if p_status not in ('draft', 'published') then perform obv.err('bad_request', '{"field":"status"}'); end if;
  if char_length(p_title) > 200 or char_length(coalesce(p_version, '')) > 40 or char_length(coalesce(p_content, '')) > 20000 then
    perform obv.err('bad_request', '{"reason":"too long"}');
  end if;
  if p_id is null then
    insert into obv.changelog (title, version_label, content_md, status, published_at, sort_order, created_by, updated_by)
    values (btrim(p_title), coalesce(btrim(p_version), ''), coalesce(p_content, ''), p_status,
            case when p_status = 'published' then coalesce(p_published_at, now()) else p_published_at end,
            coalesce((select max(sort_order) from obv.changelog), 0) + 1, p_actor, p_actor)
    returning * into c;
    perform obv.audit(p_actor, 'changelog.create', 'changelog', c.id::text, jsonb_build_object('title', c.title, 'status', c.status));
  else
    select * into c from obv.changelog where id = p_id for update;
    if not found then perform obv.err('not_found'); end if;
    if p_base_updated_at is not null and c.updated_at <> p_base_updated_at then
      perform obv.err('conflict', jsonb_build_object('updated_at', c.updated_at));
    end if;
    was := c.status;
    update obv.changelog set title = btrim(p_title), version_label = coalesce(btrim(p_version), ''), content_md = coalesce(p_content, ''), status = p_status,
      published_at = case when p_status = 'published' then coalesce(p_published_at, c.published_at, now()) else p_published_at end,
      updated_at = clock_timestamp(), updated_by = p_actor
    where id = p_id returning * into c;
    perform obv.audit(p_actor, case when was = 'draft' and p_status = 'published' then 'changelog.publish'
                                    when was = 'published' and p_status = 'draft' then 'changelog.unpublish' else 'changelog.edit' end,
      'changelog', c.id::text, jsonb_build_object('title', c.title, 'status', c.status));
  end if;
  return obv.changelog_json(c);
end $$;

create or replace function public.obv_changelog_delete(p_actor bigint, p_id uuid)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare c obv.changelog;
begin
  delete from obv.changelog where id = p_id returning * into c;
  if not found then perform obv.err('not_found'); end if;
  perform obv.audit(p_actor, 'changelog.delete', 'changelog', c.id::text, jsonb_build_object('title', c.title, 'status', c.status));
  return jsonb_build_object('deleted', c.id);
end $$;

-- move an entry one place up (toward the top of the page) or down: entries get unique ranks in display order, then the
-- entry swaps places with its neighbour
create or replace function public.obv_changelog_move(p_actor bigint, p_id uuid, p_dir int)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare c obv.changelog; o obv.changelog; tmp int;
begin
  perform 1 from obv.changelog for update;
  with ord as (select id, row_number() over (order by sort_order, published_at nulls first, created_at, id) as rn from obv.changelog)
  update obv.changelog cl set sort_order = ord.rn from ord where cl.id = ord.id and cl.sort_order <> ord.rn;
  select * into c from obv.changelog where id = p_id;
  if not found then perform obv.err('not_found'); end if;
  if p_dir > 0 then select * into o from obv.changelog where sort_order = c.sort_order + 1;
  else select * into o from obv.changelog where sort_order = c.sort_order - 1; end if;
  if found then
    tmp := c.sort_order;
    update obv.changelog set sort_order = o.sort_order where id = c.id;  -- order only: not a content edit (keeps open edit forms valid)
    update obv.changelog set sort_order = tmp where id = o.id;
    perform obv.audit(p_actor, 'changelog.reorder', 'changelog', c.id::text, jsonb_build_object('title', c.title, 'dir', sign(p_dir)));
  end if;
  select * into c from obv.changelog where id = p_id;
  return obv.changelog_json(c);
end $$;

-- ---------- only the server (service_role) may call any of this ----------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where (n.nspname = 'public' and p.proname like 'obv\_%') or n.nspname = 'obv' loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f.sig); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f.sig); end if;
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
