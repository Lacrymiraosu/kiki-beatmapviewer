-- Request access with Google: someone who can't (or doesn't want to) log in with osu! signs in with Google and types
-- their osu! name; the request is marked "via Google, osu! name not verified" for the admins. Once approved, that Google
-- account logs in as that osu! account. The link is confirmed the first time they log in with osu! in the same browser;
-- if someone else logs in with that osu! account, an unconfirmed Google link to it is removed.
-- Only for osu! names nobody uses here yet (no login, request, projects or shares), so an existing member can't be
-- taken over by typing their name. Run once, after the earlier migrations (needs 20261003090000_obv_alt_logins.sql).

alter table obv.user_logins add column if not exists verified boolean not null default true;

-- linking from Account settings happens after an osu! login: always confirmed
create or replace function public.obv_login_link(p_user bigint, p_provider text, p_subject text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare other bigint;
begin
  if p_provider is null or p_provider not in ('google') then perform obv.err('bad_request', '{"field":"provider"}'); end if;
  if p_subject is null or char_length(p_subject) not between 1 and 255 then perform obv.err('bad_request', '{"field":"subject"}'); end if;
  if not exists (select 1 from obv.users where osu_id = p_user) then perform obv.err('no_user'); end if;
  select osu_id into other from obv.user_logins where provider = p_provider and subject = p_subject;
  if other is not null and other <> p_user then perform obv.err('conflict', '{"reason":"linked_elsewhere"}'); end if;
  delete from obv.user_logins where provider = p_provider and osu_id = p_user and subject <> p_subject;
  insert into obv.user_logins (provider, subject, osu_id, verified) values (p_provider, p_subject, p_user, true)
  on conflict (provider, subject) do update set verified = true;
  perform obv.audit(p_user, 'login.link', 'user', p_user::text, jsonb_build_object('provider', p_provider));
  return public.obv_login_list(p_user);
end $$;

create or replace function public.obv_login_find(p_provider text, p_subject text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users; v boolean;
begin
  select users.* into u from obv.user_logins l join obv.users on users.osu_id = l.osu_id where l.provider = p_provider and l.subject = p_subject;
  if not found then return null; end if;
  select verified into v from obv.user_logins where provider = p_provider and subject = p_subject;
  update obv.user_logins set last_used_at = now() where provider = p_provider and subject = p_subject;
  return jsonb_build_object('id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url, 'country', u.country, 'status', u.status, 'verified', v);
end $$;

create or replace function public.obv_login_list(p_user bigint)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object(
    'google', (select jsonb_build_object('linked_at', created_at, 'last_used_at', last_used_at, 'verified', verified) from obv.user_logins where osu_id = p_user and provider = 'google'))
$$;

-- the request itself (the server looked the osu! name up on osu! and checked the Google sign-in)
create or replace function public.obv_google_request(p_sub text, p_id bigint, p_username text, p_avatar text, p_country text, p_message text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare other bigint; u obv.users; r jsonb;
begin
  if p_sub is null or char_length(p_sub) not between 1 and 255 then perform obv.err('bad_request', '{"field":"subject"}'); end if;
  if p_id is null or p_id <= 0 then perform obv.err('bad_user'); end if;
  if not public.obv_access_required() then perform obv.err('bad_request', '{"reason":"open"}'); end if;
  select osu_id into other from obv.user_logins where provider = 'google' and subject = p_sub;
  if other is not null and other <> p_id then perform obv.err('conflict', '{"reason":"linked_elsewhere"}'); end if;
  if other is null then
    -- only an osu! name nobody uses here yet
    select * into u from obv.users where osu_id = p_id;
    if exists (select 1 from obv.user_logins where osu_id = p_id)
       or (found and (u.last_seen_at is not null or u.access <> 'none' or u.role <> 'user' or u.status <> 'active'
                      or exists (select 1 from obv.projects where owner_id = p_id) or exists (select 1 from obv.members where user_id = p_id))) then
      perform obv.err('conflict', '{"reason":"osu_in_use"}');
    end if;
    delete from obv.account_deletions where osu_id = p_id; -- (an account deleted before: this starts a new one)
  end if;
  r := public.obv_access_request(p_id, p_username, p_avatar, p_country, p_message);
  insert into obv.user_logins (provider, subject, osu_id, verified) values ('google', p_sub, p_id, false) on conflict (provider, subject) do nothing;
  perform obv.audit(p_id, 'access.request_google', 'user', p_id::text, jsonb_build_object('username', p_username));
  return r || jsonb_build_object('verified', (select verified from obv.user_logins where provider = 'google' and subject = p_sub));
end $$;

-- an osu! login: confirms this browser's Google link (p_google_sub) and removes any other unconfirmed one
create or replace function public.obv_osu_login(p_id bigint, p_google_sub text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare n int;
begin
  if p_google_sub is not null then
    update obv.user_logins set verified = true where provider = 'google' and osu_id = p_id and subject = p_google_sub and not verified;
  end if;
  delete from obv.user_logins where osu_id = p_id and not verified;
  get diagnostics n = row_count;
  if n > 0 then perform obv.audit(p_id, 'login.unverified_removed', 'user', p_id::text, jsonb_build_object('count', n)); end if;
  return jsonb_build_object('removed', n);
end $$;

-- the admins' access list: + how the person asked (Google, confirmed or not)
create or replace function public.obv_admin_access(p_status text, p_q text, p_limit int, p_offset int)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  with f as (
    select u.* from obv.users u
    where (coalesce(p_status, '') = '' or u.access = p_status or (p_status = 'invited' and u.invited_by is not null))
      and (coalesce(p_q, '') = '' or u.username ilike '%' || p_q || '%' or u.osu_id::text = p_q)
  ), o as (
    select * from f order by
      case when access = 'pending' then access_requested_at end asc nulls last,
      coalesce(access_decided_at, access_requested_at, created_at) desc nulls last, osu_id
    limit greatest(1, least(p_limit, 100)) offset greatest(0, p_offset)
  )
  select jsonb_build_object('total', (select count(*) from f),
    'counts', (select jsonb_build_object('pending', count(*) filter (where access = 'pending'), 'approved', count(*) filter (where access = 'approved'),
                 'denied', count(*) filter (where access = 'denied'), 'none', count(*) filter (where access = 'none'),
                 'invited', count(*) filter (where invited_by is not null)) from obv.users),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
      'id', o.osu_id, 'username', o.username, 'avatar', o.avatar_url, 'country', o.country, 'status', o.status, 'role', o.role,
      'access', o.access, 'message', o.access_message, 'requested_at', o.access_requested_at, 'decided_at', o.access_decided_at,
      'decided_by', (select username from obv.users d where d.osu_id = o.access_decided_by),
      'invited_by', (select username from obv.users d where d.osu_id = o.invited_by),
      'can_invite', coalesce(o.can_invite, o.invited_by is null or coalesce((obv.setting('invitees_can_invite') #>> '{}')::boolean, false)),
      'custom_can_invite', o.can_invite,
      'google', (select jsonb_build_object('verified', l.verified) from obv.user_logins l where l.osu_id = o.osu_id and l.provider = 'google'),
      'created_at', o.created_at, 'last_seen_at', o.last_seen_at)) from o), '[]'::jsonb))
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
