-- =====================================================================
-- Analyse-views (schema ai) + read-only AI-rol
-- =====================================================================

-- Dagwaarde per metric (lokale dag), met juiste aggregatie
create or replace view ai.daily_metrics as
select s.day,
  s.metric,
  coalesce(c.label, s.metric) as label,
  coalesce(c.category, 'overig') as category,
  case coalesce(c.agg, 'avg')
    when 'sum' then sum(s.qty)
    when 'max' then max(coalesce(s.max, s.qty))
    when 'min' then min(coalesce(s.min, s.qty))
    else avg(coalesce(s.avg, s.qty))
  end as value,
  min(coalesce(s.min, s.qty)) as min_value,
  max(coalesce(s.max, s.qty)) as max_value,
  max(s.units) as unit
from health.metric_samples s
left join health.metric_catalog c on c.metric = s.metric
group by s.day, s.metric, c.label, c.category, c.agg;
comment on view ai.daily_metrics is 'Eén rij per lokale dag per Apple Health-metric. value = dagtotaal (sum-metrics zoals stappen, kcal, voeding) of daggemiddelde (hartslag, HRV, gewicht). Kolom metric = technische naam (bv. step_count, protein), label = Nederlandse naam.';

-- Slaap per nacht (dag = datum van ontwaken)
create or replace view ai.sleep as
with summ as (
  select distinct on (day) day, total_h, deep_h, rem_h, core_h, awake_h, in_bed_h, sleep_start, sleep_end, source
  from health.sleep_summaries
  order by day, total_h desc nulls last
),
seg as (
  select night as day,
    sum(extract(epoch from end_ts - start_ts)) filter (where lower(stage) not in ('awake','in bed','inbed')) / 3600 as total_h,
    sum(extract(epoch from end_ts - start_ts)) filter (where lower(stage) = 'deep') / 3600 as deep_h,
    sum(extract(epoch from end_ts - start_ts)) filter (where lower(stage) = 'rem') / 3600 as rem_h,
    sum(extract(epoch from end_ts - start_ts)) filter (where lower(stage) = 'core') / 3600 as core_h,
    sum(extract(epoch from end_ts - start_ts)) filter (where lower(stage) = 'awake') / 3600 as awake_h,
    sum(extract(epoch from end_ts - start_ts)) filter (where lower(stage) in ('in bed','inbed')) / 3600 as in_bed_h,
    min(start_ts) as sleep_start, max(end_ts) as sleep_end,
    string_agg(distinct source, '|') as source
  from health.sleep_segments
  group by night
)
select coalesce(summ.day, seg.day) as day,
  round(coalesce(summ.total_h, seg.total_h)::numeric, 2) as total_h,
  round(coalesce(summ.deep_h, seg.deep_h)::numeric, 2) as deep_h,
  round(coalesce(summ.rem_h, seg.rem_h)::numeric, 2) as rem_h,
  round(coalesce(summ.core_h, seg.core_h)::numeric, 2) as core_h,
  round(coalesce(summ.awake_h, seg.awake_h)::numeric, 2) as awake_h,
  round(coalesce(summ.in_bed_h, seg.in_bed_h)::numeric, 2) as in_bed_h,
  (coalesce(summ.sleep_start, seg.sleep_start) at time zone 'Europe/Brussels') as sleep_start_local,
  (coalesce(summ.sleep_end, seg.sleep_end) at time zone 'Europe/Brussels') as sleep_end_local,
  coalesce(summ.source, seg.source) as source
from summ full join seg on seg.day = summ.day;
comment on view ai.sleep is 'Slaap per nacht; day = datum waarop je wakker werd. Uren per slaapfase.';

-- Krachttraining (Hevy) per set, met geschatte 1RM (Epley)
create or replace view ai.strength_sets as
select s.workout_id, w.day, w.title as workout_title,
  s.exercise_index, s.exercise_title as exercise,
  t.primary_muscle_group as primary_muscle, t.secondary_muscle_groups as secondary_muscles,
  s.set_index, s.set_type, s.weight_kg, s.reps, s.rpe, s.distance_m, s.duration_s,
  case when s.weight_kg > 0 and s.reps between 1 and 15
       then round((s.weight_kg * (1 + s.reps / 30.0))::numeric, 1) end as est_1rm_kg,
  coalesce(s.weight_kg, 0) * coalesce(s.reps, 0) as volume_kg
from health.hevy_sets s
join health.hevy_workouts w on w.id = s.workout_id and s.synced_at = w.synced_at and w.deleted_at is null
left join health.hevy_exercise_templates t on t.id = s.exercise_template_id;
comment on view ai.strength_sets is 'Elke set uit Hevy. set_type: normal/warmup/dropset/failure. volume_kg = gewicht x reps. est_1rm_kg = geschatte 1RM (Epley).';

