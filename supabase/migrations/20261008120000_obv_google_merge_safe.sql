-- A Google-only account moving into an osu! account (obv_google_merge, from 20261006090000_obv_google_only.sql), safer:
--  * it only runs when the person confirms it (POST /api/v1/me/merge-google after an osu! login in a browser that held a
--    Google-only login), no longer on every such osu! login: that login may have been left by someone else on a shared
--    computer, or set by another site;
--  * a denial (or a suspension) is never lifted by it: the osu! account keeps 'denied' whatever the Google-only account
--    had (an invite it accepted doesn't let a denied osu! account in), and a denied or suspended Google-only account
--    can't move into an osu! account at all;
--  * obv_google_merge_preview: what the page shows before asking (how many projects would move), and whether it can.
-- Same signatures as before; safe to run more than once. Run after 20261008110000_obv_session_revoke.sql.

-- what a merge of p_from into p_to would do, without changing anything
create or replace function public.obv_google_merge_preview(p_from bigint, p_to bigint)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare f obv.users;
begin
  if p_from is null or p_from < 1000000000000 or p_to is null or p_to <= 0 or p_to >= 1000000000000 then perform obv.err('bad_user'); end if;
  select * into f from obv.users where osu_id = p_from;
  if not found then return jsonb_build_object('ok', false, 'reason', 'gone'); end if;
  if f.access = 'denied' or f.status <> 'active' then return jsonb_build_object('ok', false, 'reason', 'source_denied'); end if;
  if exists (select 1 from obv.account_deletions where osu_id = p_to) then return jsonb_build_object('ok', false, 'reason', 'deleted'); end if;
  return jsonb_build_object('ok', true, 'created_at', f.created_at,
    'projects', (select count(*) from obv.projects where owner_id = p_from and status = 'active'));
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
           where n.nspname = 'public' and p.proname in ('obv_google_merge', 'obv_google_merge_preview') loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f.sig); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f.sig); end if;
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
