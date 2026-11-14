-- 0054: Abonnementen (free/premium, admin onbeperkt) en AI-limieten per gebruiker.
-- Edge function 'ask' roept internal_ai_take('chat'|'pair') aan vóór elke Gemini-oproep; de app leest get_ai_quota().
alter table app.profiles add column if not exists plan text not null default 'free' check (plan in ('free','premium'));
alter table app.profiles add column if not exists plan_until timestamptz;

create table if not exists app.plan_limits (
  plan text not null, feature text not null,
  per_day int, per_month int,           -- null = geen limiet
  primary key (plan, feature)
);
alter table app.plan_limits enable row level security;
revoke all on app.plan_limits from public, anon, authenticated;
insert into app.plan_limits (plan, feature, per_day, per_month) values
  ('free','chat',3,30), ('free','pair',3,null), ('free','workout_feedback',0,0), ('free','briefing',1,null),
  ('premium','chat',30,300), ('premium','pair',20,null), ('premium','workout_feedback',5,null), ('premium','briefing',1,null)
on conflict (plan, feature) do update set per_day = excluded.per_day, per_month = excluded.per_month;

create table if not exists app.ai_requests (
  user_id uuid not null default app.uid() references auth.users(id) on delete cascade,
  day date not null, feature text not null, n int not null default 0,
  primary key (user_id, day, feature)
);
alter table app.ai_requests enable row level security;
drop policy if exists hh_own on app.ai_requests;
create policy hh_own on app.ai_requests for select to authenticated using (user_id = app.uid());
grant select on app.ai_requests to authenticated;

create or replace function app.effective_plan(p_uid uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when p.is_admin then 'admin'
              when p.plan = 'premium' and (p.plan_until is null or p.plan_until > now()) then 'premium'
              else 'free' end
  from app.profiles p where p.user_id = p_uid;
$$;

create or replace function public.internal_ai_take(p_feature text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := app.uid(); pl text; lim record; d date := (now() at time zone 'Europe/Brussels')::date;
  used_d int; used_m int;
begin
  if u is null then return jsonb_build_object('ok', false, 'reason', 'geen gebruiker'); end if;
  pl := coalesce(app.effective_plan(u), 'free');
  if pl = 'admin' then
    insert into app.ai_requests (user_id, day, feature, n) values (u, d, p_feature, 1)
    on conflict (user_id, day, feature) do update set n = app.ai_requests.n + 1;
    return jsonb_build_object('ok', true, 'plan', pl);
  end if;
  select * into lim from app.plan_limits where plan = pl and feature = p_feature;
  if not found then return jsonb_build_object('ok', false, 'plan', pl, 'reason', 'onbekende functie'); end if;
  select coalesce(sum(n) filter (where day = d), 0), coalesce(sum(n) filter (where day >= date_trunc('month', d)::date), 0)
    into used_d, used_m from app.ai_requests where user_id = u and feature = p_feature;
  if (lim.per_day is not null and used_d >= lim.per_day) or (lim.per_month is not null and used_m >= lim.per_month) then
    return jsonb_build_object('ok', false, 'plan', pl, 'reason', 'limiet',
      'per_day', lim.per_day, 'per_month', lim.per_month, 'used_day', used_d, 'used_month', used_m);
  end if;
  insert into app.ai_requests (user_id, day, feature, n) values (u, d, p_feature, 1)
  on conflict (user_id, day, feature) do update set n = app.ai_requests.n + 1;
  return jsonb_build_object('ok', true, 'plan', pl,
    'remaining_day', case when lim.per_day is null then null else lim.per_day - used_d - 1 end,
    'remaining_month', case when lim.per_month is null then null else lim.per_month - used_m - 1 end);
end $$;
revoke all on function public.internal_ai_take(text) from public, anon, authenticated;
grant execute on function public.internal_ai_take(text) to service_role;

create or replace function public.get_ai_quota() returns jsonb
language sql stable security definer set search_path = '' as $$
  with pl as (select coalesce(app.effective_plan(auth.uid()), 'free') p),
       d as (select (now() at time zone 'Europe/Brussels')::date d)
  select jsonb_build_object('plan', (select p from pl), 'features', coalesce(jsonb_object_agg(l.feature, jsonb_build_object(
    'per_day', l.per_day, 'per_month', l.per_month,
    'used_day', (select coalesce(sum(n),0) from app.ai_requests r where r.user_id = auth.uid() and r.feature = l.feature and r.day = (select d from d)),
    'used_month', (select coalesce(sum(n),0) from app.ai_requests r where r.user_id = auth.uid() and r.feature = l.feature and r.day >= date_trunc('month', (select d from d))::date))), '{}'::jsonb))
  from app.plan_limits l where l.plan = case (select p from pl) when 'admin' then 'premium' else (select p from pl) end;
$$;
revoke all on function public.get_ai_quota() from public, anon;
grant execute on function public.get_ai_quota() to authenticated;