create or replace view ai.strength_workouts as
select w.id, w.day, w.title,
  (w.start_ts at time zone 'Europe/Brussels') as start_local,
  round((extract(epoch from w.end_ts - w.start_ts) / 60)::numeric, 0) as duration_min,
  count(distinct s.exercise_index) as exercises,
  count(*) filter (where s.set_type <> 'warmup') as working_sets,
  round(sum(coalesce(s.weight_kg,0) * coalesce(s.reps,0)) filter (where s.set_type <> 'warmup')::numeric, 0) as volume_kg,
  w.description
from health.hevy_workouts w
left join health.hevy_sets s on s.workout_id = w.id and s.synced_at = w.synced_at
where w.deleted_at is null
group by w.id;
comment on view ai.strength_workouts is 'Eén rij per Hevy-training: duur, aantal oefeningen, werksets en volume (excl. opwarmsets).';

-- Workouts uit Apple Health (o.a. Garmin), met markering voor dubbele Hevy-trainingen
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
from health.workouts w;
comment on view ai.workouts is 'Workouts uit Apple Health (o.a. Garmin-runs, fietsen). duplicate_of_hevy = true als het dezelfde krachttraining is die ook in Hevy staat (dan niet dubbel tellen).';

-- Voeding per maaltijdmoment (afgeleid uit het uur van loggen)
create or replace function health.meal_slot(p_hour int)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select e->>'name' from app.settings s,
       jsonb_array_elements(s.value) with ordinality as x(e, i)
     where s.key = 'meal_slots' and p_hour < (e->>'until')::int
     order by i limit 1),
    'Laat');
$$;

create or replace view ai.nutrition_by_meal as
select s.day,
  case when s.hour < 4 then 'Laat' else health.meal_slot(s.hour) end as meal,
  min(s.hour) as first_hour,
  round(sum(s.qty) filter (where s.metric = 'dietary_energy')::numeric, 0) as kcal,
  round(sum(s.qty) filter (where s.metric = 'protein')::numeric, 1) as protein_g,
  round(sum(s.qty) filter (where s.metric = 'carbohydrates')::numeric, 1) as carbs_g,
  round(sum(s.qty) filter (where s.metric = 'total_fat')::numeric, 1) as fat_g,
  round(sum(s.qty) filter (where s.metric = 'fiber')::numeric, 1) as fiber_g,
  round(sum(s.qty) filter (where s.metric = 'dietary_sugar')::numeric, 1) as sugar_g
from health.metric_samples s
join health.metric_catalog c on c.metric = s.metric and c.category = 'voeding'
group by s.day, 2;
comment on view ai.nutrition_by_meal is 'Voeding per dag per maaltijdmoment (Ontbijt/Lunch/Snack/Avondeten/Laat), afgeleid uit het uur waarop gelogd werd.';

-- Het centrale dagoverzicht
create or replace view ai.daily_summary as
with m as (
  select day,
    max(value) filter (where metric = 'step_count') as steps,
    max(value) filter (where metric = 'active_energy') as active_kcal,
    max(value) filter (where metric = 'basal_energy_burned') as resting_kcal,
    max(value) filter (where metric = 'walking_running_distance') as walk_run_km,
    max(value) filter (where metric = 'apple_exercise_time') as exercise_min,
    max(value) filter (where metric = 'flights_climbed') as flights,
    max(value) filter (where metric = 'resting_heart_rate') as resting_hr,
    max(value) filter (where metric = 'heart_rate_variability') as hrv_ms,
    max(value) filter (where metric = 'vo2_max') as vo2max,
    max(value) filter (where metric = 'respiratory_rate') as resp_rate,
    max(value) filter (where metric = 'weight_body_mass') as weight_kg,
    max(value) filter (where metric = 'body_fat_percentage') as body_fat_pct,
    max(value) filter (where metric = 'dietary_energy') as kcal_in,
    max(value) filter (where metric = 'protein') as protein_g,
    max(value) filter (where metric = 'carbohydrates') as carbs_g,
    max(value) filter (where metric = 'total_fat') as fat_g,
    max(value) filter (where metric = 'fiber') as fiber_g,
    max(value) filter (where metric = 'dietary_sugar') as sugar_g,
    max(value) filter (where metric = 'sodium') as sodium_mg,
    max(value) filter (where metric = 'dietary_water') as water_ml
  from ai.daily_metrics group by day
),
st as (
  select day, count(*) as strength_sessions, sum(volume_kg) as strength_volume_kg,
         sum(working_sets) as strength_sets, sum(duration_min) as strength_min
  from ai.strength_workouts group by day
),
wk as (
  select day, count(*) as cardio_sessions, sum(duration_min) as cardio_min,
         sum(distance_km) as cardio_km, sum(active_kcal) as cardio_kcal
  from ai.workouts where not duplicate_of_hevy group by day
),
days as (
  select day from m union select day from ai.sleep union select day from st union select day from wk
)
select d.day,
  extract(isodow from d.day)::int as weekday,
  round(m.steps::numeric, 0) as steps,
  round(m.active_kcal::numeric, 0) as active_kcal,
  round(m.resting_kcal::numeric, 0) as resting_kcal,
  round((coalesce(m.active_kcal,0) + coalesce(m.resting_kcal,0))::numeric, 0) as total_kcal_out,
  round(m.walk_run_km::numeric, 2) as walk_run_km,
  round(m.exercise_min::numeric, 0) as exercise_min,
  round(m.flights::numeric, 0) as flights,
  round(m.resting_hr::numeric, 0) as resting_hr,
  round(m.hrv_ms::numeric, 0) as hrv_ms,
  round(m.vo2max::numeric, 1) as vo2max,
  round(m.resp_rate::numeric, 1) as resp_rate,
  round(m.weight_kg::numeric, 1) as weight_kg,
  round(m.body_fat_pct::numeric, 1) as body_fat_pct,
  sl.total_h as sleep_h, sl.deep_h as deep_sleep_h, sl.rem_h as rem_sleep_h,
  round(m.kcal_in::numeric, 0) as kcal_in,
  round(m.protein_g::numeric, 0) as protein_g,
  round(m.carbs_g::numeric, 0) as carbs_g,
  round(m.fat_g::numeric, 0) as fat_g,
  round(m.fiber_g::numeric, 0) as fiber_g,
  round(m.sugar_g::numeric, 0) as sugar_g,
  round(m.sodium_mg::numeric, 0) as sodium_mg,
  round(m.water_ml::numeric, 0) as water_ml,
  coalesce(st.strength_sessions, 0) as strength_sessions,
  st.strength_sets, st.strength_volume_kg, st.strength_min,
  coalesce(wk.cardio_sessions, 0) as cardio_sessions,
  wk.cardio_min, wk.cardio_km, wk.cardio_kcal
