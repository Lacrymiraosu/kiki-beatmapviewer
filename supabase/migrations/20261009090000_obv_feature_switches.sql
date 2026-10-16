-- Feature switches: the admin can turn any menu or function off for everyone at once (Admin → Features), e.g. when it has a
-- serious bug. Each switch is a bool setting feat_<key> (default on) next to the other settings, so it is changed through
-- the same validated, audited path (obv_admin_settings_set: audit action settings.change). obv_site_features() answers the
-- keys that are off; GET /api/v1/me puts them in front of every visitor. Run once, after 20261008120000_obv_google_merge_safe.sql.
-- The key list is the same as FEATURE_KEYS in api/_lib/features.js (tests/features.test.mjs checks that).

create or replace function obv.setting_spec() returns table (key text, kind text, min_v numeric, max_v numeric, def jsonb)
language sql immutable as $$
  select * from (values
         ('max_project_bytes', 'int', 1000000::numeric, 95000000::numeric, '30000000'::jsonb),
         ('storage_budget_bytes', 'int', 10000000, 9500000000, '900000000'::jsonb),
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
         ('turn_month_gb', 'int', 0, 100000, '1000'::jsonb),
         ('r2_class_a_month', 'int', 0, 1000000, '900000'::jsonb),
         ('r2_class_b_month', 'int', 0, 10000000, '9000000'::jsonb)
  ) as v(key, kind, min_v, max_v, def)
  union all
  select 'feat_' || k, 'bool', null::numeric, null::numeric, 'true'::jsonb
  from unnest(array['songs', 'preview', 'mappers', 'editor', 'create', 'projects', 'live', 'collab', 'drive', 'ed_timing', 'ed_hitsounds', 'ed_verify', 'ed_setup', 'ed_notes', 'ed_compare', 'ed_test', 'ed_auto', 'ed_adv', 'ed_tools', 'ed_share', 'ed_annot']) as k
$$;

-- the switches that are off, as the keys without the feat_ prefix
create or replace function public.obv_site_features()
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select coalesce(jsonb_agg(substr(sp.key, 6) order by sp.key), '[]'::jsonb)
  from obv.setting_spec() sp left join obv.settings s on s.key = sp.key
  where sp.key like 'feat\_%' and coalesce(s.value, sp.def) = 'false'::jsonb
$$;

-- ---------- only the server (service_role) may call it ----------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('obv_site_features') loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f.sig); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f.sig); end if;
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
