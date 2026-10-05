-- TURN relay for live sessions (Cloudflare Realtime TURN). Live sessions are peer-to-peer; when someone's ping to the
-- host is above turn_ping_ms they switch to the relay by themselves. People an admin picks (their panel: "Always use the
-- TURN relay") skip peer-to-peer and use the relay from the start. Admin → Settings → TURN relay: on/off and the ping.
-- The relay is only handed out for a live session that was started (the server signs the session code).
-- Run once, after the earlier migrations.

alter table obv.users add column if not exists turn_relay boolean not null default false;

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
         ('invitees_can_invite', 'bool', null, null, 'false'::jsonb),
         ('perm_guest_listing', 'bool', null, null, 'true'::jsonb),
         ('perm_guest_player', 'bool', null, null, 'true'::jsonb),
         ('perm_guest_mappers', 'bool', null, null, 'true'::jsonb),
         ('perm_guest_editor', 'bool', null, null, 'false'::jsonb),
         ('perm_member_listing', 'bool', null, null, 'true'::jsonb),
         ('perm_member_player', 'bool', null, null, 'true'::jsonb),
         ('perm_member_mappers', 'bool', null, null, 'true'::jsonb),
         ('perm_member_editor', 'bool', null, null, 'true'::jsonb),
         ('perm_member_online', 'bool', null, null, 'true'::jsonb),
         ('turn_enabled', 'bool', null, null, 'true'::jsonb),
         ('turn_ping_ms', 'int', 50, 1000, '150'::jsonb)
$$;

-- { on, ping_ms, relay } for one person (p_user null: a guest)
create or replace function public.obv_turn_conf(p_user bigint)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object(
    'on', coalesce((obv.setting('turn_enabled') #>> '{}')::boolean, true),
    'ping_ms', coalesce((obv.setting('turn_ping_ms') #>> '{}')::int, 150),
    'relay', coalesce((select u.turn_relay and u.status = 'active' from obv.users u where u.osu_id = p_user), false))
$$;

-- admin: always use the relay for one person (or not)
create or replace function public.obv_admin_turn_relay(p_actor bigint, p_user bigint, p_on boolean)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users;
begin
  if p_on is null then perform obv.err('bad_request', '{"field":"on"}'); end if;
  select * into u from obv.users where osu_id = p_user for update;
  if not found then perform obv.err('not_found'); end if;
  if u.turn_relay is distinct from p_on then
    update obv.users set turn_relay = p_on where osu_id = p_user;
    perform obv.audit(p_actor, case when p_on then 'turn.relay_on' else 'turn.relay_off' end, 'user', p_user::text, jsonb_build_object('username', u.username));
  end if;
  return jsonb_build_object('id', p_user, 'turn_relay', p_on);
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