from days d
left join m on m.day = d.day
left join ai.sleep sl on sl.day = d.day
left join st on st.day = d.day
left join wk on wk.day = d.day;
comment on view ai.daily_summary is 'HOOFDVIEW: één rij per dag met activiteit, hart, lichaam, slaap (nacht die eindigde op die dag), voeding-totalen, krachttraining (Hevy) en cardio. weekday: 1=maandag..7=zondag. Lege waarde = geen data.';

-- ---------------------------------------------------------------------
-- Read-only AI-rol + query-functie
-- ---------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'ai_reader') then
    create role ai_reader nologin noinherit;
  end if;
end $$;

grant ai_reader to postgres;
grant usage on schema ai to ai_reader;
grant select on all tables in schema ai to ai_reader;
alter default privileges in schema ai grant select on tables to ai_reader;
-- views roepen helperfuncties aan; die draaien als view-eigenaar, maar
-- meal_slot wordt in de view-expressie geëvalueerd met de rechten van
-- de view-eigenaar, dus geen extra rechten nodig voor ai_reader.

grant create on schema public to ai_reader;

create or replace function public.ai_run_query(q text)
returns jsonb
language plpgsql
security definer
set search_path = ai, pg_catalog
set statement_timeout = '8s'
as $$
declare
  r jsonb;
  clean text := btrim(q);
begin
  clean := regexp_replace(clean, ';\s*$', '');
  if position(';' in clean) > 0 then
    raise exception 'Slechts één statement toegestaan';
  end if;
  if lower(clean) !~ '^\s*(select|with)\s' then
    raise exception 'Alleen SELECT-queries zijn toegestaan';
  end if;
  -- extra vangnet: enkel de ai-views, geen systeem- of geheime objecten
  if lower(clean) ~ '(\m(public|app|health|vault|auth|storage|extensions|cron|net|pg_catalog|information_schema)\s*\.|"|\minternal_|\mset_config|\mcurrent_setting|\mpg_read|\mpg_ls|\mlo_|\mdblink|\mpg_sleep)' then
    raise exception 'Query verwijst naar niet-toegelaten objecten; gebruik enkel de views in schema ai';
  end if;
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) as sub limit 300) as t', clean)
    into r;
  return r;
end $$;

alter function public.ai_run_query(text) owner to ai_reader;
revoke create on schema public from ai_reader;
revoke all on function public.ai_run_query(text) from public, anon, authenticated;
grant execute on function public.ai_run_query(text) to service_role;

-- Schema-beschrijving voor de AI (kolommen + uitleg)
create or replace function public.ai_schema_doc()
returns text language sql stable security definer set search_path = '' as $$
  select string_agg(
    format(E'ai.%s — %s\n  kolommen: %s', c.relname,
      coalesce(obj_description(c.oid, 'pg_class'), ''),
      (select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' order by a.attnum)
         from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped)),
    E'\n\n' order by c.relname)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'ai' and c.relkind in ('v','r','m');
$$;
revoke all on function public.ai_schema_doc() from public, anon, authenticated;
grant execute on function public.ai_schema_doc() to service_role;
