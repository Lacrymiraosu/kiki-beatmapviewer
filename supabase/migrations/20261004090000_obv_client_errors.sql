-- Error reports: when the site breaks in someone's browser (a script error), the page sends a short report so the
-- admins see it in Admin → Errors without waiting for someone to tell them. Nothing about the person is kept: no osu!
-- ID, no IP address, only the error, where in the code it happened, which page of the site, the site's version and the
-- browser family (e.g. "Safari · mobile"). The same error is counted on one row. At most 300 rows; rows not seen for
-- 60 days are removed. Also: obv_admin_badges (pending access requests and new errors, for the admins' account menu).
-- Run once, after the earlier migrations.

create table if not exists obv.client_errors (
  sig text primary key,
  message text not null,
  source text,
  stack text,
  page text,
  version text,
  browser text,
  count int not null default 1,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists client_errors_last on obv.client_errors (last_at desc);
alter table obv.client_errors enable row level security;
grant select, insert, update, delete on obv.client_errors to service_role;

-- one report (the server checks sizes and rate-limits per IP); a resolved error that happens again shows up again
create or replace function public.obv_error_report(p_message text, p_source text, p_stack text, p_page text, p_version text, p_browser text)
returns void language plpgsql set search_path = obv, pg_temp as $$
declare k text;
begin
  if p_message is null or char_length(p_message) = 0 then return; end if;
  k := md5(left(p_message, 300) || '|' || coalesce(left(p_source, 300), ''));
  insert into obv.client_errors as e (sig, message, source, stack, page, version, browser)
  values (k, left(p_message, 300), left(p_source, 300), left(p_stack, 2000), left(p_page, 60), left(p_version, 20), left(p_browser, 60))
  on conflict (sig) do update set count = least(e.count + 1, 1000000000), last_at = now(), resolved_at = null,
    stack = coalesce(excluded.stack, e.stack), page = excluded.page, version = excluded.version, browser = excluded.browser;
  delete from obv.client_errors where last_at < now() - interval '60 days';
  delete from obv.client_errors where sig in (select sig from obv.client_errors order by last_at desc offset 300);
end $$;

create or replace function public.obv_admin_errors(p_resolved boolean, p_limit int, p_offset int)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  with f as (select * from obv.client_errors where (resolved_at is not null) = coalesce(p_resolved, false))
  select jsonb_build_object(
    'total', (select count(*) from f),
    'open', (select count(*) from obv.client_errors where resolved_at is null),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('sig', sig, 'message', message, 'source', source, 'stack', stack, 'page', page,
        'version', version, 'browser', browser, 'count', count, 'first_at', first_at, 'last_at', last_at, 'resolved_at', resolved_at) order by last_at desc)
      from (select * from f order by last_at desc limit greatest(1, least(p_limit, 100)) offset greatest(0, p_offset)) x), '[]'::jsonb))
$$;

-- mark one error fixed (or open again), or clear every fixed one
create or replace function public.obv_admin_error_set(p_actor bigint, p_sig text, p_resolved boolean, p_clear boolean)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare n int;
begin
  if coalesce(p_clear, false) then
    delete from obv.client_errors where resolved_at is not null; get diagnostics n = row_count;
    perform obv.audit(p_actor, 'errors.clear', 'site', 'errors', jsonb_build_object('count', n));
    return jsonb_build_object('deleted', n);
  end if;
  update obv.client_errors set resolved_at = case when p_resolved then now() else null end where sig = p_sig;
  if not found then perform obv.err('not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- the admins' account menu: how many people wait for an answer, and how many errors nobody has looked at
create or replace function public.obv_admin_badges()
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object('pending', (select count(*) from obv.users where access = 'pending'),
    'errors', (select count(*) from obv.client_errors where resolved_at is null))
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
