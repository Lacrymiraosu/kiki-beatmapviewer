-- Account settings, "Download my data" and Delete account, for every logged-in user (Account settings page).
-- * Settings kept on the account: allow_add (others may add you to their online projects) and prefs (the site's
--   settings, when "Sync my settings across devices" is on).
-- * Delete account: right away the account is emptied (name, avatar, country, access, admin notes, invite code,
--   settings), your memberships in other people's projects, your comments on them, your invite links and your backup
--   logins are deleted, and your own projects are marked for deletion (their files go with the next cleanup, usually
--   at once). The account row itself goes as soon as its projects are gone. A tombstone (osu! ID + when) stops logins
--   made before the deletion, on any device; logging in again afterwards starts a new, empty account.
--   The site owner's account can't be deleted.
-- Run once, after the earlier migrations.

alter table obv.users add column if not exists allow_add boolean not null default true;
alter table obv.users add column if not exists prefs jsonb check (prefs is null or octet_length(prefs::text) <= 20000);
alter table obv.users add column if not exists prefs_at timestamptz;

create table if not exists obv.account_deletions (
  osu_id bigint primary key,
  deleted_at timestamptz not null default now()
);
alter table obv.account_deletions enable row level security;
grant select, insert, update, delete on obv.account_deletions to service_role;

-- a deleted account stops working everywhere (every project / save / share function checks this)
create or replace function obv.active_user(p_actor bigint) returns obv.users language plpgsql stable set search_path = obv, pg_temp as $$
declare u obv.users;
begin
  select * into u from obv.users where osu_id = p_actor;
  if not found or exists (select 1 from obv.account_deletions d where d.osu_id = p_actor) then perform obv.err('no_user'); end if;
  if u.status <> 'active' then perform obv.err('suspended', jsonb_build_object('reason', u.status_reason)); end if;
  return u;
end $$;

