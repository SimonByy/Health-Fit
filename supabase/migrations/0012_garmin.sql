-- 0012: Garmin Connect rechtstreeks (via Claude's Garmin-koppeling, dagelijkse geplande taak).
-- health.ingest_garmin(p) wordt aangeroepen met een service-verbinding (niet via de app-API).

insert into health.metric_catalog(metric, label, category, agg, unit, sort) values
  ('sleep_score', 'Slaapscore', 'herstel', 'avg', 'score', 60),
  ('body_battery_wake', 'Body Battery bij ontwaken', 'herstel', 'avg', 'score', 61),
  ('body_battery_high', 'Body Battery hoogste', 'herstel', 'max', 'score', 62),
  ('body_battery_low', 'Body Battery laagste', 'herstel', 'min', 'score', 63),
  ('stress_avg', 'Gemiddelde stress', 'herstel', 'avg', 'score', 64),
  ('training_readiness', 'Trainingsgereedheid', 'herstel', 'avg', 'score', 65),
  ('intensity_minutes', 'Intensiteitsminuten', 'activiteit', 'sum', 'min', 25),
  ('spo2_avg', 'Zuurstofsaturatie (gem.)', 'hart', 'avg', '%', 36)
on conflict (metric) do nothing;

-- p = {
--   days:     [{date:'2026-10-13', values:{step_count, active_energy, basal_energy_burned, walking_running_distance,
--                resting_heart_rate, heart_rate_variability, flights_climbed, respiratory_rate, sleep_score,
--                body_battery_wake, body_battery_high, body_battery_low, stress_avg, training_readiness,
--                intensity_minutes, spo2_avg, weight_body_mass, body_fat_percentage}}],
--   sleep:    [{date, total_h, deep_h, rem_h, core_h, awake_h, start, end}]   (date = dag van ontwaken)
--   workouts: [{id, name, type, start_local:'2026-10-13 15:32:52', duration_s, distance_km, kcal, avg_hr, max_hr, elevation_up_m}]
-- }
create or replace function health.ingest_garmin(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  dayobj jsonb; d date; kv record; v double precision; v_ts timestamptz;
  n_vals int := 0; n_sleep int := 0; n_wo int := 0; w jsonb; s jsonb; st timestamptz;
begin
  for dayobj in select value from jsonb_array_elements(coalesce(p->'days', '[]')) loop
    d := (dayobj->>'date')::date;
    v_ts := ((d::timestamp + interval '23:59:59.999') at time zone 'Europe/Brussels');
    for kv in select key, value from jsonb_each(coalesce(dayobj->'values', '{}')) loop
      v := health.to_num(kv.value);
      continue when v is null or v < 0 or (v = 0 and kv.key not in ('step_count', 'active_energy', 'intensity_minutes', 'flights_climbed'));
      continue when not exists (select 1 from health.metric_catalog c where c.metric = kv.key);
      insert into health.metric_samples (metric, ts, day, hour, qty, units, source, granularity)
      values (kv.key, v_ts, d, 23, v, (select c.unit from health.metric_catalog c where c.metric = kv.key), 'Garmin', 'day')
      on conflict (metric, ts) do update set qty = excluded.qty, units = excluded.units, source = 'Garmin', voided = false, inserted_at = now();
      n_vals := n_vals + 1;
    end loop;
  end loop;

  for s in select value from jsonb_array_elements(coalesce(p->'sleep', '[]')) loop
    continue when health.to_num(s->'total_h') is null or health.to_num(s->'total_h') <= 0;
    insert into health.sleep_summaries (day, source, total_h, asleep_h, core_h, deep_h, rem_h, awake_h, in_bed_h, sleep_start, sleep_end)
    values ((s->>'date')::date, 'Garmin', health.to_num(s->'total_h'), health.to_num(s->'total_h'), health.to_num(s->'core_h'),
            health.to_num(s->'deep_h'), health.to_num(s->'rem_h'), health.to_num(s->'awake_h'),
            health.to_num(s->'total_h') + coalesce(health.to_num(s->'awake_h'), 0),
            (s->>'start')::timestamptz, (s->>'end')::timestamptz)
    on conflict (day, source) do update set total_h = excluded.total_h, asleep_h = excluded.asleep_h, core_h = excluded.core_h,
      deep_h = excluded.deep_h, rem_h = excluded.rem_h, awake_h = excluded.awake_h, in_bed_h = excluded.in_bed_h,
      sleep_start = excluded.sleep_start, sleep_end = excluded.sleep_end, inserted_at = now();
    n_sleep := n_sleep + 1;
  end loop;

  for w in select value from jsonb_array_elements(coalesce(p->'workouts', '[]')) loop
    st := ((w->>'start_local')::timestamp at time zone 'Europe/Brussels');
    insert into health.workouts (id, name, start_ts, end_ts, day, duration_s, distance_km, active_kcal, avg_hr, max_hr, elevation_up_m, source, raw)
    values ('garmin-' || (w->>'id'), coalesce(nullif(w->>'name', ''), w->>'type', 'Activiteit'), st,
            st + make_interval(secs => coalesce(health.to_num(w->'duration_s'), 0)), (st at time zone 'Europe/Brussels')::date,
            health.to_num(w->'duration_s'), health.to_num(w->'distance_km'), health.to_num(w->'kcal'),
            health.to_num(w->'avg_hr'), health.to_num(w->'max_hr'), health.to_num(w->'elevation_up_m'), 'Garmin', w)
    on conflict (id) do update set name = excluded.name, start_ts = excluded.start_ts, end_ts = excluded.end_ts, day = excluded.day,
      duration_s = excluded.duration_s, distance_km = excluded.distance_km, active_kcal = excluded.active_kcal,
      avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, elevation_up_m = excluded.elevation_up_m, raw = excluded.raw, inserted_at = now();
    n_wo := n_wo + 1;
  end loop;

  insert into app.ingest_log(source, stats) values ('garmin', jsonb_build_object('waarden', n_vals, 'nachten', n_sleep, 'workouts', n_wo,
    'dagen', (select jsonb_agg(x->>'date') from jsonb_array_elements(coalesce(p->'days', '[]')) x)));
  insert into app.sync_state(source, last_run, last_success, last_items, last_error)
  values ('garmin', now(), now(), n_vals + n_sleep + n_wo, null)
  on conflict (source) do update set last_run = now(), last_success = now(), last_items = excluded.last_items, last_error = null;
  return jsonb_build_object('values', n_vals, 'sleep', n_sleep, 'workouts', n_wo);
end $$;
revoke all on function health.ingest_garmin(jsonb) from public, anon, authenticated;

-- Workouts: dezelfde activiteit via Apple Gezondheid (Garmin → Gezondheid → export) niet dubbel tellen
create or replace view ai.workouts as
select w.id, w.day, w.name,
  (w.start_ts at time zone 'Europe/Brussels') as start_local,
  round((w.duration_s / 60)::numeric, 1) as duration_min,
  round(w.distance_km::numeric, 2) as distance_km,
  round(w.active_kcal::numeric, 0) as active_kcal,
  round(w.avg_hr::numeric, 0) as avg_hr,
  round(w.max_hr::numeric, 0) as max_hr,
  case when w.distance_km > 0 and w.duration_s > 0
       then round((w.duration_s / 60 / w.distance_km)::numeric, 2) end as pace_min_per_km,
  round(w.elevation_up_m::numeric, 0) as elevation_up_m,
  w.source,
  exists (
    select 1 from health.hevy_workouts h
    where h.deleted_at is null and h.start_ts < w.start_ts + interval '15 minutes'
      and coalesce(h.end_ts, h.start_ts) > w.start_ts - interval '15 minutes'
      and (w.name ilike '%strength%' or w.name ilike '%kracht%' or w.name ilike '%functional%')
  ) as duplicate_of_hevy
from health.workouts w
where w.source = 'Garmin'
   or not exists (select 1 from health.workouts g where g.source = 'Garmin' and g.id <> w.id
                  and abs(extract(epoch from g.start_ts - w.start_ts)) < 300);

-- Herstel per dag (Garmin) voor app en AI
create or replace view ai.recovery_daily as
select day,
  max(value) filter (where metric = 'sleep_score') as sleep_score,
  max(value) filter (where metric = 'body_battery_wake') as body_battery_wake,
  max(value) filter (where metric = 'body_battery_high') as body_battery_high,
  max(value) filter (where metric = 'body_battery_low') as body_battery_low,
  max(value) filter (where metric = 'stress_avg') as stress_avg,
  max(value) filter (where metric = 'training_readiness') as training_readiness,
  max(value) filter (where metric = 'intensity_minutes') as intensity_minutes,
  max(value) filter (where metric = 'spo2_avg') as spo2_avg,
  max(value) filter (where metric = 'resting_heart_rate') as resting_hr,
  max(value) filter (where metric = 'heart_rate_variability') as hrv_ms
from ai.daily_metrics
where metric in ('sleep_score', 'body_battery_wake', 'body_battery_high', 'body_battery_low', 'stress_avg',
                 'training_readiness', 'intensity_minutes', 'spo2_avg', 'resting_heart_rate', 'heart_rate_variability')
group by day;
comment on view ai.recovery_daily is 'Herstel per dag uit Garmin: slaapscore (0-100), Body Battery bij ontwaken/hoogste/laagste (0-100), gemiddelde stress (0-100, lager = rustiger), trainingsgereedheid (0-100), intensiteitsminuten, SpO2, rusthartslag en nachtelijke HRV (ms).';
grant select on ai.recovery_daily, ai.workouts to ai_reader;

create or replace function public.get_recovery(p_day date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return jsonb_build_object(
    'today', (select to_jsonb(r) from ai.recovery_daily r where r.day = p_day),
    'avg7', (select jsonb_build_object('sleep_score', round(avg(sleep_score)), 'body_battery_wake', round(avg(body_battery_wake)),
                'stress_avg', round(avg(stress_avg)), 'training_readiness', round(avg(training_readiness)),
                'intensity_minutes_week', round(sum(intensity_minutes)))
             from ai.recovery_daily r where r.day between p_day - 7 and p_day - 1),
    'garmin_sync', (select last_success from app.sync_state where source = 'garmin'));
end $$;
revoke all on function public.get_recovery(date) from public, anon;
grant execute on function public.get_recovery(date) to authenticated;

-- Ruwe Garmin-uitvoer rechtstreeks verwerken (zo hoeft de dagelijkse taak niets om te rekenen).
-- p = {
--   summaries:  [ get_user_summary-objecten (minstens calendarDate + velden hieronder) ],
--   sleep:      [ nachten uit get_sleep_summary_range (date, sleep_seconds, deep/light/rem/awake_sleep_seconds,
--                 sleep_start, sleep_end in ms, sleep_score, avg_overnight_hrv) ],
--   activities: [ activiteiten uit get_activities_by_date (id, name, type, start_time, duration_seconds,
--                 distance_meters, calories, avg_hr_bpm, max_hr_bpm, elevation_gain_meters) ],
--   readiness:  [ {date, score} ]  (optioneel)
-- }
create or replace function health.ingest_garmin_raw(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  days jsonb := '{}';   -- {date: {metric: value}}
  x jsonb; d text; vals jsonb; sleep jsonb := '[]'; wo jsonb := '[]';
begin
  for x in select value from jsonb_array_elements(coalesce(p->'summaries', '[]')) loop
    d := left(x->>'calendarDate', 10);
    continue when d is null;
    vals := jsonb_strip_nulls(jsonb_build_object(
      'step_count', x->'totalSteps',
      'active_energy', x->'activeKilocalories',
      'basal_energy_burned', x->'bmrKilocalories',
      'walking_running_distance', case when x->>'totalDistanceMeters' is not null then to_jsonb(round(((x->>'totalDistanceMeters')::numeric / 1000), 3)) end,
      'resting_heart_rate', x->'restingHeartRate',
      'flights_climbed', case when x->>'floorsAscended' is not null then to_jsonb(round((x->>'floorsAscended')::numeric, 1)) end,
      'respiratory_rate', x->'avgWakingRespirationValue',
      'body_battery_wake', x->'bodyBatteryAtWakeTime',
      'body_battery_high', x->'bodyBatteryHighestValue',
      'body_battery_low', x->'bodyBatteryLowestValue',
      'stress_avg', case when (x->>'averageStressLevel')::numeric >= 0 then x->'averageStressLevel' end,
      'intensity_minutes', case when x ? 'moderateIntensityMinutes' or x ? 'vigorousIntensityMinutes'
        then to_jsonb(coalesce((x->>'moderateIntensityMinutes')::numeric, 0) + 2 * coalesce((x->>'vigorousIntensityMinutes')::numeric, 0)) end,
      'spo2_avg', x->'averageSpo2'));
    days := jsonb_set(days, array[d], coalesce(days->d, '{}') || vals);
  end loop;

  for x in select value from jsonb_array_elements(coalesce(p->'sleep', '[]')) loop
    d := left(x->>'date', 10);
    continue when d is null or coalesce((x->>'sleep_seconds')::numeric, 0) <= 0;
    days := jsonb_set(days, array[d], coalesce(days->d, '{}') || jsonb_strip_nulls(jsonb_build_object(
      'sleep_score', x->'sleep_score', 'heart_rate_variability', x->'avg_overnight_hrv')));
    sleep := sleep || jsonb_build_array(jsonb_build_object(
      'date', d,
      'total_h', round((x->>'sleep_seconds')::numeric / 3600, 3),
      'deep_h', round(coalesce((x->>'deep_sleep_seconds')::numeric, 0) / 3600, 3),
      'rem_h', round(coalesce((x->>'rem_sleep_seconds')::numeric, 0) / 3600, 3),
      'core_h', round(coalesce((x->>'light_sleep_seconds')::numeric, 0) / 3600, 3),
      'awake_h', round(coalesce((x->>'awake_seconds')::numeric, 0) / 3600, 3),
      'start', case when x->>'sleep_start' is not null then to_timestamp((x->>'sleep_start')::double precision / 1000) end,
      'end', case when x->>'sleep_end' is not null then to_timestamp((x->>'sleep_end')::double precision / 1000) end));
  end loop;

  for x in select value from jsonb_array_elements(coalesce(p->'readiness', '[]')) loop
    d := left(x->>'date', 10);
    continue when d is null or x->>'score' is null;
    days := jsonb_set(days, array[d], coalesce(days->d, '{}') || jsonb_build_object('training_readiness', x->'score'));
  end loop;

  for x in select value from jsonb_array_elements(coalesce(p->'activities', '[]')) loop
    continue when x->>'id' is null or x->>'start_time' is null;
    wo := wo || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'id', x->>'id', 'name', x->>'name', 'type', x->>'type', 'start_local', x->>'start_time',
      'duration_s', x->'duration_seconds',
      'distance_km', case when x->>'distance_meters' is not null then to_jsonb(round((x->>'distance_meters')::numeric / 1000, 3)) end,
      'kcal', x->'calories', 'avg_hr', x->'avg_hr_bpm', 'max_hr', x->'max_hr_bpm', 'elevation_up_m', x->'elevation_gain_meters')));
  end loop;

  return health.ingest_garmin(jsonb_build_object(
    'days', (select coalesce(jsonb_agg(jsonb_build_object('date', k, 'values', v) order by k), '[]') from jsonb_each(days) e(k, v)),
    'sleep', sleep, 'workouts', wo));
end $$;
revoke all on function health.ingest_garmin_raw(jsonb) from public, anon, authenticated;
