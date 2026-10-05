-- Guests may watch live sessions (Admin → Settings → Permissions → "Watch live sessions", Guest column): they join
-- from an invite link and only watch (the host's playback and edits); they can't edit, highlight, comment or chat.
-- Members join live sessions with "Online features" as before. obv_site_perms() picks the new key up by itself.
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
         ('perm_guest_live', 'bool', null, null, 'false'::jsonb)
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
