-- Ending logins (sessions are stateless signed cookies, so they can't be deleted one by one): every login of an account
-- made up to users.sessions_valid_after stops working. The server sets it for "Log out everywhere" (POST me/logout-all),
-- when a Google backup login is unlinked and when an admin suspends the account, and reads it with the user row it
-- already refreshes (obv_user_touch), so checking it costs no extra query.
-- Safe to run more than once, and backward compatible: a new nullable column (null = nothing ended), obv_user_touch
-- returns one more key, and a new function. The deployed server keeps working before and after.

alter table obv.users add column if not exists sessions_valid_after timestamptz;

-- same as in 20261003100000_obv_account.sql, plus sessions_valid_after
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
    'access_required', public.obv_access_required(), 'prefs_at', u.prefs_at, 'sessions_valid_after', u.sessions_valid_after);
end $$;

-- every login of p_user made up to p_at (the server's clock, which also stamps the logins) ends; never moves back
create or replace function public.obv_sessions_revoke(p_user bigint, p_at timestamptz)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare v timestamptz;
begin
  if p_user is null or p_user <= 0 then perform obv.err('bad_user'); end if;
  if p_at is null then p_at := now(); end if;
  update obv.users set sessions_valid_after = greatest(coalesce(sessions_valid_after, p_at), p_at)
  where osu_id = p_user returning sessions_valid_after into v;
  return jsonb_build_object('sessions_valid_after', v);
end $$;

-- ---------- only the server (service_role) may call any of this ----------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in ('obv_user_touch', 'obv_sessions_revoke') loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f.sig); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f.sig); end if;
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
