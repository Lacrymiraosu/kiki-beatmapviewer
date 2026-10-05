-- Backup login: a Google account linked to an osu! account, to log in when osu!'s login doesn't work.
-- Accounts stay osu! accounts: you link Google after logging in with osu! (Account → Backup logins); logging in with a
-- Google account that isn't linked to anyone is refused. One Google account per osu! account, and a Google account can
-- only be linked to one osu! account. Only the account's ID at Google ("sub") is kept. (provider: room for others later)
-- Run once, after the earlier migrations.

create table if not exists obv.user_logins (
  provider text not null check (provider in ('google')),
  subject text not null check (char_length(subject) between 1 and 255),
  osu_id bigint not null references obv.users (osu_id) on delete cascade,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  primary key (provider, subject),
  unique (provider, osu_id)
);
alter table obv.user_logins enable row level security; -- (no policies: only the server, with the service role)

-- link (or replace) this person's Google account
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
  insert into obv.user_logins (provider, subject, osu_id) values (p_provider, p_subject, p_user)
  on conflict (provider, subject) do nothing;
  perform obv.audit(p_user, 'login.link', 'user', p_user::text, jsonb_build_object('provider', p_provider));
  return public.obv_login_list(p_user);
end $$;

create or replace function public.obv_login_unlink(p_user bigint, p_provider text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
begin
  delete from obv.user_logins where provider = p_provider and osu_id = p_user;
  if found then perform obv.audit(p_user, 'login.unlink', 'user', p_user::text, jsonb_build_object('provider', p_provider)); end if;
  return public.obv_login_list(p_user);
end $$;

-- the osu! account a Google account is linked to (null when none), for logging in
create or replace function public.obv_login_find(p_provider text, p_subject text)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users;
begin
  select users.* into u from obv.user_logins l join obv.users on users.osu_id = l.osu_id where l.provider = p_provider and l.subject = p_subject;
  if not found then return null; end if;
  update obv.user_logins set last_used_at = now() where provider = p_provider and subject = p_subject;
  return jsonb_build_object('id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url, 'country', u.country, 'status', u.status);
end $$;

-- { google: { linked_at, last_used_at } | null }
create or replace function public.obv_login_list(p_user bigint)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object(
    'google', (select jsonb_build_object('linked_at', created_at, 'last_used_at', last_used_at) from obv.user_logins where osu_id = p_user and provider = 'google'))
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
grant select, insert, update, delete on obv.user_logins to service_role;
