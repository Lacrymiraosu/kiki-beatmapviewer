-- Invites: each person chooses whether their links open with the animated invitation (glitch, lightning, flashes) or
-- the plain invite page (Invite friends page → "Invitation effect"). Admin links follow their maker's choice.
-- Run once, after the invite migrations. Until it has run, every link opens with the animation (as before).

alter table obv.users add column if not exists invite_fx boolean not null default true;

create or replace function public.obv_invite_fx_set(p_actor bigint, p_on boolean)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
begin
  if p_on is null then perform obv.err('bad_request', '{"field":"on"}'); end if;
  update obv.users set invite_fx = p_on where osu_id = p_actor;
  if not found then perform obv.err('no_user'); end if;
  return jsonb_build_object('fx', p_on);
end $$;

create or replace function public.obv_invite_mine(p_actor bigint, p_owner_id bigint)
returns jsonb language plpgsql set search_path = obv, pg_temp as $$
declare u obv.users;
begin
  select * into u from obv.users where osu_id = p_actor for update;
  if not found then perform obv.err('no_user'); end if;
  if u.invite_code is null then update obv.users set invite_code = obv.new_invite_code() where osu_id = p_actor returning * into u; end if;
  return jsonb_build_object('code', u.invite_code, 'fx', u.invite_fx) || obv.invite_state(u, p_owner_id)
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
    return jsonb_build_object('inviter', jsonb_build_object('id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url), 'ok', why is null, 'reason', why, 'fx', u.invite_fx);
  end if;
  select * into u from obv.users where invite_code = p_code;
  if not found then perform obv.err('not_found'); end if;
  return jsonb_build_object('inviter', jsonb_build_object('id', u.osu_id, 'username', u.username, 'avatar', u.avatar_url),
    'ok', u.status = 'active' and (u.access = 'approved' or u.role = 'admin' or u.osu_id = p_owner_id) and obv.invite_room(u, p_owner_id),
    'reason', case when u.status <> 'active' or not (u.access = 'approved' or u.role = 'admin' or u.osu_id = p_owner_id) then 'inactive'
                   when not (obv.invite_state(u, p_owner_id) ->> 'can_invite')::boolean then 'not_allowed'
                   when not obv.invite_room(u, p_owner_id) then 'full' end,
    'fx', u.invite_fx);
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
