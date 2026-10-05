-- The animated invitation is a privilege: only people an admin allows (and the owner and admins) can turn it on for
-- their links. Allowed in a person's admin panel ("Can use the animated invitation"); taking it away turns their
-- links back to the normal invite page at once. Run once, after the earlier invite migrations.

alter table obv.users add column if not exists invite_fx_allowed boolean not null default false;

-- may this account use the animated invitation
create or replace function obv.fx_allowed(u obv.users, p_owner_id bigint) returns boolean language sql stable as $$
  select u.invite_fx_allowed or u.role = 'admin' or u.osu_id = p_owner_id
$$;

drop function if exists public.obv_invite_fx_set(bigint, boolean);
create or replace function public.obv_invite_fx_set(p_actor bigint, p_on boolean, p_owner_id bigint)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users;
begin
  if p_on is null then perform obv.err('bad_request', '{"field":"on"}'); end if;
  select * into u from obv.users where osu_id = p_actor for update;
  if not found then perform obv.err('no_user'); end if;
  if p_on and not obv.fx_allowed(u, p_owner_id) then perform obv.err('forbidden', '{"reason":"fx_not_allowed"}'); end if;
  update obv.users set invite_fx = p_on where osu_id = p_actor;
  return jsonb_build_object('fx', p_on);
end $$;

create or replace function public.obv_invite_mine(p_actor bigint, p_owner_id bigint)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users;
begin
  select * into u from obv.users where osu_id = p_actor for update;
  if not found then perform obv.err('no_user'); end if;
  if u.invite_code is null then update obv.users set invite_code = obv.new_invite_code() where osu_id = p_actor returning * into u; end if;
  return jsonb_build_object('code', u.invite_code, 'fx', u.invite_fx and obv.fx_allowed(u, p_owner_id), 'fx_allowed', obv.fx_allowed(u, p_owner_id)) || obv.invite_state(u, p_owner_id)
    || jsonb_build_object('invited', coalesce((select jsonb_agg(jsonb_build_object('id', x.osu_id, 'username', x.username, 'avatar', x.avatar_url, 'at', x.invited_at,
         'active', x.status = 'active' and x.access = 'approved') order by x.invited_at desc) from obv.users x where x.invited_by = p_actor), '[]'::jsonb));
end $$;

create or replace function public.obv_invite_info(p_code text, p_owner_id bigint)
returns jsonb language plpgsql stable set search_path = obv, pg_temp as $$
declare u obv.users; l obv.invite_links; why text;
begin
  if p_code is null or p_code !~ '^[A-Za-z0-9]{10}$' then perform obv.err('not_found'); end if;
  select * into l from obv.invite_links where code = p_code;
  if found then
    select * into u from obv.users where osu_id = l.created_by; why := obv.link_ok(l, p_owner_id);
    return jsonb_build_object('inviter', jsonb_build_object('id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url), 'ok', why is null, 'reason', why,
      'fx', u.invite_fx and obv.fx_allowed(u, p_owner_id));
  end if;
  select * into u from obv.users where invite_code = p_code;
  if not found then perform obv.err('not_found'); end if;
  return jsonb_build_object('inviter', jsonb_build_object('id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url),
    'ok', u.status = 'active' and (u.access = 'approved' or u.role = 'admin' or u.osu_id = p_owner_id) and obv.invite_room(u, p_owner_id),
    'reason', case when u.status <> 'active' or not (u.access = 'approved' or u.role = 'admin' or u.osu_id = p_owner_id) then 'inactive'
                   when not (obv.invite_state(u, p_owner_id) ->> 'can_invite')::boolean then 'not_allowed'
                   when not obv.invite_room(u, p_owner_id) then 'full' end,
    'fx', u.invite_fx and obv.fx_allowed(u, p_owner_id));
end $$;

-- admin: allow / take away the animated invitation for one person
create or replace function public.obv_admin_invite_fx_allow(p_actor bigint, p_user bigint, p_on boolean)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users;
begin
  if p_on is null then perform obv.err('bad_request', '{"field":"on"}'); end if;
  select * into u from obv.users where osu_id = p_user for update;
  if not found then perform obv.err('not_found'); end if;
  if u.invite_fx_allowed is distinct from p_on then
    update obv.users set invite_fx_allowed = p_on where osu_id = p_user;
    perform obv.audit(p_actor, case when p_on then 'invite.fx_allow' else 'invite.fx_block' end, 'user', p_user::text, jsonb_build_object('username', u.username));
  end if;
  return jsonb_build_object('id', p_user, 'fx_allowed', p_on);
end $$;

create or replace function public.obv_admin_user_invites(p_user bigint, p_owner_id bigint)
returns jsonb language plpgsql stable set search_path = obv, pg_temp as $$
declare u obv.users;
begin
  select * into u from obv.users where osu_id = p_user;
  if not found then perform obv.err('not_found'); end if;
  return obv.invite_state(u, p_owner_id) || jsonb_build_object('has_link', u.invite_code is not null,
    'fx_allowed', obv.fx_allowed(u, p_owner_id), 'fx_custom', u.invite_fx_allowed, 'fx', u.invite_fx and obv.fx_allowed(u, p_owner_id),
    'invited_by', (select jsonb_build_object('id', x.osu_id, 'username', x.username) from obv.users x where x.osu_id = u.invited_by), 'invited_at', u.invited_at,
    'invited', coalesce((select jsonb_agg(jsonb_build_object('id', x.osu_id, 'username', x.username, 'at', x.invited_at, 'access', x.access) order by x.invited_at desc)
                         from obv.users x where x.invited_by = u.osu_id), '[]'::jsonb));
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
