-- Invites, site-wide: one switch decides whether people who came in with an invite can invite others too
-- (Settings → "People who came in with an invite can invite"), instead of turning it on person by person.
-- A person's own choice in their panel still wins (allowed / not allowed / follow the site); "Use the site settings
-- for everyone" clears those choices and everyone's own invite numbers.
-- Also: admins can make extra invite links that each let in a set number of people (e.g. 10 for a Discord server),
-- see how many used each one and turn them off. Run once, after the invites migration.

-- can_invite: null = follow the rule (people approved directly: yes; people who came in with an invite: the switch),
-- true / false = an admin's choice for this person
alter table obv.users alter column can_invite drop not null;
alter table obv.users alter column can_invite set default null;
update obv.users u set can_invite = null
  where not exists (select 1 from obv.audit_log a where a.action in ('invite.allow', 'invite.block') and a.target_type = 'user' and a.target_id = u.osu_id::text);

insert into obv.settings (key, value) values ('invitees_can_invite', 'false') on conflict (key) do nothing;

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
         ('invites_per_user', 'int', 0, 1000, '3'::jsonb),
         ('invitees_can_invite', 'bool', null, null, 'false'::jsonb)
$$;

create or replace function obv.invite_state(u obv.users, p_owner_id bigint) returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object(
    'unlimited', u.osu_id = p_owner_id or u.role = 'admin',
    'limit', case when u.osu_id = p_owner_id or u.role = 'admin' then null
                  else coalesce(u.invite_limit, (obv.setting('invites_per_user') #>> '{}')::int, 3) end,
    'custom_limit', u.invite_limit,
    'used', (select count(*) from obv.users x where x.invited_by = u.osu_id),
    'can_invite', u.osu_id = p_owner_id or u.role = 'admin'
                  or coalesce(u.can_invite, u.invited_by is null or coalesce((obv.setting('invitees_can_invite') #>> '{}')::boolean, false)),
    'custom_can_invite', u.can_invite)
$$;


-- a person's own choice: can_invite true / false / null (= follow the site), invite_limit number / null (= the site's number)
create or replace function public.obv_admin_invites_set(p_actor bigint, p_owner_id bigint, p_user bigint, p_patch jsonb)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users; lim int; ci boolean;
begin
  if jsonb_typeof(p_patch) is distinct from 'object' then perform obv.err('bad_request'); end if;
  select * into u from obv.users where osu_id = p_user for update;
  if not found then perform obv.err('not_found'); end if;
  if p_patch ? 'can_invite' then
    if jsonb_typeof(p_patch -> 'can_invite') = 'null' then ci := null;
    elsif jsonb_typeof(p_patch -> 'can_invite') = 'boolean' then ci := (p_patch ->> 'can_invite')::boolean;
    else perform obv.err('bad_request', '{"field":"can_invite"}'); end if;
    if ci is distinct from u.can_invite then
      update obv.users set can_invite = ci where osu_id = p_user;
      perform obv.audit(p_actor, case when ci is null then 'invite.follow' when ci then 'invite.allow' else 'invite.block' end, 'user', p_user::text, jsonb_build_object('username', u.username));
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

-- everyone back to the site-wide invite settings (their own numbers and allowed / not allowed cleared)
create or replace function public.obv_admin_invites_reset_all(p_actor bigint)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare n_lim int; n_ci int;
begin
  select count(*) filter (where invite_limit is not null), count(*) filter (where can_invite is not null) into n_lim, n_ci from obv.users;
  update obv.users set invite_limit = null, can_invite = null where invite_limit is not null or can_invite is not null;
  perform obv.audit(p_actor, 'invite.reset_all', 'settings', null, jsonb_build_object('limits', n_lim, 'switches', n_ci));
  return jsonb_build_object('limits', n_lim, 'switches', n_ci);
end $$;

-- the settings page also counts people with their own invite choices
create or replace function public.obv_admin_settings()
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object(
    'settings', (select jsonb_agg(jsonb_build_object('key', s.key, 'kind', s.kind, 'min', s.min_v, 'max', s.max_v, 'default', s.def,
                   'value', coalesce((select value from obv.settings where key = s.key), s.def)) order by s.key) from obv.setting_spec() s),
    'bucket_limit', (select file_size_limit from storage.buckets where id = obv.bucket()),
    'overrides', (select jsonb_build_object('max_project_bytes', count(*) filter (where max_project_bytes is not null),
                   'retention_days', count(*) filter (where retention_days is not null), 'max_projects', count(*) filter (where max_projects is not null),
                   'invite_limit', count(*) filter (where invite_limit is not null), 'can_invite', count(*) filter (where can_invite is not null)) from obv.users))
$$;

-- the Access tab: whether each person can invite right now (after the switch and their own choice)
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
      'invited_by', (select username from obv.users d where d.osu_id = o.invited_by),
      'can_invite', coalesce(o.can_invite, o.invited_by is null or coalesce((obv.setting('invitees_can_invite') #>> '{}')::boolean, false)),
      'custom_can_invite', o.can_invite,
      'created_at', o.created_at, 'last_seen_at', o.last_seen_at)) from o), '[]'::jsonb))
$$;

-- ---------- admins' invite links with their own number of people ----------
create table if not exists obv.invite_links (
  code text primary key check (code ~ '^[A-Za-z0-9]{10}$'),
  created_by bigint not null references obv.users (osu_id),
  max_uses int not null check (max_uses between 1 and 1000),
  uses int not null default 0 check (uses >= 0),
  note text check (note is null or char_length(note) <= 80),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table obv.invite_links enable row level security; -- no policies: only the server reads it
grant all on obv.invite_links to service_role;
alter table obv.users add column if not exists invited_via text; -- the admin link someone came in with

create or replace function obv.new_invite_code() returns text language plpgsql volatile as $$
declare c text; ch text := 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; i int;
begin
  loop
    c := '';
    for i in 1..10 loop c := c || substr(ch, 1 + floor(random() * length(ch))::int, 1); end loop;
    exit when not exists (select 1 from obv.users where invite_code = c) and not exists (select 1 from obv.invite_links where code = c);
  end loop;
  return c;
end $$;

-- an admin link works while it isn't turned off, has room, and its maker is still an admin (or the owner)
create or replace function obv.link_ok(l obv.invite_links, p_owner_id bigint) returns text language sql stable set search_path = obv, pg_temp as $$
  select case when l.revoked_at is not null then 'inactive'
              when not exists (select 1 from obv.users u where u.osu_id = l.created_by and u.status = 'active' and (u.role = 'admin' or u.osu_id = p_owner_id)) then 'inactive'
              when l.uses >= l.max_uses then 'full' end
$$;
create or replace function obv.link_json(l obv.invite_links, p_owner_id bigint) returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object('code', l.code, 'max_uses', l.max_uses, 'uses', l.uses, 'note', l.note, 'created_at', l.created_at, 'revoked_at', l.revoked_at,
    'created_by', (select jsonb_build_object('id', u.osu_id, 'username', u.username) from obv.users u where u.osu_id = l.created_by),
    'state', coalesce(obv.link_ok(l, p_owner_id), 'ok'),
    'joined', coalesce((select jsonb_agg(jsonb_build_object('id', x.osu_id, 'username', x.username, 'at', x.invited_at) order by x.invited_at desc)
                        from obv.users x where x.invited_via = l.code), '[]'::jsonb))
$$;
create or replace function public.obv_admin_invite_links(p_owner_id bigint)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select coalesce(jsonb_agg(obv.link_json(l, p_owner_id) order by (l.revoked_at is null) desc, l.created_at desc), '[]'::jsonb) from obv.invite_links l
$$;
create or replace function public.obv_admin_invite_link_create(p_actor bigint, p_owner_id bigint, p_max int, p_note text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare l obv.invite_links; n text := nullif(left(btrim(coalesce(p_note, '')), 80), '');
begin
  if p_max is null or p_max < 1 or p_max > 1000 then perform obv.err('bad_request', '{"field":"max_uses"}'); end if;
  if (select count(*) from obv.invite_links where revoked_at is null) >= 200 then perform obv.err('too_many_pending'); end if;
  insert into obv.invite_links (code, created_by, max_uses, note) values (obv.new_invite_code(), p_actor, p_max, n) returning * into l;
  perform obv.audit(p_actor, 'invite.link_create', 'invite', l.code, jsonb_build_object('max_uses', p_max, 'note', n));
  return obv.link_json(l, p_owner_id);
end $$;
-- turn a link off, or change how many people it lets in (not below the people already in)
create or replace function public.obv_admin_invite_link_update(p_actor bigint, p_owner_id bigint, p_code text, p_patch jsonb)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare l obv.invite_links; m int;
begin
  select * into l from obv.invite_links where code = p_code for update;
  if not found then perform obv.err('not_found'); end if;
  if coalesce((p_patch ->> 'revoke')::boolean, false) and l.revoked_at is null then
    update obv.invite_links set revoked_at = now() where code = p_code returning * into l;
    perform obv.audit(p_actor, 'invite.link_revoke', 'invite', l.code, jsonb_build_object('note', l.note, 'uses', l.uses));
  end if;
  if p_patch ? 'max_uses' then
    if jsonb_typeof(p_patch -> 'max_uses') <> 'number' then perform obv.err('bad_request', '{"field":"max_uses"}'); end if;
    m := (p_patch ->> 'max_uses')::int;
    if m < greatest(1, l.uses) or m > 1000 then perform obv.err('bad_request', jsonb_build_object('field', 'max_uses', 'min', greatest(1, l.uses))); end if;
    if m <> l.max_uses then
      update obv.invite_links set max_uses = m where code = p_code returning * into l;
      perform obv.audit(p_actor, 'invite.link_limit', 'invite', l.code, jsonb_build_object('note', l.note, 'to', m));
    end if;
  end if;
  return obv.link_json(l, p_owner_id);
end $$;

-- what an invite link shows before logging in (a person's link or an admin's link)
create or replace function public.obv_invite_info(p_code text, p_owner_id bigint)
returns jsonb language plpgsql stable set search_path = obv, pg_temp as $$
declare u obv.users; l obv.invite_links; why text;
begin
  if p_code is null or p_code !~ '^[A-Za-z0-9]{10}$' then perform obv.err('not_found'); end if;
  select * into l from obv.invite_links where code = p_code;
  if found then
    select * into u from obv.users where osu_id = l.created_by; why := obv.link_ok(l, p_owner_id);
    return jsonb_build_object('inviter', jsonb_build_object('id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url), 'ok', why is null, 'reason', why);
  end if;
  select * into u from obv.users where invite_code = p_code;
  if not found then perform obv.err('not_found'); end if;
  return jsonb_build_object('inviter', jsonb_build_object('id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url),
    'ok', u.status = 'active' and (u.access = 'approved' or u.role = 'admin' or u.osu_id = p_owner_id) and obv.invite_room(u, p_owner_id),
    'reason', case when u.status <> 'active' or not (u.access = 'approved' or u.role = 'admin' or u.osu_id = p_owner_id) then 'inactive'
                   when not (obv.invite_state(u, p_owner_id) ->> 'can_invite')::boolean then 'not_allowed'
                   when not obv.invite_room(u, p_owner_id) then 'full' end);
end $$;

-- accept an invite (a person's link or an admin's link): access at once, counted on that link
create or replace function public.obv_invite_accept(p_id bigint, p_username text, p_avatar text, p_country text, p_code text, p_owner_id bigint)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare inv obv.users; me obv.users; l obv.invite_links; why text;
begin
  if p_code is null or p_code !~ '^[A-Za-z0-9]{10}$' then perform obv.err('not_found'); end if;
  perform public.obv_user_touch(p_id, p_username, p_avatar, p_country);
  select * into l from obv.invite_links where code = p_code for update; -- one accept at a time per link (the limit holds)
  if found then select * into inv from obv.users where osu_id = l.created_by;
  else
    select * into inv from obv.users where invite_code = p_code for update;
    if not found then perform obv.err('not_found'); end if;
  end if;
  select * into me from obv.users where osu_id = p_id for update;
  if me.access = 'approved' or me.role = 'admin' or p_id = p_owner_id then return jsonb_build_object('access', 'approved', 'already', true); end if;
  if me.status <> 'active' then perform obv.err('suspended'); end if;
  if me.access = 'denied' then perform obv.err('forbidden', '{"reason":"denied"}'); end if; -- an admin said no: an invite doesn't overrule that
  if inv.osu_id = p_id then perform obv.err('bad_request'); end if;
  if l.code is not null then
    why := obv.link_ok(l, p_owner_id);
    if why = 'full' then perform obv.err('invite_full'); elsif why is not null then perform obv.err('invite_inactive'); end if;
    update obv.invite_links set uses = uses + 1 where code = l.code;
  else
    if inv.status <> 'active' or not (inv.access = 'approved' or inv.role = 'admin' or inv.osu_id = p_owner_id) then perform obv.err('invite_inactive'); end if;
    if not (obv.invite_state(inv, p_owner_id) ->> 'can_invite')::boolean then perform obv.err('invite_inactive'); end if;
    if not obv.invite_room(inv, p_owner_id) then perform obv.err('invite_full'); end if;
  end if;
  update obv.users set access = 'approved', access_decided_at = now(), access_decided_by = inv.osu_id,
    invited_by = inv.osu_id, invited_at = now(), invited_via = l.code, can_invite = null where osu_id = p_id;
  perform obv.audit(p_id, 'access.invite', 'user', p_id::text, jsonb_build_object('username', me.username, 'inviter', inv.osu_id, 'inviter_name', inv.username, 'link', l.code, 'note', l.note));
  return jsonb_build_object('access', 'approved', 'inviter', jsonb_build_object('id', inv.osu_id, 'username', inv.username));
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
