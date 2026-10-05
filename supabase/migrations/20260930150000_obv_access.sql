-- Access: the site becomes invite-only. People log in with osu!, ask for access and wait (pending) until the owner or an
-- admin approves them. The owner and the admins always have access. A switch in Settings (access_required) turns it off.
-- Run once, after the earlier migrations. Until it has run, the server treats the site as open (as before).

alter table obv.users add column if not exists access text not null default 'none';
alter table obv.users drop constraint if exists users_access_check;
alter table obv.users add constraint users_access_check check (access in ('none', 'pending', 'approved', 'denied'));
alter table obv.users add column if not exists access_message text check (access_message is null or char_length(access_message) <= 300);
alter table obv.users add column if not exists access_requested_at timestamptz;
alter table obv.users add column if not exists access_decided_at timestamptz;
alter table obv.users add column if not exists access_decided_by bigint;
create index if not exists users_access_idx on obv.users (access, access_requested_at desc);

-- the first time only: the people who already work on the site keep it (admins, and everyone who owns or shares a
-- project); anyone else who only logged in once asks like everybody else
do $$
begin
  if not exists (select 1 from obv.settings where key = 'access_required') then
    update obv.users u set access = 'approved', access_decided_at = now()
      where u.access = 'none' and (u.role = 'admin'
        or exists (select 1 from obv.projects p where p.owner_id = u.osu_id)
        or exists (select 1 from obv.members m where m.user_id = u.osu_id));
    insert into obv.settings (key, value) values ('access_required', 'true');
  end if;
end $$;

-- the dashboard's settings list gets the switch
create or replace function obv.setting_spec() returns table (key text, kind text, min_v numeric, max_v numeric, def jsonb)
language sql immutable as $$
  values ('max_project_bytes', 'int', 1000000, 2000000000, '30000000'::jsonb),
         ('storage_budget_bytes', 'int', 10000000, 1000000000000, '900000000'::jsonb),
         ('retention_days', 'int', 1, 365, '15'::jsonb),
         ('max_projects_per_user', 'int', 1, 1000, '10'::jsonb),
         ('max_members_per_project', 'int', 1, 100, '20'::jsonb),
         ('max_annotations', 'int', 10, 20000, '2000'::jsonb),
         ('saving_enabled', 'bool', null, null, 'true'::jsonb),
         ('access_required', 'bool', null, null, 'true'::jsonb)
$$;

create or replace function public.obv_access_required()
returns boolean language sql stable set search_path = obv, pg_temp as $$
  select coalesce((obv.setting('access_required') #>> '{}')::boolean, true)
$$;

-- what the server checks on every gated request (cached for a minute per server instance)
create or replace function public.obv_access_of(p_id bigint)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select coalesce((select jsonb_build_object('access', access, 'role', role, 'status', status) from obv.users where osu_id = p_id),
                  jsonb_build_object('access', 'none', 'role', 'user', 'status', 'none'))
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
    'role', u.role, 'limits', obv.user_limits(u.osu_id),
    'access', u.access, 'access_requested_at', u.access_requested_at, 'access_decided_at', u.access_decided_at,
    'access_required', public.obv_access_required());
end $$;

-- a logged-in person asks for access (an optional short message for the admins). Asking again while pending only
-- updates the message; after a "no" they can ask again a day later.
create or replace function public.obv_access_request(p_id bigint, p_username text, p_avatar text, p_country text, p_message text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users; msg text := nullif(left(btrim(coalesce(p_message, '')), 300), '');
begin
  perform public.obv_user_touch(p_id, p_username, p_avatar, p_country);
  select * into u from obv.users where osu_id = p_id for update;
  if u.status <> 'active' then perform obv.err('suspended'); end if;
  if u.access = 'approved' then return jsonb_build_object('access', 'approved'); end if;
  if u.access = 'pending' then
    update obv.users set access_message = coalesce(msg, access_message) where osu_id = p_id;
    return jsonb_build_object('access', 'pending', 'access_requested_at', u.access_requested_at);
  end if;
  if u.access = 'denied' and u.access_decided_at > now() - interval '1 day' then
    perform obv.err('too_soon', jsonb_build_object('retry_at', u.access_decided_at + interval '1 day'));
  end if;
  update obv.users set access = 'pending', access_message = msg, access_requested_at = now() where osu_id = p_id;
  perform obv.audit(p_id, 'access.request', 'user', p_id::text, jsonb_build_object('username', u.username));
  return jsonb_build_object('access', 'pending', 'access_requested_at', now());
end $$;

-- admin: the requests (pending first, oldest first) or everyone with a given access state
create or replace function public.obv_admin_access(p_status text, p_q text, p_limit int, p_offset int)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  with f as (
    select u.* from obv.users u
    where (coalesce(p_status, '') = '' or u.access = p_status)
      and (coalesce(p_q, '') = '' or u.username ilike '%' || p_q || '%' or u.osu_id::text = p_q)
  ), o as (
    select * from f order by
      case when access = 'pending' then access_requested_at end asc nulls last,
      coalesce(access_decided_at, access_requested_at, created_at) desc nulls last, osu_id
    limit greatest(1, least(p_limit, 100)) offset greatest(0, p_offset)
  )
  select jsonb_build_object('total', (select count(*) from f),
    'counts', (select jsonb_build_object('pending', count(*) filter (where access = 'pending'), 'approved', count(*) filter (where access = 'approved'),
                 'denied', count(*) filter (where access = 'denied'), 'none', count(*) filter (where access = 'none')) from obv.users),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
      'id', o.osu_id, 'username', o.username, 'avatar', o.avatar_url, 'country', o.country, 'status', o.status, 'role', o.role,
      'access', o.access, 'message', o.access_message, 'requested_at', o.access_requested_at, 'decided_at', o.access_decided_at,
      'decided_by', (select username from obv.users d where d.osu_id = o.access_decided_by),
      'created_at', o.created_at, 'last_seen_at', o.last_seen_at)) from o), '[]'::jsonb))
$$;

-- admin: approve / deny / take back (none). The owner's access never changes.
create or replace function public.obv_admin_access_set(p_actor bigint, p_owner_id bigint, p_user bigint, p_access text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users;
begin
  if p_access not in ('approved', 'denied', 'none') then perform obv.err('bad_request', '{"field":"access"}'); end if;
  select * into u from obv.users where osu_id = p_user for update;
  if not found then perform obv.err('not_found'); end if;
  if p_user = p_owner_id or p_user = p_actor then perform obv.err('forbidden'); end if;
  if u.access is distinct from p_access then
    update obv.users set access = p_access, access_decided_at = now(), access_decided_by = p_actor where osu_id = p_user;
    perform obv.audit(p_actor, 'access.' || p_access, 'user', p_user::text, jsonb_build_object('username', u.username, 'from', u.access));
  end if;
  return jsonb_build_object('id', p_user, 'access', p_access);
end $$;

-- admin_user_get: include the access state (for the user panel)
create or replace function public.obv_admin_user_access(p_user bigint)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select coalesce((select jsonb_build_object('access', access, 'message', access_message, 'requested_at', access_requested_at,
    'decided_at', access_decided_at, 'decided_by', (select username from obv.users d where d.osu_id = u.access_decided_by))
    from obv.users u where osu_id = p_user), '{}'::jsonb)
$$;

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
