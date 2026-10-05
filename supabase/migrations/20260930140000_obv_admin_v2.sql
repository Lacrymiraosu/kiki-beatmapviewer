-- Admin dashboard v2: limits the admins can change without SQL (site-wide and per user), an admin changing one project's
-- expiry, a switch to pause online saving, and admin accounts (the site owner in OWNER_OSU_ID can add more).
-- Run once, after the earlier migrations. Safe for the site as it is deployed now: nothing it calls changes shape.

-- ---------- site-wide limits (read by every function below; edited from the dashboard) ----------
insert into obv.settings (key, value) values
  ('max_project_bytes', '30000000'),         -- all files of one project together
  ('retention_days', '15'),                  -- new projects are kept this long after their first online save
  ('max_members_per_project', '20'),         -- people one project can be shared with
  ('saving_enabled', 'true')                 -- false: nobody can create or save online projects (reading still works)
on conflict (key) do nothing;

-- what the dashboard may set, and the allowed range (a typo can't set 0 bytes or 10 years)
create or replace function obv.setting_spec() returns table (key text, kind text, min_v numeric, max_v numeric, def jsonb)
language sql immutable as $$
  values ('max_project_bytes', 'int', 1000000, 2000000000, '30000000'::jsonb),
         ('storage_budget_bytes', 'int', 10000000, 1000000000000, '900000000'::jsonb),
         ('retention_days', 'int', 1, 365, '15'::jsonb),
         ('max_projects_per_user', 'int', 1, 1000, '10'::jsonb),
         ('max_members_per_project', 'int', 1, 100, '20'::jsonb),
         ('max_annotations', 'int', 10, 20000, '2000'::jsonb),
         ('saving_enabled', 'bool', null, null, 'true'::jsonb)
$$;

-- the old constants now read the settings (same names, so every existing caller follows the settings)
create or replace function obv.max_project_bytes() returns bigint language sql stable set search_path = obv, pg_temp as $$
  select coalesce((select (value #>> '{}')::bigint from obv.settings where key = 'max_project_bytes'), 30000000)
$$;
create or replace function obv.retention() returns interval language sql stable set search_path = obv, pg_temp as $$
  select make_interval(days => coalesce((select (value #>> '{}')::int from obv.settings where key = 'retention_days'), 15))
$$;

-- sizes above the old fixed 30 MB are allowed now (the setting decides; 2 GB is the hard ceiling)
alter table obv.projects drop constraint if exists projects_size_bytes_check;
alter table obv.projects add constraint projects_size_bytes_check check (size_bytes between 0 and 2000000000);
alter table obv.blobs drop constraint if exists blobs_size_check;
alter table obv.blobs add constraint blobs_size_check check (size between 0 and 2000000000);

-- ---------- per-user overrides and admin accounts ----------
alter table obv.users add column if not exists role text not null default 'user';
alter table obv.users drop constraint if exists users_role_check;
alter table obv.users add constraint users_role_check check (role in ('user', 'admin'));
alter table obv.users add column if not exists max_projects int check (max_projects is null or max_projects between 0 and 1000);
alter table obv.users add column if not exists max_project_bytes bigint check (max_project_bytes is null or max_project_bytes between 1000000 and 2000000000);
alter table obv.users add column if not exists retention_days int check (retention_days is null or retention_days between 1 and 365);
alter table obv.users add column if not exists admin_note text check (admin_note is null or char_length(admin_note) <= 1000);

-- a user's effective limits: their override if set, else the site-wide setting
create or replace function obv.user_limits(p_user bigint) returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object(
    'max_project_bytes', coalesce(u.max_project_bytes, obv.max_project_bytes()),
    'retention_days', coalesce(u.retention_days, (obv.setting('retention_days') #>> '{}')::int, 15),
    'max_projects', coalesce(u.max_projects, (obv.setting('max_projects_per_user') #>> '{}')::int, 10),
    'saving_enabled', coalesce((obv.setting('saving_enabled') #>> '{}')::boolean, true),
    'custom', jsonb_build_object('max_project_bytes', u.max_project_bytes is not null, 'retention_days', u.retention_days is not null,
                                 'max_projects', u.max_projects is not null))
  from (select 1) one left join obv.users u on u.osu_id = p_user
$$;
create or replace function obv.limit_bytes(p_owner bigint) returns bigint language sql stable set search_path = obv, pg_temp as $$
  select coalesce((select max_project_bytes from obv.users where osu_id = p_owner), obv.max_project_bytes())
$$;
create or replace function obv.saving_on() returns boolean language sql stable set search_path = obv, pg_temp as $$
  select coalesce((obv.setting('saving_enabled') #>> '{}')::boolean, true)
$$;

-- expiry: fixed when the project is created (the owner's retention), then only an admin may move it
create or replace function obv.projects_fix_expiry() returns trigger language plpgsql set search_path = obv, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.expires_at := new.created_at + make_interval(days => (obv.user_limits(new.owner_id) ->> 'retention_days')::int);
  elsif new.created_at is distinct from old.created_at then
    perform obv.err('expiry_immutable');
  elsif new.expires_at is distinct from old.expires_at and coalesce(current_setting('obv.admin_expiry', true), '') <> 'on' then
    perform obv.err('expiry_immutable');
  end if;
  return new;
end $$;

-- the Storage bucket's per-file limit follows the biggest project limit in use (best effort: Supabase's own
-- project-wide upload limit still applies on top, and is set in the Supabase dashboard)
create or replace function obv.sync_bucket_limit() returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare want bigint := greatest(obv.max_project_bytes(), coalesce((select max(max_project_bytes) from obv.users), 0));
begin
  begin
    update storage.buckets set file_size_limit = want where id = obv.bucket();
    return jsonb_build_object('bucket_limit', want, 'synced', true);
  exception when others then
    return jsonb_build_object('bucket_limit', want, 'synced', false);
  end;
end $$;

-- ---------- functions that now use the owner's limits ----------
create or replace function obv.project_json(p obv.projects, p_role text) returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object(
    'id', p.id, 'title', p.title, 'artist', p.artist, 'creator', p.creator, 'source_set_id', p.source_set_id,
    'revision', p.revision, 'size_bytes', p.size_bytes, 'limit_bytes', obv.limit_bytes(p.owner_id),
    'created_at', p.created_at, 'updated_at', p.updated_at, 'expires_at', p.expires_at,
    'owner', (select jsonb_build_object('id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url) from obv.users u where u.osu_id = p.owner_id),
    'saved_by', (select jsonb_build_object('id', u.osu_id, 'username', u.username) from obv.users u where u.osu_id = p.saved_by),
    'role', p_role)
$$;

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
  return jsonb_build_object('id', u.osu_id, 'username', u.username, 'status', u.status, 'status_reason', u.status_reason,
    'role', u.role, 'limits', obv.user_limits(u.osu_id));
end $$;

create or replace function public.obv_project_create(p_actor bigint, p_client_key text, p_title text, p_artist text, p_creator text, p_set_id bigint)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare p obv.projects; n int; lim int;
begin
  perform obv.active_user(p_actor);
  if p_client_key is null or p_client_key !~ '^[A-Za-z0-9_-]{8,64}$' then perform obv.err('bad_request', '{"field":"client_key"}'); end if;
  select * into p from obv.projects where owner_id = p_actor and client_key = p_client_key;
  if found then
    if p.status <> 'active' or p.expires_at <= now() then perform obv.err('expired', jsonb_build_object('expires_at', p.expires_at)); end if;
    return obv.project_json(p, 'owner') || jsonb_build_object('existing', true);
  end if;
  if not obv.saving_on() then perform obv.err('saving_disabled'); end if;
  lim := (obv.user_limits(p_actor) ->> 'max_projects')::int;
  select count(*) into n from obv.projects where owner_id = p_actor and status = 'active' and expires_at > now();
  if n >= lim then perform obv.err('too_many_projects', jsonb_build_object('limit', lim)); end if;
  insert into obv.projects (owner_id, client_key, title, artist, creator, source_set_id, expires_at)
  values (p_actor, p_client_key, left(coalesce(p_title, ''), 300), left(coalesce(p_artist, ''), 300), left(coalesce(p_creator, ''), 64),
          case when p_set_id > 0 then p_set_id end, now())  -- expires_at is overwritten by the trigger
  on conflict (owner_id, client_key) do nothing
  returning * into p;
  if not found then select * into p from obv.projects where owner_id = p_actor and client_key = p_client_key; end if;
  return obv.project_json(p, 'owner') || jsonb_build_object('existing', false);
end $$;

create or replace function public.obv_member_set(p_actor bigint, p_project uuid, p_user bigint, p_username text, p_avatar text, p_role text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare r text; n int; lim int := coalesce((obv.setting('max_members_per_project') #>> '{}')::int, 20);
begin
  perform obv.active_user(p_actor);
  r := obv.access(p_actor, p_project);
  if r <> 'owner' then perform obv.err('forbidden'); end if;
  if p_user is null or p_user <= 0 or p_user = p_actor then perform obv.err('bad_request', '{"field":"user"}'); end if;
  if p_role = 'none' then
    delete from obv.members where project_id = p_project and user_id = p_user;
  elsif p_role in ('viewer', 'editor') then
    select count(*) into n from obv.members where project_id = p_project;
    if n >= lim and not exists (select 1 from obv.members where project_id = p_project and user_id = p_user) then
      perform obv.err('too_many_members', jsonb_build_object('limit', lim));
    end if;
    perform obv.ensure_user(p_user, p_username, p_avatar);
    insert into obv.members (project_id, user_id, role, added_by) values (p_project, p_user, p_role, p_actor)
    on conflict (project_id, user_id) do update set role = excluded.role;
  else perform obv.err('bad_request', '{"field":"role"}');
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url, 'role', m.role) order by m.added_at)
          from obv.members m join obv.users u on u.osu_id = m.user_id where m.project_id = p_project), '[]'::jsonb);
end $$;

create or replace function public.obv_save_begin(p_actor bigint, p_project uuid, p_base_revision int, p_files jsonb)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare
  r text; p obv.projects; f jsonb; n int; total bigint := 0; new_bytes bigint := 0; pend bigint; used bigint; lim bigint;
  sid uuid := gen_random_uuid(); k text; sz bigint; sha text; ups jsonb := '[]'::jsonb;
  plan jsonb := '[]'::jsonb; e jsonb;
begin
  perform obv.active_user(p_actor);
  r := obv.access(p_actor, p_project);
  if r not in ('owner', 'editor') then perform obv.err('forbidden'); end if;
  if not obv.saving_on() then perform obv.err('saving_disabled'); end if;
  select * into p from obv.projects where id = p_project for update;
  lim := obv.limit_bytes(p.owner_id);  -- the project owner's limit, whoever saves
  if p.revision <> p_base_revision then
    perform obv.err('conflict', jsonb_build_object('revision', p.revision, 'updated_at', p.updated_at,
      'saved_by', (select username from obv.users where osu_id = p.saved_by)));
  end if;
  if jsonb_typeof(p_files) is distinct from 'array' then perform obv.err('bad_files'); end if;
  n := jsonb_array_length(p_files);
  if n < 1 or n > 500 then perform obv.err('bad_files', jsonb_build_object('count', n)); end if;
  for f in select value from jsonb_array_elements(p_files) loop
    if not obv.valid_path(f ->> 'path') then perform obv.err('bad_files', jsonb_build_object('path', left(f ->> 'path', 80))); end if;
    if jsonb_typeof(f -> 'size') is distinct from 'number' or (f ->> 'size') !~ '^\d{1,10}$' then perform obv.err('bad_files', jsonb_build_object('size', f -> 'size')); end if;
    if coalesce(f ->> 'sha256', '') !~ '^[0-9a-f]{64}$' then perform obv.err('bad_files', jsonb_build_object('sha256', left(f ->> 'sha256', 80))); end if;
    total := total + (f ->> 'size')::bigint;
  end loop;
  if (select count(distinct lower(value ->> 'path')) from jsonb_array_elements(p_files)) <> n then perform obv.err('bad_files', '{"reason":"duplicate path"}'); end if;
  if total > lim then perform obv.err('too_large', jsonb_build_object('size', total, 'limit', lim)); end if;

  for f in select value from jsonb_array_elements(p_files) loop
    sz := (f ->> 'size')::bigint; sha := f ->> 'sha256'; k := null;
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
  if pend + new_bytes > 2 * lim then perform obv.err('too_many_pending'); end if;
  select coalesce(sum(size), 0) into used from obv.blobs;
  if used + new_bytes > (obv.setting('storage_budget_bytes') #>> '{}')::bigint then perform obv.err('storage_full'); end if;

  insert into obv.saves (id, project_id, user_id, base_revision, manifest)
  values (sid, p_project, p_actor, p_base_revision,
          (select jsonb_agg(jsonb_build_object('path', value ->> 'path', 'key', value ->> 'key', 'size', (value ->> 'size')::bigint, 'sha256', value ->> 'sha256')) from jsonb_array_elements(plan)));
  for e in select value from jsonb_array_elements(plan) where value ->> 'upload' = 'true' loop
    insert into obv.blobs (key, project_id, size, sha256, state, save_id) values (e ->> 'key', p_project, (e ->> 'size')::bigint, e ->> 'sha256', 'pending', sid);
    ups := ups || jsonb_build_array(jsonb_build_object('path', e ->> 'path', 'key', e ->> 'key', 'size', (e ->> 'size')::bigint));
  end loop;
  return jsonb_build_object('save_id', sid, 'uploads', ups, 'reused', n - jsonb_array_length(ups), 'size', total, 'limit', lim);
end $$;

create or replace function public.obv_save_commit(p_actor bigint, p_save uuid, p_annotations jsonb)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare sv obv.saves; r text; p obv.projects; bl obv.blobs; act bigint; total bigint; missing int; ann jsonb; lim bigint;
begin
  select * into sv from obv.saves where id = p_save for update;
  if not found or sv.user_id <> p_actor then perform obv.err('not_found'); end if;
  if sv.state = 'committed' then
    select * into p from obv.projects where id = sv.project_id;
    return jsonb_build_object('revision', sv.revision, 'already', true, 'size_bytes', p.size_bytes, 'expires_at', p.expires_at, 'updated_at', p.updated_at);
  end if;
  if sv.state <> 'open' or sv.created_at < now() - interval '3 hours' then perform obv.err('save_expired'); end if;
  perform obv.active_user(p_actor);
  r := obv.access(p_actor, sv.project_id);
  if r not in ('owner', 'editor') then perform obv.err('forbidden'); end if;
  select * into p from obv.projects where id = sv.project_id for update;
  lim := obv.limit_bytes(p.owner_id);
  if p.revision <> sv.base_revision then
    perform obv.err('conflict', jsonb_build_object('revision', p.revision, 'updated_at', p.updated_at,
      'saved_by', (select username from obv.users where osu_id = p.saved_by)));
  end if;
  for bl in select * from obv.blobs where save_id = p_save and state = 'pending' loop
    select (o.metadata ->> 'size')::bigint into act from storage.objects o where o.bucket_id = obv.bucket() and o.name = bl.key;
    if act is null then perform obv.err('missing_upload', jsonb_build_object('key', bl.key)); end if;
    if act <> bl.size then perform obv.err('size_mismatch', jsonb_build_object('key', bl.key, 'declared', bl.size, 'stored', act)); end if;
  end loop;
  select count(*) into missing from jsonb_array_elements(sv.manifest) m
  where not exists (select 1 from obv.blobs b where b.key = m.value ->> 'key' and b.project_id = p.id
                    and (b.state = 'committed' or (b.state = 'pending' and b.save_id = p_save)));
  if missing > 0 then perform obv.err('bad_manifest'); end if;
  select coalesce(sum(b.size), 0) into total from jsonb_array_elements(sv.manifest) m join obv.blobs b on b.key = m.value ->> 'key';
  if total > lim then perform obv.err('too_large', jsonb_build_object('size', total, 'limit', lim)); end if;

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

-- ---------- admin: who is one (the server adds the owner from OWNER_OSU_ID) ----------
create or replace function public.obv_admin_role(p_id bigint)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select coalesce((select jsonb_build_object('role', role, 'status', status) from obv.users where osu_id = p_id), jsonb_build_object('role', 'user', 'status', 'none'))
$$;

create or replace function public.obv_admin_admins(p_owner_id bigint)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url, 'status', u.status,
           'last_seen_at', u.last_seen_at, 'owner', u.osu_id = p_owner_id, 'role', case when u.osu_id = p_owner_id then 'owner' else u.role end)
         order by (u.osu_id = p_owner_id) desc, u.username), '[]'::jsonb)
  from obv.users u where u.role = 'admin' or u.osu_id = p_owner_id
$$;

-- an account looked up on osu! by name/id gets a row before its first login (to be made an admin)
create or replace function public.obv_admin_user_ensure(p_id bigint, p_username text, p_avatar text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
begin
  if p_id is null or p_id <= 0 then perform obv.err('bad_user'); end if;
  perform obv.ensure_user(p_id, coalesce(nullif(p_username, ''), p_id::text), p_avatar);
  return jsonb_build_object('id', p_id);
end $$;

-- ---------- admin: settings ----------
create or replace function public.obv_admin_settings()
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object(
    'settings', (select jsonb_agg(jsonb_build_object('key', s.key, 'kind', s.kind, 'min', s.min_v, 'max', s.max_v, 'default', s.def,
                   'value', coalesce((select value from obv.settings where key = s.key), s.def)) order by s.key) from obv.setting_spec() s),
    'bucket_limit', (select file_size_limit from storage.buckets where id = obv.bucket()),
    'overrides', (select jsonb_build_object('max_project_bytes', count(*) filter (where max_project_bytes is not null),
                   'retention_days', count(*) filter (where retention_days is not null), 'max_projects', count(*) filter (where max_projects is not null)) from obv.users))
$$;

create or replace function public.obv_admin_settings_set(p_actor bigint, p_values jsonb)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare s record; v jsonb; old jsonb; changed jsonb := '{}'::jsonb; num numeric;
begin
  if jsonb_typeof(p_values) is distinct from 'object' then perform obv.err('bad_request'); end if;
  if exists (select 1 from jsonb_object_keys(p_values) k where k not in (select key from obv.setting_spec())) then
    perform obv.err('bad_request', '{"reason":"unknown setting"}');
  end if;
  for s in select * from obv.setting_spec() where p_values ? key loop
    v := p_values -> s.key;
    if s.kind = 'bool' then
      if jsonb_typeof(v) <> 'boolean' then perform obv.err('bad_request', jsonb_build_object('field', s.key)); end if;
    else
      if jsonb_typeof(v) <> 'number' then perform obv.err('bad_request', jsonb_build_object('field', s.key)); end if;
      num := (v #>> '{}')::numeric;
      if num <> trunc(num) or num < s.min_v or num > s.max_v then
        perform obv.err('bad_request', jsonb_build_object('field', s.key, 'min', s.min_v, 'max', s.max_v));
      end if;
    end if;
    select value into old from obv.settings where key = s.key;
    if old is distinct from v then
      insert into obv.settings (key, value) values (s.key, v) on conflict (key) do update set value = excluded.value;
      changed := changed || jsonb_build_object(s.key, jsonb_build_object('from', old, 'to', v));
    end if;
  end loop;
  if changed <> '{}'::jsonb then perform obv.audit(p_actor, 'settings.change', 'settings', null, changed); end if;
  return public.obv_admin_settings() || jsonb_build_object('changed', changed, 'bucket', obv.sync_bucket_limit());
end $$;

-- ---------- admin: users ----------
drop function if exists public.obv_admin_users(text, int, int);
create or replace function public.obv_admin_users(p_q text, p_limit int, p_offset int, p_status text default '', p_role text default '', p_sort text default '')
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  with f as (
    select u.*,
      (select count(*) from obv.projects p where p.owner_id = u.osu_id and p.status = 'active' and p.expires_at > now()) as n_projects,
      (select coalesce(sum(p.size_bytes), 0) from obv.projects p where p.owner_id = u.osu_id and p.status = 'active') as n_bytes
    from obv.users u
    where (coalesce(p_q, '') = '' or u.username ilike '%' || p_q || '%' or u.osu_id::text = p_q)
      and (coalesce(p_status, '') = '' or u.status = p_status)
      and (coalesce(p_role, '') = '' or u.role = p_role
           or (p_role = 'custom' and (u.max_projects is not null or u.max_project_bytes is not null or u.retention_days is not null)))
  ), o as (
    select * from f order by
      case when p_sort = 'bytes' then n_bytes end desc nulls last,
      case when p_sort = 'projects' then n_projects end desc nulls last,
      case when p_sort = 'created' then created_at end desc nulls last,
      case when p_sort = 'name' then lower(username) end asc,
      last_seen_at desc nulls last, osu_id
    limit greatest(1, least(p_limit, 100)) offset greatest(0, p_offset)
  )
  select jsonb_build_object('total', (select count(*) from f), 'rows', coalesce((select jsonb_agg(jsonb_build_object(
      'id', o.osu_id, 'username', o.username, 'avatar', o.avatar_url, 'country', o.country, 'status', o.status, 'status_reason', o.status_reason,
      'role', o.role, 'created_at', o.created_at, 'last_login_at', o.last_login_at, 'last_seen_at', o.last_seen_at,
      'projects', o.n_projects, 'bytes', o.n_bytes, 'limits', obv.user_limits(o.osu_id))) from o), '[]'::jsonb))
$$;

create or replace function public.obv_admin_user_get(p_user bigint)
returns jsonb language plpgsql stable set search_path = obv, pg_temp as $$
declare u obv.users;
begin
  select * into u from obv.users where osu_id = p_user;
  if not found then perform obv.err('not_found'); end if;
  return jsonb_build_object(
    'id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url, 'country', u.country, 'status', u.status, 'status_reason', u.status_reason,
    'role', u.role, 'note', u.admin_note, 'created_at', u.created_at, 'last_login_at', u.last_login_at, 'last_seen_at', u.last_seen_at,
    'limits', obv.user_limits(u.osu_id),
    'overrides', jsonb_build_object('max_project_bytes', u.max_project_bytes, 'retention_days', u.retention_days, 'max_projects', u.max_projects),
    'bytes', (select coalesce(sum(size_bytes), 0) from obv.projects where owner_id = u.osu_id and status = 'active'),
    'projects', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'artist', p.artist, 'size_bytes', p.size_bytes,
                  'revision', p.revision, 'created_at', p.created_at, 'updated_at', p.updated_at, 'expires_at', p.expires_at,
                  'status', case when p.status = 'active' and p.expires_at <= now() then 'expired' else p.status end,
                  'members', (select count(*) from obv.members m where m.project_id = p.id)) order by p.updated_at desc)
                  from obv.projects p where p.owner_id = u.osu_id), '[]'::jsonb),
    'shared_with', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'role', m.role,
                  'owner', (select username from obv.users o where o.osu_id = p.owner_id)) order by p.updated_at desc)
                  from obv.members m join obv.projects p on p.id = m.project_id where m.user_id = u.osu_id and p.status = 'active'), '[]'::jsonb),
    'saves_30d', (select count(*) from obv.saves s where s.user_id = u.osu_id and s.state = 'committed' and s.committed_at > now() - interval '30 days'),
    'activity', coalesce((select jsonb_agg(jsonb_build_object('at', a.at, 'action', a.action, 'actor', a.actor_id,
                  'actor_name', (select username from obv.users x where x.osu_id = a.actor_id), 'target_type', a.target_type, 'target_id', a.target_id, 'detail', a.detail) order by a.id desc)
                  from (select * from obv.audit_log where (target_type = 'user' and target_id = u.osu_id::text) or actor_id = u.osu_id
                        or (detail ->> 'owner') = u.osu_id::text order by id desc limit 30) a), '[]'::jsonb));
end $$;

-- one call for everything an admin can change on an account. p_patch keys (all optional):
--   status ('active'|'suspended') + reason, role ('user'|'admin'), max_projects / max_project_bytes / retention_days
--   (a number, or null = back to the site-wide setting), note (text or null).
-- The server passes whether the caller is the site owner and the owner's id: only the owner changes roles or an
-- admin's status; nobody changes the owner's status or role, nor their own.
create or replace function public.obv_admin_user_update(p_actor bigint, p_actor_is_owner boolean, p_owner_id bigint, p_user bigint, p_patch jsonb)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users; changed jsonb := '{}'::jsonb; v jsonb; n numeric; k text; lo numeric; hi numeric;
begin
  if jsonb_typeof(p_patch) is distinct from 'object' then perform obv.err('bad_request'); end if;
  select * into u from obv.users where osu_id = p_user for update;
  if not found then perform obv.err('not_found'); end if;
  if p_patch ? 'status' or p_patch ? 'role' then
    if p_user = p_actor then perform obv.err('forbidden', '{"reason":"own account"}'); end if;
    if p_user = p_owner_id then perform obv.err('forbidden', '{"reason":"site owner"}'); end if;
  end if;
  if p_patch ? 'status' then
    if p_patch ->> 'status' not in ('active', 'suspended') then perform obv.err('bad_request', '{"field":"status"}'); end if;
    if u.role = 'admin' and not p_actor_is_owner then perform obv.err('forbidden', '{"reason":"admins are managed by the owner"}'); end if;
    if p_patch ->> 'status' is distinct from u.status then
      update obv.users set status = p_patch ->> 'status',
        status_reason = case when p_patch ->> 'status' = 'suspended' then left(p_patch ->> 'reason', 300) end where osu_id = p_user;
      perform obv.audit(p_actor, 'user.' || (p_patch ->> 'status'), 'user', p_user::text, jsonb_build_object('username', u.username, 'reason', left(p_patch ->> 'reason', 300)));
    end if;
  end if;
  if p_patch ? 'role' then
    if not p_actor_is_owner then perform obv.err('forbidden', '{"reason":"only the site owner manages admins"}'); end if;
    if p_patch ->> 'role' not in ('user', 'admin') then perform obv.err('bad_request', '{"field":"role"}'); end if;
    if p_patch ->> 'role' is distinct from u.role then
      update obv.users set role = p_patch ->> 'role' where osu_id = p_user;
      perform obv.audit(p_actor, case when p_patch ->> 'role' = 'admin' then 'admin.add' else 'admin.remove' end, 'user', p_user::text, jsonb_build_object('username', u.username));
    end if;
  end if;
  foreach k in array array['max_projects', 'max_project_bytes', 'retention_days'] loop
    if not p_patch ? k then continue; end if;
    v := p_patch -> k;
    lo := case k when 'max_projects' then 0 when 'max_project_bytes' then 1000000 else 1 end;
    hi := case k when 'max_projects' then 1000 when 'max_project_bytes' then 2000000000 else 365 end;
    if jsonb_typeof(v) = 'null' then n := null;
    elsif jsonb_typeof(v) = 'number' then
      n := (v #>> '{}')::numeric;
      if n <> trunc(n) or n < lo or n > hi then perform obv.err('bad_request', jsonb_build_object('field', k, 'min', lo, 'max', hi)); end if;
    else perform obv.err('bad_request', jsonb_build_object('field', k)); end if;
    execute format('update obv.users set %I = $1 where osu_id = $2', k) using n, p_user;
    changed := changed || jsonb_build_object(k, v);
  end loop;
  if p_patch ? 'note' then
    update obv.users set admin_note = nullif(left(btrim(coalesce(p_patch ->> 'note', '')), 1000), '') where osu_id = p_user;
    changed := changed || jsonb_build_object('note', true);
  end if;
  if changed - 'note' <> '{}'::jsonb then
    perform obv.audit(p_actor, 'user.limits', 'user', p_user::text, jsonb_build_object('username', u.username) || (changed - 'note'));
    perform obv.sync_bucket_limit();
  elsif changed ? 'note' then
    perform obv.audit(p_actor, 'user.note', 'user', p_user::text, jsonb_build_object('username', u.username));
  end if;
  return public.obv_admin_user_get(p_user);
end $$;

-- ---------- admin: projects ----------
drop function if exists public.obv_admin_projects(text, text, int, int);
create or replace function public.obv_admin_projects(p_q text, p_status text, p_limit int, p_offset int, p_sort text default '', p_owner bigint default null)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  with f as (
    select p.*, u.username from obv.projects p join obv.users u on u.osu_id = p.owner_id
    where (coalesce(p_q, '') = '' or p.title ilike '%' || p_q || '%' or p.artist ilike '%' || p_q || '%' or u.username ilike '%' || p_q || '%' or p.id::text = p_q)
      and (p_owner is null or p.owner_id = p_owner)
      and (coalesce(p_status, '') = '' or (p_status = 'active' and p.status = 'active' and p.expires_at > now())
           or (p_status = 'expiring' and p.status = 'active' and p.expires_at > now() and p.expires_at <= now() + interval '48 hours')
           or (p_status = 'expired' and p.status = 'active' and p.expires_at <= now()) or (p_status = 'deleting' and p.status = 'deleting'))
  ), o as (
    select * from f order by
      case when p_sort = 'size' then size_bytes end desc nulls last,
      case when p_sort = 'expires' then expires_at end asc nulls last,
      case when p_sort = 'updated' then updated_at end desc nulls last,
      created_at desc
    limit greatest(1, least(p_limit, 100)) offset greatest(0, p_offset)
  )
  select jsonb_build_object('total', (select count(*) from f), 'bytes', (select coalesce(sum(size_bytes), 0) from f), 'rows', coalesce((
    select jsonb_agg(jsonb_build_object('id', o.id, 'title', o.title, 'artist', o.artist, 'owner', jsonb_build_object('id', o.owner_id, 'username', o.username),
      'size_bytes', o.size_bytes, 'limit_bytes', obv.limit_bytes(o.owner_id), 'revision', o.revision, 'created_at', o.created_at, 'updated_at', o.updated_at, 'expires_at', o.expires_at,
      'status', case when o.status = 'active' and o.expires_at <= now() then 'expired' else o.status end, 'delete_reason', o.delete_reason,
      'cleanup_attempts', o.cleanup_attempts, 'cleanup_error', o.cleanup_error, 'cleanup_at', o.cleanup_at,
      'members', (select count(*) from obv.members m where m.project_id = o.id),
      'files', (select count(*) from obv.blobs b where b.project_id = o.id),
      'stored_bytes', (select coalesce(sum(b.size), 0) from obv.blobs b where b.project_id = o.id))) from o), '[]'::jsonb))
$$;

create or replace function public.obv_admin_project_get(p_project uuid)
returns jsonb language plpgsql stable set search_path = obv, pg_temp as $$
declare p obv.projects;
begin
  select * into p from obv.projects where id = p_project;
  if not found then perform obv.err('not_found'); end if;
  return obv.project_json(p, 'admin') || jsonb_build_object(
    'status', case when p.status = 'active' and p.expires_at <= now() then 'expired' else p.status end,
    'delete_reason', p.delete_reason, 'cleanup_attempts', p.cleanup_attempts, 'cleanup_error', p.cleanup_error,
    'files', coalesce((select jsonb_agg(jsonb_build_object('path', m.value ->> 'path', 'size', (m.value ->> 'size')::bigint) order by (m.value ->> 'size')::bigint desc)
               from jsonb_array_elements(p.manifest) m), '[]'::jsonb),
    'blobs', (select jsonb_build_object('committed', count(*) filter (where state = 'committed'), 'pending', count(*) filter (where state = 'pending'),
               'orphaned', count(*) filter (where state = 'orphaned'), 'bytes', coalesce(sum(size), 0)) from obv.blobs where project_id = p.id),
    'members', coalesce((select jsonb_agg(jsonb_build_object('id', u.osu_id, 'username', u.username, 'role', m.role, 'added_at', m.added_at) order by m.added_at)
               from obv.members m join obv.users u on u.osu_id = m.user_id where m.project_id = p.id), '[]'::jsonb),
    'annotations', (select count(*) from obv.annotations where project_id = p.id),
    'saves', coalesce((select jsonb_agg(jsonb_build_object('revision', s.revision, 'at', s.committed_at, 'user', (select username from obv.users x where x.osu_id = s.user_id)) order by s.committed_at desc)
               from (select * from obv.saves where project_id = p.id and state = 'committed' order by committed_at desc limit 15) s), '[]'::jsonb));
end $$;

-- move one project's expiry (extend or shorten); it must still be active, and the new date within a year
create or replace function public.obv_admin_project_expiry(p_actor bigint, p_project uuid, p_expires_at timestamptz)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare p obv.projects; was timestamptz;
begin
  select * into p from obv.projects where id = p_project for update;
  if not found then perform obv.err('not_found'); end if;
  if p.status <> 'active' then perform obv.err('bad_request', '{"reason":"being deleted"}'); end if;
  if p_expires_at is null or p_expires_at <= now() + interval '5 minutes' or p_expires_at > now() + interval '366 days' then
    perform obv.err('bad_request', '{"field":"expires_at"}');
  end if;
  was := p.expires_at;
  perform set_config('obv.admin_expiry', 'on', true);
  update obv.projects set expires_at = p_expires_at where id = p_project returning * into p;
  perform set_config('obv.admin_expiry', '', true);
  perform obv.audit(p_actor, 'project.expiry', 'project', p.id::text, jsonb_build_object('title', p.title, 'owner', p.owner_id, 'from', was, 'to', p.expires_at));
  return jsonb_build_object('id', p.id, 'expires_at', p.expires_at);
end $$;

-- ---------- admin: overview and audit ----------
create or replace function public.obv_admin_overview()
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object(
    'users', (select count(*) from obv.users),
    'suspended', (select count(*) from obv.users where status = 'suspended'),
    'admins', (select count(*) from obv.users where role = 'admin'),
    'new_users_7d', (select count(*) from obv.users where created_at > now() - interval '7 days'),
    'active_users_7d', (select count(*) from obv.users where last_seen_at > now() - interval '7 days'),
    'projects', (select count(*) from obv.projects where status = 'active' and expires_at > now()),
    'expired_waiting', (select count(*) from obv.projects where status = 'active' and expires_at <= now()),
    'deleting', (select count(*) from obv.projects where status = 'deleting'),
    'expiring_24h', (select count(*) from obv.projects where status = 'active' and expires_at > now() and expires_at <= now() + interval '24 hours'),
    'saves_7d', (select count(*) from obv.saves where state = 'committed' and committed_at > now() - interval '7 days'),
    'saves_by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'saves', d.n) order by d.day), '[]'::jsonb) from (
        select g.day::date as day, (select count(*) from obv.saves s where s.state = 'committed' and s.committed_at >= g.day and s.committed_at < g.day + interval '1 day') as n
        from generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') g(day)) d),
    'top_users', (select coalesce(jsonb_agg(x order by (x ->> 'bytes')::bigint desc), '[]'::jsonb) from (
        select jsonb_build_object('id', u.osu_id, 'username', u.username, 'bytes', sum(p.size_bytes), 'projects', count(*)) as x
        from obv.projects p join obv.users u on u.osu_id = p.owner_id where p.status = 'active'
        group by u.osu_id, u.username order by sum(p.size_bytes) desc limit 5) t),
    'largest', (select coalesce(jsonb_agg(x order by (x ->> 'size_bytes')::bigint desc), '[]'::jsonb) from (
        select jsonb_build_object('id', p.id, 'title', p.title, 'artist', p.artist, 'size_bytes', p.size_bytes, 'owner', u.username, 'expires_at', p.expires_at) as x
        from obv.projects p join obv.users u on u.osu_id = p.owner_id where p.status = 'active' and p.expires_at > now()
        order by p.size_bytes desc limit 5) t),
    'tracked_bytes', jsonb_build_object(
      'committed', (select coalesce(sum(size), 0) from obv.blobs where state = 'committed'),
      'pending', (select coalesce(sum(size), 0) from obv.blobs where state = 'pending'),
      'orphaned', (select coalesce(sum(size), 0) from obv.blobs where state = 'orphaned')),
    'storage', (select jsonb_build_object('objects', count(*), 'bytes', coalesce(sum((metadata ->> 'size')::bigint), 0))
                from storage.objects where bucket_id = obv.bucket()),
    'untracked', (select jsonb_build_object('objects', count(*), 'bytes', coalesce(sum((o.metadata ->> 'size')::bigint), 0))
                from storage.objects o where o.bucket_id = obv.bucket() and not exists (select 1 from obv.blobs b where b.key = o.name)),
    'budget_bytes', (obv.setting('storage_budget_bytes') #>> '{}')::bigint,
    'limit_bytes', obv.max_project_bytes(),
    'retention_days', (obv.setting('retention_days') #>> '{}')::int,
    'max_projects', (obv.setting('max_projects_per_user') #>> '{}')::int,
    'saving_enabled', obv.saving_on(),
    'last_cleanup', (select jsonb_build_object('at', finished_at, 'ok', ok, 'detail', detail) from obv.job_runs where job = 'cleanup' order by id desc limit 1))
$$;

drop function if exists public.obv_admin_audit(int, int);
create or replace function public.obv_admin_audit(p_limit int, p_offset int, p_action text default '', p_q text default '')
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  with f as (
    select a.* from obv.audit_log a
    where (coalesce(p_action, '') = '' or a.action like p_action || '%')
      and (coalesce(p_q, '') = '' or a.target_id = p_q or a.actor_id::text = p_q or a.detail::text ilike '%' || p_q || '%'
           or exists (select 1 from obv.users x where x.osu_id = a.actor_id and x.username ilike '%' || p_q || '%'))
  )
  select jsonb_build_object('total', (select count(*) from f), 'rows', coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'at', a.at, 'actor', a.actor_id, 'actor_name', (select username from obv.users where osu_id = a.actor_id),
      'action', a.action, 'target_type', a.target_type, 'target_id', a.target_id, 'detail', a.detail) order by a.id desc)
    from (select * from f order by id desc limit greatest(1, least(p_limit, 200)) offset greatest(0, p_offset)) a), '[]'::jsonb))
$$;

-- ---------- share links: "anyone with the link can view" ----------
-- For maps that aren't on osu! (made here or opened from a file) a link is the only way to pass them on. The owner turns
-- the link on; anyone with the project id + key can open the project read-only (no login), until the owner turns it off
-- or resets it, or the project expires. The key is 24 random bytes (base64url); the id alone never gives access.
alter table obv.projects add column if not exists link_key text check (link_key is null or link_key ~ '^[A-Za-z0-9_-]{32}$');

create or replace function obv.new_link_key() returns text language sql volatile as $$
  select translate(encode(decode(md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 'hex'), 'base64'), '+/=', '-_')
$$;

-- p_mode: 'on' (keep the current key or make one) | 'reset' (new key: old links stop working) | 'off'
create or replace function public.obv_project_link(p_actor bigint, p_project uuid, p_mode text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare r text; p obv.projects;
begin
  perform obv.active_user(p_actor);
  r := obv.access(p_actor, p_project);
  if r <> 'owner' then perform obv.err('forbidden'); end if;
  if p_mode not in ('on', 'reset', 'off') then perform obv.err('bad_request', '{"field":"mode"}'); end if;
  update obv.projects set link_key = case p_mode when 'off' then null when 'reset' then left(obv.new_link_key(), 32) else coalesce(link_key, left(obv.new_link_key(), 32)) end
  where id = p_project returning * into p;
  perform obv.audit(p_actor, 'project.link_' || p_mode, 'project', p.id::text, jsonb_build_object('title', p.title));
  return jsonb_build_object('id', p.id, 'link_key', p.link_key, 'expires_at', p.expires_at);
end $$;

-- anyone with the link: the project read-only (files + annotations; never the member list)
create or replace function public.obv_project_by_link(p_project uuid, p_key text)
returns jsonb language plpgsql stable set search_path = obv, pg_temp as $$
declare p obv.projects;
begin
  select * into p from obv.projects where id = p_project;
  if not found or p.link_key is null or p_key is null or p.link_key <> p_key or p.status <> 'active' then perform obv.err('not_found'); end if;
  if p.expires_at <= now() then perform obv.err('expired', jsonb_build_object('expires_at', p.expires_at)); end if;
  return obv.project_json(p, 'link') || jsonb_build_object('manifest', p.manifest, 'members', '[]'::jsonb,
    'annotations', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'author', jsonb_build_object('id', u.osu_id, 'username', u.username),
                  'diff', a.diff, 'kind', a.kind, 'object_id', a.object_id, 'time_ms', a.time_ms, 'body', a.body, 'data', a.data,
                  'object_missing', a.object_missing, 'version', a.version, 'created_at', a.created_at, 'updated_at', a.updated_at) order by a.time_ms)
                  from obv.annotations a join obv.users u on u.osu_id = a.author_id where a.project_id = p.id), '[]'::jsonb));
end $$;

-- the owner sees whether the link is on (members and editors don't get the key)
create or replace function public.obv_project_get(p_actor bigint, p_project uuid)
returns jsonb language plpgsql stable set search_path = obv, pg_temp as $$
declare r text; p obv.projects;
begin
  perform obv.active_user(p_actor);
  r := obv.access(p_actor, p_project);
  select * into p from obv.projects where id = p_project;
  return obv.project_json(p, r) || jsonb_build_object(
    'manifest', p.manifest,
    'link_key', case when r = 'owner' then p.link_key end,
    'members', case when r = 'owner' then coalesce((select jsonb_agg(jsonb_build_object('id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url, 'role', m.role) order by m.added_at)
                  from obv.members m join obv.users u on u.osu_id = m.user_id where m.project_id = p.id), '[]'::jsonb) else '[]'::jsonb end,
    'annotations', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'author', jsonb_build_object('id', u.osu_id, 'username', u.username),
                  'diff', a.diff, 'kind', a.kind, 'object_id', a.object_id, 'time_ms', a.time_ms, 'body', a.body, 'data', a.data,
                  'object_missing', a.object_missing, 'version', a.version, 'created_at', a.created_at, 'updated_at', a.updated_at) order by a.time_ms)
                  from obv.annotations a join obv.users u on u.osu_id = a.author_id where a.project_id = p.id), '[]'::jsonb));
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
