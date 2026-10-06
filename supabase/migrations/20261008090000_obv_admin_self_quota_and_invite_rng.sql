-- Two small security fixes. Safe to run more than once; nothing changes shape (same signatures, same results), so the
-- deployed server keeps working before and after.
--  1. obv_admin_user_update: an admin who isn't the site owner can't change anything on their own account or on the
--     owner's (before, only status and role were guarded there, so an admin could raise their own or the owner's
--     limits). The owner can still change everything they could before.
--  2. obv.new_invite_code: the characters come from a cryptographically secure source instead of random(), with no
--     modulo bias. The bytes come from gen_random_uuid() (core PostgreSQL 13+, backed by pg_strong_random), so no
--     extension is needed. Same alphabet (56 characters) and length (10).

create or replace function public.obv_admin_user_update(p_actor bigint, p_actor_is_owner boolean, p_owner_id bigint, p_user bigint, p_patch jsonb)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users; changed jsonb := '{}'::jsonb; v jsonb; n numeric; k text; lo numeric; hi numeric;
begin
  if jsonb_typeof(p_patch) is distinct from 'object' then perform obv.err('bad_request'); end if;
  select * into u from obv.users where osu_id = p_user for update;
  if not found then perform obv.err('not_found'); end if;
  -- only the owner changes their own account or an admin's own: no field at all, limits and notes included
  if not coalesce(p_actor_is_owner, false) then
    if p_user = p_actor then perform obv.err('forbidden', '{"reason":"own account"}'); end if;
    if p_user = p_owner_id then perform obv.err('forbidden', '{"reason":"site owner"}'); end if;
  end if;
  if p_patch ? 'status' or p_patch ? 'role' then
    if p_user = p_actor then perform obv.err('forbidden', '{"reason":"own account"}'); end if;
    if p_user = p_owner_id then perform obv.err('forbidden', '{"reason":"site owner"}'); end if;
  end if;
  if p_patch ? 'status' then
    if p_patch ->> 'status' not in ('active', 'suspended') then perform obv.err('bad_request', '{"field":"status"}'); end if;
    if u.role = 'admin' and not p_actor_is_owner then perform obv.err('forbidden', '{"reason":"admins are managed by the owner"}'); end if;
    if p_patch ->> 'status' is distinct from u.status then
      update obv.users set status = p_patch ->> 'status',
        status_reason = case when p_patch ->> 'status' = 'suspended' then left(p_patch ->> 'reason', 300) end where osu_id = p_user;
      perform obv.audit(p_actor, 'user.' || (p_patch ->> 'status'), 'user', p_user::text, jsonb_build_object('username', u.username, 'reason', left(p_patch ->> 'reason', 300)));
    end if;
  end if;
  if p_patch ? 'role' then
    if not p_actor_is_owner then perform obv.err('forbidden', '{"reason":"only the site owner manages admins"}'); end if;
    if p_patch ->> 'role' not in ('user', 'admin') then perform obv.err('bad_request', '{"field":"role"}'); end if;
    if p_patch ->> 'role' is distinct from u.role then
      update obv.users set role = p_patch ->> 'role' where osu_id = p_user;
      perform obv.audit(p_actor, case when p_patch ->> 'role' = 'admin' then 'admin.add' else 'admin.remove' end, 'user', p_user::text, jsonb_build_object('username', u.username));
    end if;
  end if;
  foreach k in array array['max_projects', 'max_project_bytes', 'retention_days'] loop
    if not p_patch ? k then continue; end if;
    v := p_patch -> k;
    lo := case k when 'max_projects' then 0 when 'max_project_bytes' then 1000000 else 1 end;
    hi := case k when 'max_projects' then 1000 when 'max_project_bytes' then 2000000000 else 365 end;
    if jsonb_typeof(v) = 'null' then n := null;
    elsif jsonb_typeof(v) = 'number' then
      n := (v #>> '{}')::numeric;
      if n <> trunc(n) or n < lo or n > hi then perform obv.err('bad_request', jsonb_build_object('field', k, 'min', lo, 'max', hi)); end if;
    else perform obv.err('bad_request', jsonb_build_object('field', k)); end if;
    execute format('update obv.users set %I = $1 where osu_id = $2', k) using n, p_user;
    changed := changed || jsonb_build_object(k, v);
  end loop;
  if p_patch ? 'note' then
    update obv.users set admin_note = nullif(left(btrim(coalesce(p_patch ->> 'note', '')), 1000), '') where osu_id = p_user;
    changed := changed || jsonb_build_object('note', true);
  end if;
  if changed - 'note' <> '{}'::jsonb then
    perform obv.audit(p_actor, 'user.limits', 'user', p_user::text, jsonb_build_object('username', u.username) || (changed - 'note'));
    perform obv.sync_bucket_limit();
  elsif changed ? 'note' then
    perform obv.audit(p_actor, 'user.note', 'user', p_user::text, jsonb_build_object('username', u.username));
  end if;
  return public.obv_admin_user_get(p_user);
end $$;

-- 10 characters from the 56-character alphabet. Each byte is used only when it is below 224 (= 56 * 4), so every
-- character is equally likely. Bytes 6 and 8 of a v4 UUID carry the version/variant bits and are skipped.
create or replace function obv.new_invite_code() returns text language plpgsql volatile set search_path = obv, pg_temp as $$
declare c text; ch constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; b bytea; i int; x int;
begin
  loop
    c := '';
    while length(c) < 10 loop
      b := uuid_send(gen_random_uuid());
      for i in 0..15 loop
        continue when i = 6 or i = 8;
        x := get_byte(b, i);
        if x < 224 then
          c := c || substr(ch, 1 + x % 56, 1);
          exit when length(c) = 10;
        end if;
      end loop;
    end loop;
    exit when not exists (select 1 from obv.users where invite_code = c) and not exists (select 1 from obv.invite_links where code = c);
  end loop;
  return c;
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
