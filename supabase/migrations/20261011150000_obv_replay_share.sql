-- Replay watcher, sharing a saved replay by link (members only). The owner of a saved replay can turn on a link
-- ?replay=<id>&key=<share_key>; the server opens it only for a logged-in, approved member (the replay routes are behind the
-- access gate and the "replays" feature switch, api/v1.js). The key is 24 random bytes (32 characters base64url, the
-- same format as a project's link_key); the id alone never opens anything. The link stops working when the owner turns it
-- off or resets it (a new key), when the replay is deleted (by its owner, with the account, or by the daily cleanup) and
-- the moment its 60 days are over. A wrong key, a revoked or old key, an expired or a missing replay all answer the same
-- not_found. What a link gives: the file and its score info only, never the owner (no owner_id, name or avatar).
-- * obv.replays.share_key (null = not shared; unique), and the functions public.obv_replay_share (the owner: on / reset /
--   off), public.obv_replay_shared (a member opening a link) and public.obv_replay_card (the link preview card,
--   api/og.js: only the map's title, artist and difficulty name)
-- * obv.replay_json (what the owner sees: list, save, open) now has share_key, so the owner's list shows which replays are
--   shared and their links; obv_account_export says which of your replays are shared (not the key)
-- * unchanged, and why: obv_replay_list / _save / _get / _delete and obv_replays_gc (they go through obv.replay_json or
--   delete the row, which ends its link), obv_account_delete (deletes your replays: their links end), obv_google_merge
--   (the replays move with their links; a duplicate that is dropped loses its link), obv_export_all (to_jsonb has the
--   new column; api/_lib/d1copy.js copies every column D1 has, see d1/migrations/0006_replay_share.sql)
-- Safe to run more than once. Run after 20261010090000_obv_replays.sql.
-- Check afterwards:  select count(*) from obv.replays where share_key is not null;   (harmless)

alter table obv.replays add column if not exists share_key text;
alter table obv.replays drop constraint if exists replays_share_key_check;
alter table obv.replays add constraint replays_share_key_check check (share_key is null or share_key ~ '^[A-Za-z0-9_-]{32}$');
create unique index if not exists replays_share_key_idx on obv.replays (share_key) where share_key is not null;

-- what the owner sees of a replay (list, save, open): as before, plus its share key (null when it isn't shared)
create or replace function obv.replay_json(r obv.replays) returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object('id', r.id, 'sha256', r.sha256, 'size', r.size, 'meta', r.meta, 'created_at', r.created_at, 'expires_at', r.expires_at, 'share_key', r.share_key)
$$;

-- the owner shares a replay: p_mode 'on' (keep the current key or make one) | 'reset' (a new key: old links stop working) | 'off'.
-- Someone else's replay, an expired or a missing one: not_found (the same as for any id).
create or replace function public.obv_replay_share(p_actor bigint, p_id uuid, p_mode text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare r obv.replays;
begin
  perform obv.active_user(p_actor);
  if p_mode is null or p_mode not in ('on', 'reset', 'off') then perform obv.err('bad_request', '{"field":"mode"}'); end if;
  update obv.replays set share_key = case p_mode when 'off' then null when 'reset' then left(obv.new_link_key(), 32) else coalesce(share_key, left(obv.new_link_key(), 32)) end
  where id = p_id and owner_id = p_actor and expires_at > now() returning * into r;
  if not found then perform obv.err('not_found'); end if;
  perform obv.audit(p_actor, 'replay.share_' || p_mode, 'replay', r.id::text, '{}'::jsonb);
  return jsonb_build_object('id', r.id, 'share_key', r.share_key, 'expires_at', r.expires_at);
end $$;

-- a member (p_actor, an active account) opens a shared link: the replay's file and score info only, never who saved it.
-- A wrong, revoked or old key, an expired or a missing replay, or an owner who is suspended: not_found, all the same.
create or replace function public.obv_replay_shared(p_actor bigint, p_id uuid, p_key text)
returns jsonb language plpgsql stable set search_path = obv, pg_temp as $$
declare r obv.replays;
begin
  perform obv.active_user(p_actor);
  if p_id is null or p_key is null or p_key !~ '^[A-Za-z0-9_-]{32}$' then perform obv.err('not_found'); end if;
  select x.* into r from obv.replays x join obv.users o on o.osu_id = x.owner_id
  where x.id = p_id and x.share_key is not null and x.share_key = p_key and x.expires_at > now() and o.status = 'active'
    and not exists (select 1 from obv.account_deletions d where d.osu_id = x.owner_id);
  if not found then perform obv.err('not_found'); end if;
  return jsonb_build_object('replay', jsonb_build_object('id', r.id, 'size', r.size, 'meta', r.meta, 'created_at', r.created_at, 'expires_at', r.expires_at), 'data', r.data_b64);
end $$;

-- the link preview card (api/og.js, anyone who has the link, no login): the map's title, artist and difficulty name only
-- (never the player, the score or the owner); not_found exactly when obv_replay_shared would say not_found
create or replace function public.obv_replay_card(p_id uuid, p_key text)
returns jsonb language plpgsql stable set search_path = obv, pg_temp as $$
declare r obv.replays;
begin
  if p_id is null or p_key is null or p_key !~ '^[A-Za-z0-9_-]{32}$' then perform obv.err('not_found'); end if;
  select x.* into r from obv.replays x join obv.users o on o.osu_id = x.owner_id
  where x.id = p_id and x.share_key is not null and x.share_key = p_key and x.expires_at > now() and o.status = 'active'
    and not exists (select 1 from obv.account_deletions d where d.osu_id = x.owner_id);
  if not found then perform obv.err('not_found'); end if;
  return jsonb_build_object(
    'title', case when jsonb_typeof(r.meta -> 'title') = 'string' then left(r.meta ->> 'title', 300) end,
    'artist', case when jsonb_typeof(r.meta -> 'artist') = 'string' then left(r.meta ->> 'artist', 300) end,
    'version', case when jsonb_typeof(r.meta -> 'version') = 'string' then left(r.meta ->> 'version', 300) end);
end $$;

-- "Download my data": as in 20261010090000_obv_replays.sql, plus whether each of your replays is shared (not the key)
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
    'replays', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'size', r.size, 'meta', r.meta, 'created_at', r.created_at, 'expires_at', r.expires_at, 'shared', r.share_key is not null) order by r.created_at)
      from obv.replays r where r.owner_id = p_user and r.expires_at > now()), '[]'::jsonb),
    'invite_links', coalesce((select jsonb_agg(to_jsonb(l)) from obv.invite_links l where l.created_by = p_user), '[]'::jsonb),
    'backup_logins', coalesce((select jsonb_agg(jsonb_build_object('provider', provider, 'linked_at', created_at, 'last_used_at', last_used_at))
      from obv.user_logins where osu_id = p_user), '[]'::jsonb),
    'activity_log', coalesce((select jsonb_agg(to_jsonb(a) order by a.at desc) from (select * from obv.audit_log where actor_id = p_user order by at desc limit 200) a), '[]'::jsonb),
    'exported_at', now());
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
