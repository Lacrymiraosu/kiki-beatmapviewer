-- Permissions while the site is invite-only: what guests (not logged in, or logged in without approved access) and
-- members (approved) can use. Admin → Settings → Permissions. Admins and the owner can always use everything.
-- Areas: listing (Beatmap page: search, map details, previews, downloads), player (Preview player and shared links),
-- mappers (mapper pages), editor (Editor and modding tools), online (online projects, live sessions, collab, invites;
-- members only, it needs an account). Run once, after the earlier migrations.

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
         ('perm_member_online', 'bool', null, null, 'true'::jsonb)
$$;

-- { guest: { listing, player, mappers, editor, online }, member: { … } } with the defaults filled in
create or replace function public.obv_site_perms()
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  with s as (select sp.key, coalesce((select value from obv.settings where key = sp.key), sp.def) as v from obv.setting_spec() sp where sp.key like 'perm\_%')
  select jsonb_build_object(
    'guest', (select jsonb_object_agg(substr(key, 12), v) from s where key like 'perm\_guest\_%') || '{"online": false}'::jsonb,
    'member', (select jsonb_object_agg(substr(key, 13), v) from s where key like 'perm\_member\_%'))
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
