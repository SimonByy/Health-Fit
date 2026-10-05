-- =====================================================================
-- Metric-catalogus (labels NL) + ingest-logica voor Apple Health
-- (formaat van de iOS-app "Health Auto Export", REST API-automatisatie)
-- en Hevy.
-- =====================================================================

insert into health.metric_catalog(metric, label, category, agg, unit, sort) values
  -- activiteit
  ('step_count','Stappen','activiteit','sum','count',10),
  ('active_energy','Actieve energie','activiteit','sum','kcal',11),
  ('basal_energy_burned','Rustenergie','activiteit','sum','kcal',12),
  ('walking_running_distance','Afstand wandelen/lopen','activiteit','sum','km',13),
  ('cycling_distance','Afstand fietsen','activiteit','sum','km',14),
  ('swimming_distance','Afstand zwemmen','activiteit','sum','km',15),
  ('apple_exercise_time','Trainingsminuten','activiteit','sum','min',16),
  ('apple_stand_time','Staminuten','activiteit','sum','min',17),
  ('apple_stand_hour','Sta-uren','activiteit','sum','count',18),
  ('flights_climbed','Trappen','activiteit','sum','count',19),
  ('physical_effort','Fysieke inspanning','activiteit','avg','kcal/hr·kg',20),
  ('time_in_daylight','Tijd in daglicht','activiteit','sum','min',21),
  ('walking_speed','Wandelsnelheid','activiteit','avg','km/hr',22),
  ('running_speed','Loopsnelheid','activiteit','avg','km/hr',23),
  ('running_power','Loopvermogen','activiteit','avg','W',24),
  -- hart
  ('resting_heart_rate','Rusthartslag','hart','avg','bpm',30),
  ('heart_rate','Hartslag','hart','avg','bpm',31),
  ('heart_rate_variability','HRV','hart','avg','ms',32),
  ('walking_heart_rate_average','Wandelhartslag','hart','avg','bpm',33),
  ('vo2_max','VO2 max','hart','avg','ml/(kg·min)',34),
  ('respiratory_rate','Ademhalingsfrequentie','hart','avg','count/min',35),
  ('blood_oxygen_saturation','Zuurstofsaturatie','hart','avg','%',36),
  ('cardio_recovery','Hartslagherstel','hart','avg','bpm',37),
  -- lichaam
  ('weight_body_mass','Gewicht','lichaam','avg','kg',40),
  ('body_fat_percentage','Vetpercentage','lichaam','avg','%',41),
  ('lean_body_mass','Vetvrije massa','lichaam','avg','kg',42),
  ('body_mass_index','BMI','lichaam','avg','count',43),
  ('waist_circumference','Taille','lichaam','avg','cm',44),
  ('mindful_minutes','Mindful minuten','overig','sum','min',90),
  -- voeding (macro's)
  ('dietary_energy','Calorieën','voeding','sum','kcal',50),
  ('protein','Eiwit','voeding','sum','g',51),
  ('carbohydrates','Koolhydraten','voeding','sum','g',52),
  ('total_fat','Vet','voeding','sum','g',53),
  ('saturated_fat','Verzadigd vet','voeding','sum','g',54),
  ('monounsaturated_fat','Enkelv. onverz. vet','voeding','sum','g',55),
  ('polyunsaturated_fat','Meerv. onverz. vet','voeding','sum','g',56),
  ('fiber','Vezels','voeding','sum','g',57),
  ('dietary_sugar','Suiker','voeding','sum','g',58),
  ('cholesterol','Cholesterol','voeding','sum','mg',59),
  ('dietary_water','Water','voeding','sum','mL',60),
  ('dietary_caffeine','Cafeïne','voeding','sum','mg',61),
  -- voeding (micro's)
  ('sodium','Natrium','voeding','sum','mg',70),
  ('potassium','Kalium','voeding','sum','mg',71),
  ('calcium','Calcium','voeding','sum','mg',72),
  ('iron','IJzer','voeding','sum','mg',73),
  ('magnesium','Magnesium','voeding','sum','mg',74),
  ('zinc','Zink','voeding','sum','mg',75),
  ('phosphorus','Fosfor','voeding','sum','mg',76),
  ('selenium','Selenium','voeding','sum','mcg',77),
  ('copper','Koper','voeding','sum','mg',78),
  ('manganese','Mangaan','voeding','sum','mg',79),
  ('iodine','Jodium','voeding','sum','mcg',80),
  ('chloride','Chloride','voeding','sum','mg',81),
  ('chromium','Chroom','voeding','sum','mcg',82),
  ('molybdenum','Molybdeen','voeding','sum','mcg',83),
  ('vitamin_a','Vitamine A','voeding','sum','mcg',84),
  ('thiamin','Vitamine B1 (thiamine)','voeding','sum','mg',85),
  ('riboflavin','Vitamine B2 (riboflavine)','voeding','sum','mg',86),
  ('niacin','Vitamine B3 (niacine)','voeding','sum','mg',87),
  ('pantothenic_acid','Vitamine B5','voeding','sum','mg',88),
  ('vitamin_b6','Vitamine B6','voeding','sum','mg',89),
  ('biotin','Biotine','voeding','sum','mcg',90),
  ('folate','Foliumzuur','voeding','sum','mcg',91),
  ('vitamin_b12','Vitamine B12','voeding','sum','mcg',92),
  ('vitamin_c','Vitamine C','voeding','sum','mg',93),
  ('vitamin_d','Vitamine D','voeding','sum','mcg',94),
  ('vitamin_e','Vitamine E','voeding','sum','mg',95),
  ('vitamin_k','Vitamine K','voeding','sum','mcg',96)
on conflict (metric) do update set label = excluded.label, category = excluded.category,
  agg = excluded.agg, unit = excluded.unit, sort = excluded.sort;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------
create or replace function health.parse_ts(t text)
returns timestamptz language sql stable set search_path = '' as $$
  select case when t is null or btrim(t) = '' then null else t::timestamptz end;
$$;

create or replace function health.local_day(t timestamptz)
returns date language sql stable set search_path = '' as $$
  select (t at time zone 'Europe/Brussels')::date;
$$;

-- Zet waarde om naar standaardeenheid. Geeft (factor, eenheid) terug.
create or replace function health.unit_norm(p_units text, out factor double precision, out units text)
language sql immutable set search_path = '' as $$
  select
    case p_units
      when 'kJ' then 1/4.184
      when 'mi' then 1.609344
      when 'm' then 0.001
      when 'yd' then 0.0009144
      when 'ft' then 0.3048
      when 'lb' then 0.45359237
      when 'L' then 1000
      when 'fl_oz_us' then 29.5735
      when 'ms' then 1
      else 1 end,
    case p_units
      when 'kJ' then 'kcal'
      when 'mi' then 'km'
      when 'm' then 'km'
      when 'yd' then 'km'
      when 'ft' then 'm'
      when 'lb' then 'kg'
      when 'L' then 'mL'
      when 'fl_oz_us' then 'mL'
      else p_units end;
$$;

-- Hulpfunctie: {qty, units}-object -> genormaliseerd getal
create or replace function health.qty_norm(o jsonb)
returns double precision language sql immutable set search_path = '' as $$
  select case
    when o is null or jsonb_typeof(o) <> 'object' or o->>'qty' is null then null
    else (o->>'qty')::double precision * (health.unit_norm(o->>'units')).factor
  end;
$$;

-- ---------------------------------------------------------------------
-- Ingest Apple Health (Health Auto Export JSON, v1 en v2)
-- ---------------------------------------------------------------------
create or replace function public.ingest_health_export(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  d jsonb := coalesce(p->'data', p);
  m jsonb;
  w jsonb;
  mname text;
  u record;
  agg_kind text;
  cnt int;
  n_metrics int := 0;
  n_samples int := 0;
  n_sleep int := 0;
  n_workouts int := 0;
  sf double precision;
begin
  for m in select value from jsonb_array_elements(coalesce(d->'metrics', '[]'::jsonb)) loop
    mname := m->>'name';
    continue when mname is null;
    n_metrics := n_metrics + 1;

    -- ---------- slaap ----------
    if mname = 'sleep_analysis' then
      sf := case when m->>'units' in ('min') then 1.0/60 else 1 end;

      -- samengevatte nachten (aanbevolen)
      insert into health.sleep_summaries as s
        (day, source, total_h, asleep_h, core_h, deep_h, rem_h, awake_h, in_bed_h, sleep_start, sleep_end)
      select distinct on (dday, src)
        dday, src,
        coalesce((e->>'totalSleep')::float8,
                 coalesce((e->>'asleep')::float8,0) + coalesce((e->>'core')::float8,0)
                 + coalesce((e->>'deep')::float8,0) + coalesce((e->>'rem')::float8,0)) * sf,
        (e->>'asleep')::float8 * sf, (e->>'core')::float8 * sf, (e->>'deep')::float8 * sf,
        (e->>'rem')::float8 * sf, (e->>'awake')::float8 * sf, (e->>'inBed')::float8 * sf,
        health.parse_ts(e->>'sleepStart'), health.parse_ts(e->>'sleepEnd')
      from (
        select e,
          coalesce(health.local_day(health.parse_ts(e->>'sleepEnd')), health.local_day(health.parse_ts(e->>'date'))) as dday,
          coalesce(e->>'source', '') as src
        from jsonb_array_elements(coalesce(m->'data','[]'::jsonb)) e
        where e ? 'totalSleep' or e ? 'asleep' or e ? 'deep' or e ? 'core'
      ) x
      where dday is not null
      order by dday, src
      on conflict (day, source) do update set
        total_h = excluded.total_h, asleep_h = excluded.asleep_h, core_h = excluded.core_h,
        deep_h = excluded.deep_h, rem_h = excluded.rem_h, awake_h = excluded.awake_h,
        in_bed_h = excluded.in_bed_h, sleep_start = excluded.sleep_start,
        sleep_end = excluded.sleep_end, inserted_at = now();
      get diagnostics cnt = row_count; n_sleep := n_sleep + cnt;

      -- losse slaapsegmenten (als de export niet samenvat)
      insert into health.sleep_segments (start_ts, end_ts, stage, night, source)
      select distinct on (st, stg) st, en, stg,
        ((en at time zone 'Europe/Brussels') + interval '12 hours')::date, e->>'source'
      from (
        select e, health.parse_ts(e->>'startDate') st, health.parse_ts(e->>'endDate') en, e->>'value' stg
        from jsonb_array_elements(coalesce(m->'data','[]'::jsonb)) e
        where e ? 'startDate' and e ? 'endDate' and e ? 'value'
      ) x
      where st is not null and en is not null
      order by st, stg
      on conflict (start_ts, stage) do update set end_ts = excluded.end_ts, night = excluded.night, source = excluded.source;
      get diagnostics cnt = row_count; n_sleep := n_sleep + cnt;
      continue;
    end if;

    -- ---------- gewone metrics ----------
    select * into u from health.unit_norm(m->>'units');
    select coalesce(c.agg, 'avg') into agg_kind from health.metric_catalog c where c.metric = mname;
    agg_kind := coalesce(agg_kind, 'avg');

    insert into health.metric_samples as s (metric, ts, day, hour, qty, min, avg, max, units, source)
    select mname, x.ts, health.local_day(x.ts), extract(hour from x.ts at time zone 'Europe/Brussels')::smallint,
      case when agg_kind = 'sum' then sum(x.q) else avg(x.q) end,
      min(x.mn), avg(x.av), max(x.mx), u.units, string_agg(distinct x.src, '|')
    from (
      select health.parse_ts(e->>'date') ts,
        (e->>'qty')::float8 * u.factor q,
        (e->>'Min')::float8 * u.factor mn,
        (e->>'Avg')::float8 * u.factor av,
        (e->>'Max')::float8 * u.factor mx,
        e->>'source' src
      from jsonb_array_elements(coalesce(m->'data','[]'::jsonb)) e
      where e ? 'date'
    ) x
    where x.ts is not null
    group by x.ts
    on conflict (metric, ts) do update set
      qty = excluded.qty, min = excluded.min, avg = excluded.avg, max = excluded.max,
      units = excluded.units, source = excluded.source, day = excluded.day, hour = excluded.hour,
      inserted_at = now();
    get diagnostics cnt = row_count; n_samples := n_samples + cnt;
  end loop;

  -- ---------- workouts ----------
  for w in select value from jsonb_array_elements(coalesce(d->'workouts', '[]'::jsonb)) loop
    continue when health.parse_ts(w->>'start') is null;
    insert into health.workouts as t
      (id, name, start_ts, end_ts, day, duration_s, distance_km, active_kcal, avg_hr, max_hr, elevation_up_m, source, raw)
    values (
      coalesce(w->>'id', md5(coalesce(w->>'name','') || (w->>'start'))),
      w->>'name',
      health.parse_ts(w->>'start'),
      health.parse_ts(w->>'end'),
      health.local_day(health.parse_ts(w->>'start')),
      coalesce((w->>'duration')::float8,
               extract(epoch from health.parse_ts(w->>'end') - health.parse_ts(w->>'start'))),
      health.qty_norm(w->'distance'),
      coalesce(health.qty_norm(w->'activeEnergyBurned'), health.qty_norm(w->'activeEnergy')),
      coalesce(health.qty_norm(w->'heartRate'->'avg'), health.qty_norm(w->'avgHeartRate')),
      coalesce(health.qty_norm(w->'heartRate'->'max'), health.qty_norm(w->'maxHeartRate')),
      case when w->'elevationUp'->>'units' = 'ft' then (w->'elevationUp'->>'qty')::float8 * 0.3048
           else (w->'elevationUp'->>'qty')::float8 end,
      w->>'source',
      (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(w) as j(k, v)
        where jsonb_typeof(v) <> 'array')
    )
    on conflict (id) do update set
      name = excluded.name, start_ts = excluded.start_ts, end_ts = excluded.end_ts, day = excluded.day,
      duration_s = excluded.duration_s, distance_km = excluded.distance_km,
      active_kcal = excluded.active_kcal, avg_hr = excluded.avg_hr, max_hr = excluded.max_hr,
      elevation_up_m = excluded.elevation_up_m, source = excluded.source, raw = excluded.raw,
      inserted_at = now();
    n_workouts := n_workouts + 1;
  end loop;

  insert into app.ingest_log(source, stats) values ('apple_health',
    jsonb_build_object('metrics', n_metrics, 'samples', n_samples, 'sleep', n_sleep, 'workouts', n_workouts));

  insert into app.sync_state(source, last_run, last_success, last_items, last_error)
  values ('apple_health', now(), now(), n_samples + n_sleep + n_workouts, null)
  on conflict (source) do update set last_run = now(), last_success = now(),
    last_items = excluded.last_items, last_error = null;

  return jsonb_build_object('metrics', n_metrics, 'samples', n_samples, 'sleep', n_sleep, 'workouts', n_workouts);
end $$;

-- ---------------------------------------------------------------------
-- Hevy
-- ---------------------------------------------------------------------
alter table health.hevy_workouts add column if not exists synced_at timestamptz not null default now();
alter table health.hevy_workouts add column if not exists deleted_at timestamptz;
alter table health.hevy_sets add column if not exists synced_at timestamptz not null default now();

-- Upsert van Hevy-workouts. Geen DELETE: sets krijgen dezelfde synced_at als
-- hun workout; oudere versies (na bewerken in Hevy) worden in de views genegeerd.
create or replace function public.hevy_upsert_workouts(p jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare cnt int; v_now timestamptz := clock_timestamp();
begin
  insert into health.hevy_workouts as h (id, title, description, start_ts, end_ts, day, updated_at, created_at, raw, synced_at, deleted_at)
  select w->>'id', w->>'title', w->>'description',
    health.parse_ts(w->>'start_time'), health.parse_ts(w->>'end_time'),
    health.local_day(health.parse_ts(w->>'start_time')),
    health.parse_ts(w->>'updated_at'), health.parse_ts(w->>'created_at'),
    w - 'exercises', v_now, null
  from jsonb_array_elements(p) w
  where w->>'id' is not null
  on conflict (id) do update set title = excluded.title, description = excluded.description,
    start_ts = excluded.start_ts, end_ts = excluded.end_ts, day = excluded.day,
    updated_at = excluded.updated_at, created_at = excluded.created_at, raw = excluded.raw,
    synced_at = excluded.synced_at, deleted_at = null;
  get diagnostics cnt = row_count;

  insert into health.hevy_sets as hs (workout_id, exercise_index, set_index, exercise_title, exercise_template_id,
    superset_id, exercise_notes, set_type, weight_kg, reps, distance_m, duration_s, rpe, synced_at)
  select w->>'id',
    coalesce((ex->>'index')::int, exi::int - 1),
    coalesce((st->>'index')::int, sti::int - 1),
    ex->>'title', ex->>'exercise_template_id', ex->>'superset_id', nullif(ex->>'notes',''),
    coalesce(st->>'type', st->>'set_type', 'normal'),
    (st->>'weight_kg')::float8, (st->>'reps')::int, (st->>'distance_meters')::float8,
    (st->>'duration_seconds')::float8, (st->>'rpe')::float8, v_now
  from jsonb_array_elements(p) w
  cross join lateral jsonb_array_elements(coalesce(w->'exercises','[]'::jsonb)) with ordinality as e1(ex, exi)
  cross join lateral jsonb_array_elements(coalesce(ex->'sets','[]'::jsonb)) with ordinality as s1(st, sti)
  where w->>'id' is not null
  on conflict (workout_id, exercise_index, set_index) do update set
    exercise_title = excluded.exercise_title, exercise_template_id = excluded.exercise_template_id,
    superset_id = excluded.superset_id, exercise_notes = excluded.exercise_notes, set_type = excluded.set_type,
    weight_kg = excluded.weight_kg, reps = excluded.reps, distance_m = excluded.distance_m,
    duration_s = excluded.duration_s, rpe = excluded.rpe, synced_at = excluded.synced_at;

  return cnt;
end $$;

-- Verwijderde Hevy-trainingen: soft delete
create or replace function public.hevy_delete_workouts(p_ids text[])
returns int language plpgsql security definer set search_path = '' as $$
declare cnt int;
begin
  update health.hevy_workouts set deleted_at = now() where id = any(p_ids) and deleted_at is null;
  get diagnostics cnt = row_count;
  return cnt;
end $$;

create or replace function public.hevy_upsert_templates(p jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare cnt int;
begin
  insert into health.hevy_exercise_templates (id, title, type, primary_muscle_group, secondary_muscle_groups, is_custom, updated_at)
  select t->>'id', t->>'title', t->>'type', t->>'primary_muscle_group',
    coalesce(array(select jsonb_array_elements_text(coalesce(t->'secondary_muscle_groups','[]'::jsonb))), '{}'),
    (t->>'is_custom')::boolean, now()
  from jsonb_array_elements(p) t where t->>'id' is not null
  on conflict (id) do update set title = excluded.title, type = excluded.type,
    primary_muscle_group = excluded.primary_muscle_group,
    secondary_muscle_groups = excluded.secondary_muscle_groups,
    is_custom = excluded.is_custom, updated_at = now();
  get diagnostics cnt = row_count;
  return cnt;
end $$;

-- sync-status (voor edge functions)
create or replace function public.sync_state_get(p_source text)
returns jsonb language sql security definer set search_path = '' as $$
  select to_jsonb(s) from app.sync_state s where s.source = p_source;
$$;

create or replace function public.sync_state_set(p_source text, p_cursor text, p_ok boolean, p_items int, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into app.sync_state(source, last_run, last_success, cursor, last_items, last_error)
  values (p_source, now(), case when p_ok then now() end, p_cursor, p_items, p_error)
  on conflict (source) do update set
    last_run = now(),
    last_success = case when p_ok then now() else app.sync_state.last_success end,
    cursor = coalesce(excluded.cursor, app.sync_state.cursor),
    last_items = excluded.last_items,
    last_error = excluded.last_error;
  insert into app.ingest_log(source, stats, error)
  values (p_source, jsonb_build_object('items', p_items), p_error);
end $$;

create or replace function public.internal_get_secret(p_name text)
returns text language sql stable security definer set search_path = '' as $$
  select nullif(app.get_secret(p_name), '');
$$;

create or replace function public.internal_get_setting(p_key text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select value from app.settings where key = p_key;
$$;

create or replace function public.internal_is_owner(p_uid uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from app.owners where user_id = p_uid);
$$;

-- Alleen de service-rol (edge functions) mag deze functies aanroepen
do $$
declare f text;
begin
  foreach f in array array[
    'public.ingest_health_export(jsonb)',
    'public.hevy_upsert_workouts(jsonb)',
    'public.hevy_delete_workouts(text[])',
    'public.hevy_upsert_templates(jsonb)',
    'public.sync_state_get(text)',
    'public.sync_state_set(text,text,boolean,integer,text)',
    'public.internal_get_secret(text)',
    'public.internal_get_setting(text)',
    'public.internal_is_owner(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
