-- R2 upload links (worker.js, PUT /api/v1/files?u=…) are signed for 2 hours, so the Worker asks the database before
-- each write whether the upload is still wanted: the blob row is still 'pending', its save is still 'open' (not
-- committed, expired or older than 3 hours) and its project is still active. Anything else is refused, so a link can't
-- re-create a file after a commit, an aborted save or a project delete. It also gives the Worker the declared sha256,
-- which R2 checks against the bytes it receives. Read only; safe to run more than once.
-- Run after 20261005090000_obv_r2.sql.

create or replace function public.obv_r2_put_guard(p_key text)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select coalesce(
    (select case
       when b.state <> 'pending' then jsonb_build_object('ok', false, 'reason', 'not_pending')
       when s.id is null or s.state <> 'open' or s.created_at < now() - interval '3 hours' then jsonb_build_object('ok', false, 'reason', 'save_closed')
       when p.id is null or p.status <> 'active' or p.expires_at <= now() then jsonb_build_object('ok', false, 'reason', 'project_gone')
       else jsonb_build_object('ok', true, 'size', b.size, 'sha256', b.sha256)
     end
     from obv.blobs b
     left join obv.saves s on s.id = b.save_id and s.project_id = b.project_id
     left join obv.projects p on p.id = b.project_id
     where b.key = p_key),
    jsonb_build_object('ok', false, 'reason', 'gone'))
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
