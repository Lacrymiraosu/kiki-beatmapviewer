-- Invites: everyone with access has a personal invite link. Opening it and logging in with osu! lets that person in at
-- once (no waiting for an admin), up to a number of people per link that the admins set (Settings → "Invites per
-- person", and per person in their panel). People who got in through an invite can't invite anyone themselves until an
-- admin turns it on for them. The owner and admins have no limit. Run once, after the access migration.

alter table obv.users add column if not exists invite_code text;
create unique index if not exists users_invite_code_idx on obv.users (invite_code) where invite_code is not null;
alter table obv.users drop constraint if exists users_invite_code_check;
alter table obv.users add constraint users_invite_code_check check (invite_code is null or invite_code ~ '^[A-Za-z0-9]{10}$');
alter table obv.users add column if not exists can_invite boolean not null default true;
alter table obv.users add column if not exists invite_limit int check (invite_limit is null or invite_limit between 0 and 1000);
alter table obv.users add column if not exists invited_by bigint references obv.users (osu_id) on delete set null;
alter table obv.users add column if not exists invited_at timestamptz;
create index if not exists users_invited_by_idx on obv.users (invited_by);

insert into obv.settings (key, value) values ('invites_per_user', '3') on conflict (key) do nothing;

create or replace function obv.setting_spec() returns table (key text, kind text, min_v numeric, max_v numeric, def jsonb)
language sql immutable as $$
  values ('max_project_bytes', 'int', 1000000, 2000000000, '30000000'::jsonb),
         ('storage_budget_bytes', 'int', 10000000, 1000000000000, '900000000'::jsonb),
         ('retention_days', 'int', 1, 365, '15'::jsonb),
         ('max_projects_per_user', 'int', 1, 1000, '10'::jsonb),
         ('max_members_per_project', 'int', 1, 100, '20'::jsonb),
         ('max_annotations', 'int', 10, 20000, '2000'::jsonb),
         ('saving_enabled', 'bool', null, null, 'true'::jsonb),
         ('access_required', 'bool', null, null, 'true'::jsonb),
         ('invites_per_user', 'int', 0, 1000, '3'::jsonb)
$$;

-- 10 letters/digits, easy to paste (no - or _)
create or replace function obv.new_invite_code() returns text language plpgsql volatile as $$
declare c text; ch text := 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; i int;
begin
  loop
    c := '';
    for i in 1..10 loop c := c || substr(ch, 1 + floor(random() * length(ch))::int, 1); end loop;
    exit when not exists (select 1 from obv.users where invite_code = c);
  end loop;
  return c;
end $$;

-- how many people this account may still let in (null = no limit: the owner and admins)
create or replace function obv.invite_state(u obv.users, p_owner_id bigint) returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object(
    'unlimited', u.osu_id = p_owner_id or u.role = 'admin',
    'limit', case when u.osu_id = p_owner_id or u.role = 'admin' then null
                  else coalesce(u.invite_limit, (obv.setting('invites_per_user') #>> '{}')::int, 3) end,
    'custom_limit', u.invite_limit,
    'used', (select count(*) from obv.users x where x.invited_by = u.osu_id),
    'can_invite', u.can_invite or u.osu_id = p_owner_id or u.role = 'admin')
$$;
create or replace function obv.invite_room(u obv.users, p_owner_id bigint) returns boolean language sql stable set search_path = obv, pg_temp as $$
  select (s ->> 'can_invite')::boolean and ((s ->> 'unlimited')::boolean or (s ->> 'used')::int < (s ->> 'limit')::int)
  from (select obv.invite_state(u, p_owner_id) s) x
$$;

-- the invite page of someone with access (the server checks their access first): their link (made the first time),
-- how many it may still let in, and who came in with it
create or replace function public.obv_invite_mine(p_actor bigint, p_owner_id bigint)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users;
begin
  select * into u from obv.users where osu_id = p_actor for update;
  if not found then perform obv.err('no_user'); end if;
  if u.invite_code is null then update obv.users set invite_code = obv.new_invite_code() where osu_id = p_actor returning * into u; end if;
  return jsonb_build_object('code', u.invite_code) || obv.invite_state(u, p_owner_id)
    || jsonb_build_object('invited', coalesce((select jsonb_agg(jsonb_build_object('id', x.osu_id, 'username', x.username, 'avatar', x.avatar_url, 'at', x.invited_at,
         'active', x.status = 'active' and x.access = 'approved') order by x.invited_at desc) from obv.users x where x.invited_by = p_actor), '[]'::jsonb));
end $$;

-- a new link: the old one stops working (people who already came in stay)
create or replace function public.obv_invite_reset(p_actor bigint, p_owner_id bigint)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
begin
  update obv.users set invite_code = obv.new_invite_code() where osu_id = p_actor;
  if not found then perform obv.err('no_user'); end if;
  perform obv.audit(p_actor, 'invite.reset', 'user', p_actor::text, '{}'::jsonb);
  return public.obv_invite_mine(p_actor, p_owner_id);
end $$;

-- what an invite link shows before logging in: whose it is and whether it can still let someone in
create or replace function public.obv_invite_info(p_code text, p_owner_id bigint)
returns jsonb language plpgsql stable set search_path = obv, pg_temp as $$
declare u obv.users;
begin
  if p_code is null or p_code !~ '^[A-Za-z0-9]{10}$' then perform obv.err('not_found'); end if;
  select * into u from obv.users where invite_code = p_code;
  if not found then perform obv.err('not_found'); end if;
  return jsonb_build_object('inviter', jsonb_build_object('id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url),
    'ok', u.status = 'active' and (u.access = 'approved' or u.role = 'admin' or u.osu_id = p_owner_id) and obv.invite_room(u, p_owner_id),
    'reason', case when u.status <> 'active' or not (u.access = 'approved' or u.role = 'admin' or u.osu_id = p_owner_id) then 'inactive'
                   when not (obv.invite_state(u, p_owner_id) ->> 'can_invite')::boolean then 'not_allowed'
                   when not obv.invite_room(u, p_owner_id) then 'full' end);
end $$;

-- accept an invite (logged in with osu!): access at once, counted on the inviter's link
create or replace function public.obv_invite_accept(p_id bigint, p_username text, p_avatar text, p_country text, p_code text, p_owner_id bigint)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare inv obv.users; me obv.users;
begin
  if p_code is null or p_code !~ '^[A-Za-z0-9]{10}$' then perform obv.err('not_found'); end if;
  perform public.obv_user_touch(p_id, p_username, p_avatar, p_country);
  select * into inv from obv.users where invite_code = p_code for update; -- one accept at a time per link (the limit holds)
  if not found then perform obv.err('not_found'); end if;
  select * into me from obv.users where osu_id = p_id for update;
  if me.access = 'approved' or me.role = 'admin' or p_id = p_owner_id then return jsonb_build_object('access', 'approved', 'already', true); end if;
  if me.status <> 'active' then perform obv.err('suspended'); end if;
  if me.access = 'denied' then perform obv.err('forbidden', '{"reason":"denied"}'); end if; -- an admin said no: an invite doesn't overrule that
  if inv.osu_id = p_id then perform obv.err('bad_request'); end if;
  if inv.status <> 'active' or not (inv.access = 'approved' or inv.role = 'admin' or inv.osu_id = p_owner_id) then perform obv.err('invite_inactive'); end if;
  if not (obv.invite_state(inv, p_owner_id) ->> 'can_invite')::boolean then perform obv.err('invite_inactive'); end if;
  if not obv.invite_room(inv, p_owner_id) then perform obv.err('invite_full'); end if;
  update obv.users set access = 'approved', access_decided_at = now(), access_decided_by = inv.osu_id,
    invited_by = inv.osu_id, invited_at = now(), can_invite = false where osu_id = p_id;
  perform obv.audit(p_id, 'access.invite', 'user', p_id::text, jsonb_build_object('username', me.username, 'inviter', inv.osu_id, 'inviter_name', inv.username));
  return jsonb_build_object('access', 'approved', 'inviter', jsonb_build_object('id', inv.osu_id, 'username', inv.username));
end $$;

-- admin: someone's invites (for their panel)
create or replace function public.obv_admin_user_invites(p_user bigint, p_owner_id bigint)
returns jsonb language plpgsql stable set search_path = obv, pg_temp as $$
declare u obv.users;
begin
  select * into u from obv.users where osu_id = p_user;
  if not found then perform obv.err('not_found'); end if;
  return obv.invite_state(u, p_owner_id) || jsonb_build_object('has_link', u.invite_code is not null,
    'invited_by', (select jsonb_build_object('id', x.osu_id, 'username', x.username) from obv.users x where x.osu_id = u.invited_by), 'invited_at', u.invited_at,
    'invited', coalesce((select jsonb_agg(jsonb_build_object('id', x.osu_id, 'username', x.username, 'at', x.invited_at, 'access', x.access) order by x.invited_at desc)
                         from obv.users x where x.invited_by = u.osu_id), '[]'::jsonb));
end $$;

-- admin: may this person invite, and how many (null = the site-wide number)
create or replace function public.obv_admin_invites_set(p_actor bigint, p_owner_id bigint, p_user bigint, p_patch jsonb)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users; lim int;
begin
  if jsonb_typeof(p_patch) is distinct from 'object' then perform obv.err('bad_request'); end if;
  select * into u from obv.users where osu_id = p_user for update;
  if not found then perform obv.err('not_found'); end if;
  if p_patch ? 'can_invite' then
    if jsonb_typeof(p_patch -> 'can_invite') <> 'boolean' then perform obv.err('bad_request', '{"field":"can_invite"}'); end if;
    if (p_patch ->> 'can_invite')::boolean is distinct from u.can_invite then
      update obv.users set can_invite = (p_patch ->> 'can_invite')::boolean where osu_id = p_user;
      perform obv.audit(p_actor, case when (p_patch ->> 'can_invite')::boolean then 'invite.allow' else 'invite.block' end, 'user', p_user::text, jsonb_build_object('username', u.username));
    end if;
  end if;
  if p_patch ? 'invite_limit' then
    if jsonb_typeof(p_patch -> 'invite_limit') = 'null' then lim := null;
    elsif jsonb_typeof(p_patch -> 'invite_limit') = 'number' and (p_patch ->> 'invite_limit')::numeric between 0 and 1000 and (p_patch ->> 'invite_limit')::numeric = trunc((p_patch ->> 'invite_limit')::numeric) then lim := (p_patch ->> 'invite_limit')::int;
    else perform obv.err('bad_request', '{"field":"invite_limit"}'); end if;
    if lim is distinct from u.invite_limit then
      update obv.users set invite_limit = lim where osu_id = p_user;
      perform obv.audit(p_actor, 'invite.limit', 'user', p_user::text, jsonb_build_object('username', u.username, 'from', u.invite_limit, 'to', lim));
    end if;
  end if;
  return public.obv_admin_user_invites(p_user, p_owner_id);
end $$;

-- the Access tab also shows who invited whom
create or replace function public.obv_admin_access(p_status text, p_q text, p_limit int, p_offset int)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  with f as (
    select u.* from obv.users u
    where (coalesce(p_status, '') = '' or u.access = p_status or (p_status = 'invited' and u.invited_by is not null))
      and (coalesce(p_q, '') = '' or u.username ilike '%' || p_q || '%' or u.osu_id::text = p_q)
  ), o as (
    select * from f order by
      case when access = 'pending' then access_requested_at end asc nulls last,
      coalesce(access_decided_at, access_requested_at, created_at) desc nulls last, osu_id
    limit greatest(1, least(p_limit, 100)) offset greatest(0, p_offset)
  )
  select jsonb_build_object('total', (select count(*) from f),
    'counts', (select jsonb_build_object('pending', count(*) filter (where access = 'pending'), 'approved', count(*) filter (where access = 'approved'),
                 'denied', count(*) filter (where access = 'denied'), 'none', count(*) filter (where access = 'none'),
                 'invited', count(*) filter (where invited_by is not null)) from obv.users),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
      'id', o.osu_id, 'username', o.username, 'avatar', o.avatar_url, 'country', o.country, 'status', o.status, 'role', o.role,
      'access', o.access, 'message', o.access_message, 'requested_at', o.access_requested_at, 'decided_at', o.access_decided_at,
      'decided_by', (select username from obv.users d where d.osu_id = o.access_decided_by),
      'invited_by', (select username from obv.users d where d.osu_id = o.invited_by), 'can_invite', o.can_invite,
      'created_at', o.created_at, 'last_seen_at', o.last_seen_at)) from o), '[]'::jsonb))
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
