-- "Report a problem": a visitor writes what went wrong (a button that does nothing, a wrong translation, something
-- that looks broken on their phone). It lands next to the automatic error reports in Admin → Errors, under Reports.
-- Kept with it: the text, the kind of page, the site's version and the browser family, and the osu! name only if the
-- person ticked "add my osu! name so the admins can ask me". At most 200 reports; ones not looked at for 90 days and
-- fixed ones after 60 days are removed. Run once, after 20261004090000_obv_client_errors.sql.

alter table obv.client_errors add column if not exists kind text not null default 'error' check (kind in ('error', 'report'));
alter table obv.client_errors add column if not exists reporter text;

create or replace function public.obv_feedback(p_message text, p_page text, p_version text, p_browser text, p_reporter text)
returns void language plpgsql set search_path = obv, pg_temp as $$
begin
  if p_message is null or char_length(trim(p_message)) < 3 then perform obv.err('bad_request', '{"field":"message"}'); end if;
  insert into obv.client_errors (sig, kind, message, page, version, browser, reporter)
  values (md5(random()::text || clock_timestamp()::text), 'report', left(trim(p_message), 1000), left(p_page, 60), left(p_version, 20), left(p_browser, 60), left(p_reporter, 64));
  delete from obv.client_errors where kind = 'report' and (last_at < now() - interval '90 days' or resolved_at < now() - interval '60 days');
  delete from obv.client_errors where sig in (select sig from obv.client_errors where kind = 'report' order by last_at desc offset 200);
end $$;

-- the list now has two kinds: automatic errors and people's reports
drop function if exists public.obv_admin_errors(boolean, int, int);
create or replace function public.obv_admin_errors(p_resolved boolean, p_limit int, p_offset int, p_kind text default 'error')
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  with f as (select * from obv.client_errors where (resolved_at is not null) = coalesce(p_resolved, false) and (coalesce(p_resolved, false) or kind = coalesce(p_kind, 'error')))
  select jsonb_build_object(
    'total', (select count(*) from f),
    'open', (select count(*) from obv.client_errors where resolved_at is null),
    'open_errors', (select count(*) from obv.client_errors where resolved_at is null and kind = 'error'),
    'open_reports', (select count(*) from obv.client_errors where resolved_at is null and kind = 'report'),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('sig', sig, 'kind', kind, 'message', message, 'source', source, 'stack', stack, 'page', page,
        'version', version, 'browser', browser, 'reporter', reporter, 'count', count, 'first_at', first_at, 'last_at', last_at, 'resolved_at', resolved_at) order by last_at desc)
      from (select * from f order by last_at desc limit greatest(1, least(p_limit, 100)) offset greatest(0, p_offset)) x), '[]'::jsonb))
$$;

-- automatic errors only for this one (reports have their own clean-up above)
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
  delete from obv.client_errors where kind = 'error' and last_at < now() - interval '60 days';
  delete from obv.client_errors where sig in (select sig from obv.client_errors where kind = 'error' order by last_at desc offset 300);
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
