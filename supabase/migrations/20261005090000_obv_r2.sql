-- Project files on Cloudflare R2 (free tier) instead of Supabase Storage. When the Worker has its R2 binding, the
-- files go there and the Worker checks them (the database can't see R2), so the functions that looked in
-- storage.objects take what the Worker found instead. Without the binding nothing changes (Supabase Storage).
-- Also: the R2 operations of each month are counted here and refused above the limits, so the site stays free:
--   r2_class_a_month (uploads, file lists; R2 free tier 1 000 000 / month), r2_class_b_month (downloads, file checks;
--   free tier 10 000 000 / month). The storage budget may now go up to 9.5 GB (R2 free tier: 10 GB) and one project
--   up to 95 MB (the Worker accepts uploads up to 100 MB). Run once, after 20261004100000_obv_feedback.sql.

create or replace function obv.setting_spec() returns table (key text, kind text, min_v numeric, max_v numeric, def jsonb)
language sql immutable as $$
  values ('max_project_bytes', 'int', 1000000, 95000000, '30000000'::jsonb),
         ('storage_budget_bytes', 'int', 10000000, 9500000000, '900000000'::jsonb),
         ('retention_days', 'int', 1, 365, '15'::jsonb),
         ('max_projects_per_user', 'int', 1, 1000, '10'::jsonb),
         ('max_members_per_project', 'int', 1, 100, '20'::jsonb),
         ('max_annotations', 'int', 10, 20000, '2000'::jsonb),
         ('saving_enabled', 'bool', null, null, 'true'::jsonb),
         ('access_required', 'bool', null, null, 'true'::jsonb),
         ('invites_per_user', 'int', 0, 1000, '3'::jsonb),
         ('invitees_can_invite', 'bool', null, null, 'false'::jsonb),
         ('perm_guest_listing', 'bool', null, null, 'true'::jsonb),
         ('perm_guest_player', 'bool', null, null, 'true'::jsonb),
         ('perm_guest_mappers', 'bool', null, null, 'true'::jsonb),
         ('perm_guest_editor', 'bool', null, null, 'false'::jsonb),
         ('perm_member_listing', 'bool', null, null, 'true'::jsonb),
         ('perm_member_player', 'bool', null, null, 'true'::jsonb),
         ('perm_member_mappers', 'bool', null, null, 'true'::jsonb),
         ('perm_member_editor', 'bool', null, null, 'true'::jsonb),
         ('perm_member_online', 'bool', null, null, 'true'::jsonb),
         ('turn_enabled', 'bool', null, null, 'true'::jsonb),
         ('turn_ping_ms', 'int', 50, 1000, '150'::jsonb),
         ('perm_guest_live', 'bool', null, null, 'false'::jsonb),
         ('turn_month_gb', 'int', 0, 100000, '1000'::jsonb),
         ('r2_class_a_month', 'int', 0, 1000000, '900000'::jsonb),
         ('r2_class_b_month', 'int', 0, 10000000, '9000000'::jsonb)
$$;
-- (values set before this migration above the new maximums are brought down to them)
update obv.settings s set value = to_jsonb(sp.max_v::bigint)
from obv.setting_spec() sp where sp.key = s.key and sp.kind = 'int' and sp.max_v is not null and (s.value #>> '{}')::numeric > sp.max_v;

-- ---------- R2 operations this month ----------
create table if not exists obv.r2_usage (
  month date primary key,
  class_a bigint not null default 0,
  class_b bigint not null default 0,
  refused_a bigint not null default 0,
  refused_b bigint not null default 0
);
alter table obv.r2_usage enable row level security;
grant select, insert, update, delete on obv.r2_usage to service_role;

create or replace function obv.r2_max(p_key text, p_hard bigint) returns bigint language sql stable set search_path = obv, pg_temp as $$
  select least(p_hard, coalesce((select (value #>> '{}')::bigint from obv.settings where key = p_key),
                                (select (def #>> '{}')::bigint from obv.setting_spec() where key = p_key)))
$$;
-- count p_a Class A and p_b Class B operations about to happen; refused (nothing counted) when that would pass the limit
create or replace function public.obv_r2_use(p_a int, p_b int)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare m date := date_trunc('month', now())::date; u obv.r2_usage; ma bigint := obv.r2_max('r2_class_a_month', 1000000); mb bigint := obv.r2_max('r2_class_b_month', 10000000);
begin
  insert into obv.r2_usage (month) values (m) on conflict (month) do nothing;
  select * into u from obv.r2_usage where month = m for update;
  if u.class_a + greatest(p_a, 0) > ma or u.class_b + greatest(p_b, 0) > mb then
    update obv.r2_usage set refused_a = refused_a + (case when u.class_a + greatest(p_a, 0) > ma then 1 else 0 end),
                            refused_b = refused_b + (case when u.class_b + greatest(p_b, 0) > mb then 1 else 0 end) where month = m;
    return jsonb_build_object('ok', false, 'a', u.class_a, 'b', u.class_b, 'max_a', ma, 'max_b', mb);
  end if;
  update obv.r2_usage set class_a = class_a + greatest(p_a, 0), class_b = class_b + greatest(p_b, 0) where month = m returning * into u;
  delete from obv.r2_usage where month < m - interval '13 months';
  return jsonb_build_object('ok', true, 'a', u.class_a, 'b', u.class_b, 'max_a', ma, 'max_b', mb);
end $$;
-- Admin → Storage: this month and the months before
create or replace function public.obv_r2_usage()
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select jsonb_build_object('max_a', obv.r2_max('r2_class_a_month', 1000000), 'max_b', obv.r2_max('r2_class_b_month', 10000000),
    'months', coalesce((select jsonb_agg(jsonb_build_object('month', month, 'a', class_a, 'b', class_b, 'refused_a', refused_a, 'refused_b', refused_b) order by month desc)
      from (select * from obv.r2_usage order by month desc limit 12) x), '[]'::jsonb))
$$;

-- ---------- saving: the Worker checks the uploads on R2 ----------
-- the uploads of an open save (their keys and declared sizes), for the Worker to check before committing
create or replace function public.obv_save_pending(p_actor bigint, p_save uuid)
returns jsonb language sql stable set search_path = obv, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', b.key, 'size', b.size)), '[]'::jsonb)
  from obv.blobs b join obv.saves s on s.id = b.save_id
  where b.save_id = p_save and b.state = 'pending' and s.user_id = p_actor
$$;

-- p_stored: { key: size } as found on R2 by the Worker; null = check Supabase Storage (storage.objects) like before
drop function if exists public.obv_save_commit(bigint, uuid, jsonb);
create or replace function public.obv_save_commit(p_actor bigint, p_save uuid, p_annotations jsonb, p_stored jsonb default null)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare sv obv.saves; r text; p obv.projects; bl obv.blobs; act bigint; total bigint; missing int; ann jsonb; lim bigint;
begin
  select * into sv from obv.saves where id = p_save for update;
  if not found or sv.user_id <> p_actor then perform obv.err('not_found'); end if;
  if sv.state = 'committed' then
    select * into p from obv.projects where id = sv.project_id;
    return jsonb_build_object('revision', sv.revision, 'already', true, 'size_bytes', p.size_bytes, 'expires_at', p.expires_at, 'updated_at', p.updated_at);
  end if;
  if sv.state <> 'open' or sv.created_at < now() - interval '3 hours' then perform obv.err('save_expired'); end if;
  perform obv.active_user(p_actor);
  r := obv.access(p_actor, sv.project_id);
  if r not in ('owner', 'editor') then perform obv.err('forbidden'); end if;
  select * into p from obv.projects where id = sv.project_id for update;
  lim := obv.limit_bytes(p.owner_id);
  if p.revision <> sv.base_revision then
    perform obv.err('conflict', jsonb_build_object('revision', p.revision, 'updated_at', p.updated_at,
      'saved_by', (select username from obv.users where osu_id = p.saved_by)));
  end if;
  for bl in select * from obv.blobs where save_id = p_save and state = 'pending' loop
    if p_stored is not null then act := (p_stored ->> bl.key)::bigint;
    else select (o.metadata ->> 'size')::bigint into act from storage.objects o where o.bucket_id = obv.bucket() and o.name = bl.key; end if;
    if act is null then perform obv.err('missing_upload', jsonb_build_object('key', bl.key)); end if;
    if act <> bl.size then perform obv.err('size_mismatch', jsonb_build_object('key', bl.key, 'declared', bl.size, 'stored', act)); end if;
  end loop;
  select count(*) into missing from jsonb_array_elements(sv.manifest) m
  where not exists (select 1 from obv.blobs b where b.key = m.value ->> 'key' and b.project_id = p.id
                    and (b.state = 'committed' or (b.state = 'pending' and b.save_id = p_save)));
  if missing > 0 then perform obv.err('bad_manifest'); end if;
  select coalesce(sum(b.size), 0) into total from jsonb_array_elements(sv.manifest) m join obv.blobs b on b.key = m.value ->> 'key';
  if total > lim then perform obv.err('too_large', jsonb_build_object('size', total, 'limit', lim)); end if;

  update obv.blobs set state = 'committed' where save_id = p_save and state = 'pending';
  update obv.blobs set state = 'orphaned', orphaned_at = now()
  where project_id = p.id and state = 'committed' and key not in (select m.value ->> 'key' from jsonb_array_elements(sv.manifest) m);
  update obv.projects set revision = revision + 1, manifest = sv.manifest, size_bytes = total, updated_at = now(), saved_by = p_actor
  where id = p.id returning * into p;
  ann := obv.apply_annotations(p_actor, r, p.id, p_annotations);
  update obv.saves set state = 'committed', committed_at = now(), revision = p.revision where id = p_save;
  return jsonb_build_object('revision', p.revision, 'size_bytes', p.size_bytes, 'expires_at', p.expires_at, 'updated_at', p.updated_at,
    'annotations', ann, 'manifest', p.manifest);
end $$;

-- ---------- deleting: on R2 the Worker deleted the files (R2 deletes are immediate); p_external = trust it ----------
drop function if exists public.obv_cleanup_finish(uuid, text);
create or replace function public.obv_cleanup_finish(p_project uuid, p_error text, p_external boolean default false)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare p obv.projects; left_rows int; left_objs int := 0;
begin
  select * into p from obv.projects where id = p_project for update;
  if not found then return jsonb_build_object('done', true, 'gone', true); end if;
  if p.status <> 'deleting' then perform obv.err('not_deleting'); end if;
  if p_external then
    if p_error is null then delete from obv.blobs b where b.project_id = p.id; end if;
  else
    delete from obv.blobs b where b.project_id = p.id
      and not exists (select 1 from storage.objects o where o.bucket_id = obv.bucket() and o.name = b.key);
    select count(*) into left_objs from storage.objects o where o.bucket_id = obv.bucket() and o.name like 'p/' || p.id || '/%';
  end if;
  select count(*) into left_rows from obv.blobs where project_id = p.id;
  if left_rows > 0 or left_objs > 0 or (p_external and p_error is not null) then
    update obv.projects set cleanup_attempts = cleanup_attempts + 1, cleanup_at = now(),
      cleanup_error = left(coalesce(p_error, format('%s file(s) still in storage', greatest(left_rows, left_objs))), 500)
    where id = p.id;
    return jsonb_build_object('done', false, 'remaining', greatest(left_rows, left_objs));
  end if;
  delete from obv.projects where id = p.id;
  perform obv.audit(null, 'project.purged', 'project', p.id::text, jsonb_build_object('reason', p.delete_reason, 'title', p.title, 'owner', p.owner_id, 'size', p.size_bytes));
  return jsonb_build_object('done', true);
end $$;

drop function if exists public.obv_gc_finish(text[]);
create or replace function public.obv_gc_finish(p_keys text[], p_external boolean default false)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare n int;
begin
  delete from obv.blobs b where b.key = any (p_keys) and b.state in ('orphaned', 'pending')
    and (b.state = 'orphaned' or b.created_at < now() - interval '3 hours')
    and (p_external or not exists (select 1 from storage.objects o where o.bucket_id = obv.bucket() and o.name = b.key));
  get diagnostics n = row_count;
  return jsonb_build_object('deleted', n);
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
