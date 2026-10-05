-- Moving the database to Cloudflare D1: every table of the site in one JSON answer, read by the server's
-- "Copy to D1" (Admin → Settings → Database; site owner only). Nothing is changed here. Run once, after
-- 20261005090000_obv_r2.sql.

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
    'exported_at', now())
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
