-- TURN relay: a monthly limit in GB (Admin → Settings → TURN relay; 0 = no limit). Over it, the server stops handing out
-- relay credentials until the next month (usage comes from Cloudflare's analytics). Also names for the usage list.
-- Run once, after the earlier migrations.

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
         ('turn_ping_ms', 'int', 50, 1000, '150'::jsonb),
         ('perm_guest_live', 'bool', null, null, 'false'::jsonb),
         ('turn_month_gb', 'int', 0, 100000, '1000'::jsonb)
$$;

create or replace function public.obv_turn_conf(p_user bigint)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object(
    'on', coalesce((obv.setting('turn_enabled') #>> '{}')::boolean, true),
    'ping_ms', coalesce((obv.setting('turn_ping_ms') #>> '{}')::int, 150),
    'month_gb', coalesce((obv.setting('turn_month_gb') #>> '{}')::int, 1000),
    'relay', coalesce((select u.turn_relay and u.status = 'active' from obv.users u where u.osu_id = p_user), false))
$$;

-- [{ id, username, avatar }] for these osu! ids (the ones that have an account row here)
create or replace function public.obv_usernames(p_ids bigint[])
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url)), '[]'::jsonb)
  from obv.users u where u.osu_id = any(p_ids[1:100])
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
