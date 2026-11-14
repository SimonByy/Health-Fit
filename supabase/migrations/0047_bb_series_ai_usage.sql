-- Body Battery als echte tijdreeks (niet de trage 'most recent'), daggrafiek met trainingen, en AI-verbruik.

-- 1) BB-reeks van Garmin: [[ts_ms, niveau], ...] → health.metric_samples 'body_battery_now' (1 punt per 15 min)
create or replace function public.internal_garmin_bb_series(p_series jsonb)
 returns int language plpgsql security definer set search_path to '' as $$
declare n int := 0; tz text := 'Europe/Brussels';
begin
  with pts as (
    select to_timestamp((e->>0)::numeric / 1000) ts, (e->>1)::numeric lvl
    from jsonb_array_elements(coalesce(p_series, '[]'::jsonb)) e
    where jsonb_typeof(e->0) = 'number' and jsonb_typeof(e->1) = 'number'),
  q as (
    select distinct on (date_trunc('hour', ts) + floor(extract(minute from ts) / 15) * interval '15 min')
      date_trunc('hour', ts) + floor(extract(minute from ts) / 15) * interval '15 min' as slot, ts, lvl
    from pts order by 1, ts desc)
  insert into health.metric_samples (metric, ts, day, hour, qty, units, source)
  select 'body_battery_now', slot, (slot at time zone tz)::date, extract(hour from slot at time zone tz)::smallint, lvl, '%', 'Garmin' from q
  on conflict (metric, ts) do update set qty = excluded.qty;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.internal_garmin_bb_series(jsonb) from public, anon, authenticated;

-- 2) Daggrafiek voor de readiness-uitleg: BB-verloop + trainingen
create or replace function public.get_bb_day(p_day date default null)
 returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare d date := coalesce(p_day, (now() at time zone 'Europe/Brussels')::date);
begin
  perform app.assert_owner();
  return jsonb_build_object(
    'day', d,
    'series', coalesce((select jsonb_agg(jsonb_build_array(extract(epoch from ts) * 1000, qty) order by ts)
                        from health.metric_samples where metric = 'body_battery_now' and day = d and not coalesce(voided, false)), '[]'::jsonb),
    'acts', coalesce((select jsonb_agg(x order by x->>'start') from (
        select jsonb_build_object('name', name, 'start', start_local, 'min', duration_min, 'kind', 'cardio') x from ai.workouts where day = d and not coalesce(duplicate_of_hevy, false)
        union all
        select jsonb_build_object('name', title, 'start', start_local, 'min', duration_min, 'kind', 'kracht') from ai.strength_workouts where day = d) z), '[]'::jsonb));
end $$;
grant execute on function public.get_bb_day(date) to authenticated;

-- 3) AI-verbruik (Gemini gratis laag): per dag tellen; de limiet zelf staat in app.settings 'ai_limit'
create table if not exists app.ai_usage (
  day date not null, model text not null, calls int not null default 0, limited int not null default 0,
  primary key (day, model));
alter table app.ai_usage enable row level security;
insert into app.settings (key, value) values ('ai_limit', '{"daily": 250, "reset_tz": "America/Los_Angeles"}')
  on conflict (key) do nothing;

create or replace function public.internal_ai_usage_add(p_model text, p_limited boolean default false)
 returns void language sql security definer set search_path to '' as $$
  insert into app.ai_usage (day, model, calls, limited)
  values ((now() at time zone 'America/Los_Angeles')::date, p_model, 1, case when p_limited then 1 else 0 end)
  on conflict (day, model) do update set calls = app.ai_usage.calls + 1, limited = app.ai_usage.limited + excluded.limited;
$$;
revoke all on function public.internal_ai_usage_add(text, boolean) from public, anon, authenticated;

create or replace function public.get_ai_usage()
 returns jsonb language plpgsql stable security definer set search_path to '' as $$
declare lim int; d date := (now() at time zone 'America/Los_Angeles')::date; used int; hit int;
begin
  perform app.assert_owner();
  select coalesce((value->>'daily')::int, 250) into lim from app.settings where key = 'ai_limit';
  select coalesce(sum(calls), 0), coalesce(sum(limited), 0) into used, hit from app.ai_usage where day = d;
  return jsonb_build_object('used', used, 'limit', coalesce(lim, 250), 'limited', hit,
    'reset_at', ((d + 1)::timestamp at time zone 'America/Los_Angeles'));
end $$;
grant execute on function public.get_ai_usage() to authenticated;