-- as before, plus: a deleted account isn't brought back (the server then logs that session out or, for a login made
-- after the deletion, calls obv_account_restart), and prefs_at so a browser knows the account has newer settings
create or replace function public.obv_user_touch(p_id bigint, p_username text, p_avatar text, p_country text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users; d timestamptz;
begin
  if p_id is null or p_id <= 0 then perform obv.err('bad_user'); end if;
  select deleted_at into d from obv.account_deletions where osu_id = p_id;
  if d is not null then return jsonb_build_object('id', p_id, 'status', 'deleted', 'deleted_at', d); end if;
  insert into obv.users (osu_id, username, avatar_url, country, last_seen_at)
  values (p_id, left(p_username, 64), left(p_avatar, 300), left(p_country, 4), now())
  on conflict (osu_id) do update set last_seen_at = now(),
    username = coalesce(excluded.username, obv.users.username), avatar_url = coalesce(excluded.avatar_url, obv.users.avatar_url)
  returning * into u;
  return jsonb_build_object('id', u.osu_id, 'username', u.username, 'status', u.status, 'status_reason', u.status_reason,
    'role', u.role, 'limits', obv.user_limits(u.osu_id),
    'access', u.access, 'access_requested_at', u.access_requested_at, 'access_decided_at', u.access_decided_at,
    'access_required', public.obv_access_required(), 'prefs_at', u.prefs_at);
end $$;

-- a login made after the account was deleted: start again with a new, empty account
create or replace function public.obv_account_restart(p_id bigint, p_since timestamptz)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare d timestamptz;
begin
  select deleted_at into d from obv.account_deletions where osu_id = p_id;
  if d is null then return jsonb_build_object('restarted', false); end if;
  if p_since is null or p_since <= d then perform obv.err('forbidden', '{"reason":"deleted"}'); end if;
  delete from obv.account_deletions where osu_id = p_id;
  return jsonb_build_object('restarted', true);
end $$;

-- ---------- settings ----------
create or replace function public.obv_account_get(p_user bigint)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users := obv.active_user(p_user);
begin
  return jsonb_build_object('id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url, 'country', u.country,
    'created_at', u.created_at, 'allow_add', u.allow_add, 'sync', coalesce((u.prefs ->> 'sync')::boolean, false), 'prefs_at', u.prefs_at,
    'projects', (select count(*) from obv.projects where owner_id = p_user and status = 'active'));
end $$;

-- p_patch: { allow_add?: bool, sync?: bool, prefs?: object } (prefs = the site's settings, only kept while sync is on)
create or replace function public.obv_account_set(p_user bigint, p_patch jsonb)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users := obv.active_user(p_user); sync boolean;
begin
  if p_patch ? 'allow_add' then
    if jsonb_typeof(p_patch -> 'allow_add') <> 'boolean' then perform obv.err('bad_request', '{"field":"allow_add"}'); end if;
    update obv.users set allow_add = (p_patch ->> 'allow_add')::boolean where osu_id = p_user;
  end if;
  if p_patch ? 'sync' then
    if jsonb_typeof(p_patch -> 'sync') <> 'boolean' then perform obv.err('bad_request', '{"field":"sync"}'); end if;
    sync := (p_patch ->> 'sync')::boolean;
    -- turning it off forgets the settings kept on the account
    update obv.users set prefs = case when sync then jsonb_build_object('sync', true, 'data', coalesce(prefs -> 'data', '{}'::jsonb)) else null end,
      prefs_at = case when sync then coalesce(prefs_at, now()) else null end where osu_id = p_user;
  end if;
  if p_patch ? 'prefs' then
    if jsonb_typeof(p_patch -> 'prefs') <> 'object' then perform obv.err('bad_request', '{"field":"prefs"}'); end if;
    if octet_length((p_patch -> 'prefs')::text) > 16000 then perform obv.err('too_large', '{"field":"prefs"}'); end if;
    update obv.users set prefs = jsonb_build_object('sync', true, 'data', p_patch -> 'prefs'), prefs_at = now()
      where osu_id = p_user and coalesce((prefs ->> 'sync')::boolean, false);
  end if;
  return public.obv_account_get(p_user);
end $$;

create or replace function public.obv_account_prefs(p_user bigint)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users := obv.active_user(p_user);
begin
  return jsonb_build_object('sync', coalesce((u.prefs ->> 'sync')::boolean, false), 'prefs', u.prefs -> 'data', 'prefs_at', u.prefs_at);
end $$;

-- people who turned "others may add me" off can't be added (they can still be removed)
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
    if not exists (select 1 from obv.members where project_id = p_project and user_id = p_user) and
       (exists (select 1 from obv.users where osu_id = p_user and not allow_add) or exists (select 1 from obv.account_deletions where osu_id = p_user)) then
      perform obv.err('forbidden', '{"reason":"no_add"}');
    end if;
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

-- ---------- "Download my data": everything kept about you ----------
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
    'invite_links', coalesce((select jsonb_agg(to_jsonb(l)) from obv.invite_links l where l.created_by = p_user), '[]'::jsonb),
    'backup_logins', coalesce((select jsonb_agg(jsonb_build_object('provider', provider, 'linked_at', created_at, 'last_used_at', last_used_at))
      from obv.user_logins where osu_id = p_user), '[]'::jsonb),
    'activity_log', coalesce((select jsonb_agg(to_jsonb(a) order by a.at desc) from (select * from obv.audit_log where actor_id = p_user order by at desc limit 200) a), '[]'::jsonb),
    'exported_at', now());
end $$;

-- ---------- Delete account ----------
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

-- removes a deleted account's row once its projects are gone (after the cleanup; the daily cleanup calls obv_account_gc)
create or replace function public.obv_account_finish(p_user bigint)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
begin
  if not exists (select 1 from obv.account_deletions where osu_id = p_user) then return jsonb_build_object('removed', false); end if;
  if exists (select 1 from obv.projects where owner_id = p_user) then return jsonb_build_object('removed', false); end if;
  delete from obv.annotations where author_id = p_user;
  delete from obv.users where osu_id = p_user;
  return jsonb_build_object('removed', true);
end $$;

create or replace function public.obv_account_gc()
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare n int := 0; d record;
begin
  for d in select a.osu_id from obv.account_deletions a join obv.users u on u.osu_id = a.osu_id
           where not exists (select 1 from obv.projects p where p.owner_id = a.osu_id) loop
    perform public.obv_account_finish(d.osu_id); n := n + 1;
  end loop;
  return jsonb_build_object('removed', n);
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
