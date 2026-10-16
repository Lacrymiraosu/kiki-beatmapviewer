-- Replay watcher, saving a replay online for 60 days. A person who opened an .osr file can keep it on the site (the .osr
-- itself, at most 1 MiB, as base64 text in one row, plus its score info) and open it again; every replay is deleted
-- automatically 60 days after it was saved (the daily cleanup calls obv_replays_gc; listing and opening ignore an
-- expired row at once), earlier by its owner, and with the account (foreign key: deleting the account row deletes them).
-- * obv.replays and the functions public.obv_replay_list / _save / _get / _delete and public.obv_replays_gc
-- * settings replay_budget_bytes (all replays together, default 100 000 000) and replays_per_user (default 20), and the
--   feature switch feat_replays ("replays"; the same list as FEATURE_KEYS in api/_lib/features.js): obv.setting_spec()
--   is the full list again, copied from 20261009090000_obv_feature_switches.sql, plus these three
-- * obv_export_all (the copy to D1) has the replays; obv_account_export lists them (no file bytes); obv_account_delete removes
--   them at once; obv_google_merge moves them to the osu! account (a duplicate file is dropped)
-- Safe to run more than once. Run after 20261009090000_obv_feature_switches.sql.
-- Check afterwards:  select count(*) from obv.replays;   and   select public.obv_replays_gc(0);   (both harmless)

create table if not exists obv.replays (
  id uuid primary key default gen_random_uuid(),
  owner_id bigint not null references obv.users (osu_id) on delete cascade,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size int not null check (size between 1 and 1048576),
  meta jsonb not null default '{}'::jsonb check (octet_length(meta::text) <= 6144), -- (the server keeps its own JSON to 4096 bytes; jsonb's text form adds spaces)
  data_b64 text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '60 days',
  unique (owner_id, sha256)
);
create index if not exists replays_expires_idx on obv.replays (expires_at);
create index if not exists replays_owner_idx on obv.replays (owner_id);
alter table obv.replays enable row level security;
revoke all on obv.replays from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on obv.replays from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on obv.replays from authenticated'; end if;
end $$;
grant select, insert, update, delete on obv.replays to service_role;

-- the settings (the full list, as in 20261009090000_obv_feature_switches.sql, plus the replay ones)
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
         ('r2_class_b_month', 'int', 0, 10000000, '9000000'::jsonb),
         ('replay_budget_bytes', 'int', 1000000, 1000000000, '100000000'::jsonb),
         ('replays_per_user', 'int', 1, 200, '20'::jsonb)
  ) as v(key, kind, min_v, max_v, def)
  union all
  select 'feat_' || k, 'bool', null::numeric, null::numeric, 'true'::jsonb
  from unnest(array['songs', 'preview', 'mappers', 'editor', 'create', 'projects', 'live', 'collab', 'drive', 'replays', 'ed_timing', 'ed_hitsounds', 'ed_verify', 'ed_setup', 'ed_notes', 'ed_compare', 'ed_test', 'ed_auto', 'ed_adv', 'ed_tools', 'ed_share', 'ed_annot']) as k
$$;


-- ---------- saved replays ----------
create or replace function obv.replay_json(r obv.replays) returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object('id', r.id, 'sha256', r.sha256, 'size', r.size, 'meta', r.meta, 'created_at', r.created_at, 'expires_at', r.expires_at)
$$;

create or replace function obv.replay_limits(p_user bigint) returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object('max_bytes', 1048576,
    'per_user', coalesce((obv.setting('replays_per_user') #>> '{}')::int, 20), 'days', 60,
    'budget_bytes', coalesce((obv.setting('replay_budget_bytes') #>> '{}')::bigint, 100000000),
    'used_bytes', (select coalesce(sum(size), 0) from obv.replays))
$$;

-- p_actor's replays that are still kept, newest first (never the file itself)
create or replace function public.obv_replay_list(p_actor bigint)
returns jsonb language plpgsql stable set search_path = obv, pg_temp as $$
begin
  perform obv.active_user(p_actor);
  return jsonb_build_object(
    'replays', coalesce((select jsonb_agg(obv.replay_json(r) order by r.created_at desc, r.id) from obv.replays r where r.owner_id = p_actor and r.expires_at > now()), '[]'::jsonb),
    'limits', obv.replay_limits(p_actor));
end $$;

-- keeps a replay for 60 days. The same file again returns the row that is there (existed: true; the deletion date does not move).
-- p_data is the file as standard base64; its length, sha256 and first byte (the game mode, 0..3) are checked here too.
create or replace function public.obv_replay_save(p_actor bigint, p_sha256 text, p_size int, p_meta jsonb, p_data text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users := obv.active_user(p_actor); r obv.replays; raw bytea; lim int; budget bigint; used bigint; n int;
begin
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' or p_size is null or p_size < 1 then perform obv.err('bad_request', '{"field":"size"}'); end if;
  if p_size > 1048576 then perform obv.err('too_large', jsonb_build_object('limit', 1048576)); end if;
  if p_meta is null or jsonb_typeof(p_meta) <> 'object' or octet_length(p_meta::text) > 6144 then perform obv.err('bad_request', '{"field":"meta"}'); end if;
  if p_data is null or p_data !~ '^[A-Za-z0-9+/]+={0,2}$' or length(p_data) <> 4 * ((p_size + 2) / 3) then perform obv.err('bad_request', '{"field":"data"}'); end if;
  raw := decode(p_data, 'base64');
  if length(raw) <> p_size or encode(sha256(raw), 'hex') <> p_sha256 then perform obv.err('bad_request', '{"field":"sha256"}'); end if;
  if get_byte(raw, 0) > 3 then perform obv.err('bad_request', '{"field":"mode"}'); end if;
  perform pg_advisory_xact_lock(hashtext('obv.replays'));
  delete from obv.replays where owner_id = p_actor and sha256 = p_sha256 and expires_at <= now(); -- (an expired copy not removed yet: this is a new save)
  select * into r from obv.replays where owner_id = p_actor and sha256 = p_sha256;
  if found then return jsonb_build_object('replay', obv.replay_json(r), 'existed', true); end if;
  if not coalesce((obv.setting('saving_enabled') #>> '{}')::boolean, true) then perform obv.err('saving_disabled'); end if;
  lim := coalesce((obv.setting('replays_per_user') #>> '{}')::int, 20);
  select count(*) into n from obv.replays where owner_id = p_actor and expires_at > now();
  if n >= lim then perform obv.err('replay_limit', jsonb_build_object('limit', lim)); end if;
  budget := coalesce((obv.setting('replay_budget_bytes') #>> '{}')::bigint, 100000000);
  select coalesce(sum(size), 0) into used from obv.replays;
  if used + p_size > budget then perform obv.err('storage_full'); end if;
  insert into obv.replays (owner_id, sha256, size, meta, data_b64) values (p_actor, p_sha256, p_size, p_meta, p_data)
  on conflict (owner_id, sha256) do nothing returning * into r;
  if not found then
    select * into r from obv.replays where owner_id = p_actor and sha256 = p_sha256;
    return jsonb_build_object('replay', obv.replay_json(r), 'existed', true);
  end if;
  return jsonb_build_object('replay', obv.replay_json(r), 'existed', false);
end $$;

-- one replay with its file (base64); someone else's id, an expired or a missing one: not_found
create or replace function public.obv_replay_get(p_actor bigint, p_id uuid)
returns jsonb language plpgsql stable set search_path = obv, pg_temp as $$
declare r obv.replays;
begin
  perform obv.active_user(p_actor);
  select * into r from obv.replays where id = p_id and owner_id = p_actor and expires_at > now();
  if not found then perform obv.err('not_found'); end if;
  return jsonb_build_object('replay', obv.replay_json(r), 'data', r.data_b64);
end $$;

create or replace function public.obv_replay_delete(p_actor bigint, p_id uuid)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
begin
  perform obv.active_user(p_actor);
  delete from obv.replays where id = p_id and owner_id = p_actor;
  if not found then perform obv.err('not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- the daily cleanup: removes the replays whose 60 days are over (p_limit at a time; 0 removes nothing)
create or replace function public.obv_replays_gc(p_limit int default 500)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare n int;
begin
  with d as (delete from obv.replays where id in (select id from obv.replays where expires_at < now() order by expires_at limit greatest(coalesce(p_limit, 0), 0)) returning 1)
  select count(*) into n from d;
  return jsonb_build_object('deleted', n);
end $$;

-- ---------- the copy to D1, "Download my data", Delete account, the Google merge (as before, with the replays) ----------
create or replace function public.obv_export_all()
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object(
    'users', coalesce((select jsonb_agg(to_jsonb(t)) from obv.users t), '[]'::jsonb),
    'account_deletions', coalesce((select jsonb_agg(to_jsonb(t)) from obv.account_deletions t), '[]'::jsonb),
    'settings', coalesce((select jsonb_agg(to_jsonb(t)) from obv.settings t), '[]'::jsonb),
    'changelog', coalesce((select jsonb_agg(to_jsonb(t)) from obv.changelog t), '[]'::jsonb),
    'client_errors', coalesce((select jsonb_agg(to_jsonb(t)) from obv.client_errors t), '[]'::jsonb),
    'audit_log', coalesce((select jsonb_agg(to_jsonb(t)) from obv.audit_log t), '[]'::jsonb),
    'job_runs', coalesce((select jsonb_agg(to_jsonb(t)) from obv.job_runs t), '[]'::jsonb),
    'r2_usage', coalesce((select jsonb_agg(to_jsonb(t)) from obv.r2_usage t), '[]'::jsonb),
    'invite_links', coalesce((select jsonb_agg(to_jsonb(t)) from obv.invite_links t), '[]'::jsonb),
    'user_logins', coalesce((select jsonb_agg(to_jsonb(t)) from obv.user_logins t), '[]'::jsonb),
    'projects', coalesce((select jsonb_agg(to_jsonb(t)) from obv.projects t), '[]'::jsonb),
    'members', coalesce((select jsonb_agg(to_jsonb(t)) from obv.members t), '[]'::jsonb),
    'saves', coalesce((select jsonb_agg(to_jsonb(t)) from obv.saves t), '[]'::jsonb),
    'blobs', coalesce((select jsonb_agg(to_jsonb(t)) from obv.blobs t), '[]'::jsonb),
    'annotations', coalesce((select jsonb_agg(to_jsonb(t)) from obv.annotations t), '[]'::jsonb),
    'replays', coalesce((select jsonb_agg(to_jsonb(t)) from obv.replays t), '[]'::jsonb),
    'exported_at', now())
$$;

create or replace function public.obv_account_export(p_user bigint)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users := obv.active_user(p_user);
begin
  return jsonb_build_object(
    'account', to_jsonb(u) - 'admin_note' - 'prefs',
    'settings', u.prefs,
    'own_projects', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'artist', p.artist, 'creator', p.creator, 'status', p.status,
        'created_at', p.created_at, 'expires_at', p.expires_at, 'size_bytes', p.size_bytes, 'revision', p.revision) order by p.created_at)
      from obv.projects p where p.owner_id = p_user), '[]'::jsonb),
    'shared_with_you', coalesce((select jsonb_agg(jsonb_build_object('project', p.id, 'title', p.title, 'role', m.role, 'added_at', m.added_at))
      from obv.members m join obv.projects p on p.id = m.project_id where m.user_id = p_user), '[]'::jsonb),
    'your_comments', (select count(*) from obv.annotations where author_id = p_user),
    'replays', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'size', r.size, 'meta', r.meta, 'created_at', r.created_at, 'expires_at', r.expires_at) order by r.created_at)
      from obv.replays r where r.owner_id = p_user and r.expires_at > now()), '[]'::jsonb),
    'invite_links', coalesce((select jsonb_agg(to_jsonb(l)) from obv.invite_links l where l.created_by = p_user), '[]'::jsonb),
    'backup_logins', coalesce((select jsonb_agg(jsonb_build_object('provider', provider, 'linked_at', created_at, 'last_used_at', last_used_at))
      from obv.user_logins where osu_id = p_user), '[]'::jsonb),
    'activity_log', coalesce((select jsonb_agg(to_jsonb(a) order by a.at desc) from (select * from obv.audit_log where actor_id = p_user order by at desc limit 200) a), '[]'::jsonb),
    'exported_at', now());
end $$;

create or replace function public.obv_account_delete(p_user bigint, p_owner_id bigint)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare ids jsonb;
begin
  perform obv.active_user(p_user);
  if p_owner_id is not null and p_user = p_owner_id then perform obv.err('forbidden', '{"reason":"owner"}'); end if;
  -- your own projects: no access from now on, files deleted by the cleanup
  select coalesce(jsonb_agg(id), '[]'::jsonb) into ids from obv.projects where owner_id = p_user and status = 'active';
  update obv.saves set state = 'expired' where state = 'open' and project_id in (select id from obv.projects where owner_id = p_user);
  update obv.projects set status = 'deleting', delete_reason = 'account', cleanup_at = now() where owner_id = p_user and status = 'active';
  -- what you did in other people's projects and your links
  delete from obv.annotations where author_id = p_user and project_id not in (select id from obv.projects where owner_id = p_user);
  delete from obv.members where user_id = p_user;
  delete from obv.invite_links where created_by = p_user;
  delete from obv.replays where owner_id = p_user; -- (saved replays: gone now, not when the account row is removed after its projects)
  delete from obv.user_logins where osu_id = p_user;
  update obv.users set invited_by = null where invited_by = p_user;
  -- the account itself: emptied now, removed once its projects are gone
  update obv.users set username = 'deleted', avatar_url = null, country = null, status_reason = null, role = 'user',
    access = 'none', access_message = null, access_requested_at = null, access_decided_at = null, access_decided_by = null,
    admin_note = null, invite_code = null, invited_by = null, invited_via = null, prefs = null, prefs_at = null, turn_relay = false
    where osu_id = p_user;
  insert into obv.account_deletions (osu_id) values (p_user) on conflict (osu_id) do update set deleted_at = now();
  perform obv.audit(p_user, 'account.delete', 'user', p_user::text, jsonb_build_object('projects', jsonb_array_length(ids)));
  perform public.obv_account_finish(p_user);
  return jsonb_build_object('projects', ids);
end $$;

-- the Google-only account p_from moves into the osu! account p_to (confirmed by its owner): everything moves, p_from is gone
create or replace function public.obv_google_merge(p_from bigint, p_to bigint, p_username text, p_avatar text, p_country text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare f obv.users; t obv.users; rk_f int; rk_t int; moved int;
begin
  if p_from is null or p_from < 1000000000000 or p_to is null or p_to <= 0 or p_to >= 1000000000000 then perform obv.err('bad_user'); end if;
  select * into f from obv.users where osu_id = p_from for update;
  if not found then return jsonb_build_object('merged', false); end if;
  -- a denied or suspended Google-only account doesn't get out of it by moving into an osu! account
  if f.access = 'denied' or f.status <> 'active' then perform obv.err('forbidden', '{"reason":"source_denied"}'); end if;
  if exists (select 1 from obv.account_deletions where osu_id = p_to) then return jsonb_build_object('merged', false); end if;
  insert into obv.users (osu_id, username, avatar_url, country, last_login_at, last_seen_at)
  values (p_to, left(coalesce(p_username, 'user'), 64), left(p_avatar, 300), left(p_country, 4), now(), now())
  on conflict (osu_id) do nothing;
  select * into t from obv.users where osu_id = p_to for update;
  -- access: the better of the two (approved > pending > none), except that a denied osu! account stays denied (and keeps
  -- its invite settings); its status (a suspension) stays as it is
  if t.access is distinct from 'denied' then
    rk_f := case f.access when 'approved' then 3 when 'pending' then 2 else 0 end;
    rk_t := case t.access when 'approved' then 3 when 'pending' then 2 else 0 end;
    if rk_f > rk_t then
      update obv.users set access = f.access, access_message = f.access_message, access_requested_at = f.access_requested_at,
        access_decided_at = f.access_decided_at, access_decided_by = f.access_decided_by,
        invited_by = coalesce(t.invited_by, f.invited_by), invited_at = coalesce(t.invited_at, f.invited_at), invited_via = coalesce(t.invited_via, f.invited_via)
      where osu_id = p_to;
    end if;
    update obv.users set can_invite = coalesce(t.can_invite, f.can_invite), invite_limit = coalesce(t.invite_limit, f.invite_limit) where osu_id = p_to;
    if t.invite_code is null and f.invite_code is not null then
      update obv.users set invite_code = null where osu_id = p_from;
      update obv.users set invite_code = f.invite_code where osu_id = p_to;
    end if;
  end if;
  -- what it made and where it's a member
  update obv.projects p set client_key = left(p.client_key, 50) || '-g' || left(p.id::text, 8)
    where p.owner_id = p_from and exists (select 1 from obv.projects q where q.owner_id = p_to and q.client_key = p.client_key);
  update obv.projects set owner_id = p_to where owner_id = p_from; get diagnostics moved = row_count;
  update obv.projects set saved_by = p_to where saved_by = p_from;
  delete from obv.members m where m.user_id = p_from and exists (select 1 from obv.members x where x.project_id = m.project_id and x.user_id = p_to);
  update obv.members set user_id = p_to where user_id = p_from;
  delete from obv.members m using obv.projects p where p.id = m.project_id and m.user_id = p.owner_id and p.owner_id = p_to; -- (not a member of their own)
  update obv.members set added_by = p_to where added_by = p_from;
  update obv.saves set user_id = p_to where user_id = p_from;
  update obv.annotations set author_id = p_to where author_id = p_from;
  update obv.invite_links set created_by = p_to where created_by = p_from;
  update obv.users set invited_by = p_to where invited_by = p_from;
  -- the Google login now opens the osu! account (unless that one already has another Google account)
  if exists (select 1 from obv.user_logins where provider = 'google' and osu_id = p_to) then
    delete from obv.user_logins where osu_id = p_from;
  else
    update obv.user_logins set osu_id = p_to, verified = true where osu_id = p_from;
  end if;
  delete from obv.user_logins where osu_id = p_from;
  -- saved replays move too (one with the same file already there is dropped), before the old account row goes (that would delete them)
  delete from obv.replays r where r.owner_id = p_from and exists (select 1 from obv.replays x where x.owner_id = p_to and x.sha256 = r.sha256);
  update obv.replays set owner_id = p_to where owner_id = p_from;
  insert into obv.account_deletions (osu_id) values (p_from) on conflict do nothing; -- (its old sessions end)
  delete from obv.users where osu_id = p_from;
  perform obv.audit(p_to, 'login.google_merged', 'user', p_to::text, jsonb_build_object('from', p_from, 'projects', moved));
  return jsonb_build_object('merged', true, 'projects', moved);
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
