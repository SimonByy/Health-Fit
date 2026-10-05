-- =====================================================================
-- 0008: krachttraining loggen in de app, voeding loggen, rusttimer
-- =====================================================================

-- ---------- algemeen ----------
alter table health.metric_samples add column if not exists ref uuid;
create index if not exists metric_samples_ref_idx on health.metric_samples (ref) where ref is not null;
alter table health.hevy_workouts add column if not exists source text not null default 'hevy';

-- ---------- voeding loggen ----------
create table if not exists app.foods (
  id          uuid primary key default gen_random_uuid(),
  barcode     text unique,
  name        text not null,
  brand       text,
  per100      jsonb not null,           -- {kcal, protein, carbs, fat, fiber, sugar, sodium_mg} per 100 g/ml
  serving_g   numeric,                  -- standaardportie in gram
  serving_label text,
  source      text not null default 'off',   -- off | custom
  use_count   int not null default 0,
  last_used_at timestamptz,
  archived    boolean not null default false,
  created_at  timestamptz not null default now()
);
alter table app.foods enable row level security;

create table if not exists app.food_log (
  id         uuid primary key default gen_random_uuid(),
  day        date not null,
  meal       text not null,
  food_id    uuid references app.foods(id),
  name       text not null,
  brand      text,
  grams      numeric,
  kcal       numeric, protein numeric, carbs numeric, fat numeric, fiber numeric, sugar numeric, sodium_mg numeric,
  voided     boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists food_log_day_idx on app.food_log (day);
alter table app.food_log enable row level security;

create or replace function app.meal_hour(p_meal text)
returns smallint language sql immutable set search_path = '' as $$
  select case p_meal when 'Ontbijt' then 8 when 'Lunch' then 12 when 'Snack' then 16
                     when 'Avondeten' then 19 when 'Laat' then 22 else 12 end::smallint;
$$;

-- p: {day, meal, grams, food:{id?|barcode?, name, brand, per100:{...}, serving_g, serving_label, source}}
--   of zonder food (snel invoeren): {day, meal, name, kcal, protein, carbs, fat}
create or replace function public.log_food(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_day date := coalesce((p->>'day')::date, (now() at time zone 'Europe/Brussels')::date);
  v_meal text := coalesce(p->>'meal', 'Snack');
  v_food app.foods;
  f jsonb := p->'food';
  g numeric := nullif((p->>'grams')::numeric, 0);
  per jsonb;
  v_id uuid := gen_random_uuid();
  vals jsonb;
  k text;
  v_metric text;
  v_ts timestamptz := clock_timestamp();
begin
  perform app.assert_owner();
  if v_meal not in ('Ontbijt', 'Lunch', 'Snack', 'Avondeten', 'Laat') then raise exception 'Onbekende maaltijd'; end if;

  if f is not null then
    if f->>'id' is not null then
      select * into v_food from app.foods where id = (f->>'id')::uuid;
    end if;
    if v_food.id is null then
      insert into app.foods as x (barcode, name, brand, per100, serving_g, serving_label, source)
      values (nullif(f->>'barcode', ''), coalesce(nullif(btrim(f->>'name'), ''), 'Onbekend product'), nullif(f->>'brand', ''),
              coalesce(f->'per100', '{}'::jsonb), nullif((f->>'serving_g')::numeric, 0), f->>'serving_label', coalesce(f->>'source', 'off'))
      on conflict (barcode) do update set name = excluded.name, brand = excluded.brand, per100 = excluded.per100,
        serving_g = coalesce(excluded.serving_g, x.serving_g), serving_label = coalesce(excluded.serving_label, x.serving_label), archived = false
      returning * into v_food;
    end if;
    update app.foods set use_count = use_count + 1, last_used_at = now() where id = v_food.id;
    if g is null then raise exception 'Hoeveelheid ontbreekt'; end if;
    per := v_food.per100;
    vals := jsonb_build_object(
      'kcal', round(((per->>'kcal')::numeric * g / 100), 1),
      'protein', round(((per->>'protein')::numeric * g / 100), 1),
      'carbs', round(((per->>'carbs')::numeric * g / 100), 1),
      'fat', round(((per->>'fat')::numeric * g / 100), 1),
      'fiber', round(((per->>'fiber')::numeric * g / 100), 1),
      'sugar', round(((per->>'sugar')::numeric * g / 100), 1),
      'sodium_mg', round(((per->>'sodium_mg')::numeric * g / 100), 0));
  else
    vals := jsonb_build_object('kcal', (p->>'kcal')::numeric, 'protein', (p->>'protein')::numeric,
      'carbs', (p->>'carbs')::numeric, 'fat', (p->>'fat')::numeric, 'fiber', (p->>'fiber')::numeric);
  end if;

  insert into app.food_log (id, day, meal, food_id, name, brand, grams, kcal, protein, carbs, fat, fiber, sugar, sodium_mg)
  values (v_id, v_day, v_meal, v_food.id, coalesce(v_food.name, nullif(btrim(p->>'name'), ''), 'Snel ingevoerd'), v_food.brand, g,
          (vals->>'kcal')::numeric, (vals->>'protein')::numeric, (vals->>'carbs')::numeric, (vals->>'fat')::numeric,
          (vals->>'fiber')::numeric, (vals->>'sugar')::numeric, (vals->>'sodium_mg')::numeric);

  -- ook als metingen bewaren, zodat dashboard, trends en AI het meteen meenemen
  for k, v_metric in select * from (values ('kcal','dietary_energy'), ('protein','protein'), ('carbs','carbohydrates'),
      ('fat','total_fat'), ('fiber','fiber'), ('sugar','dietary_sugar'), ('sodium_mg','sodium')) as m(k, metric) loop
    continue when vals->>k is null or (vals->>k)::numeric <= 0;
    insert into health.metric_samples (metric, ts, day, hour, qty, units, source, ref)
    values (v_metric, v_ts, v_day, app.meal_hour(v_meal), (vals->>k)::numeric,
            case when k = 'kcal' then 'kcal' when k = 'sodium_mg' then 'mg' else 'g' end, 'Health Hub', v_id);
  end loop;
  return jsonb_build_object('id', v_id) || vals;
end $$;

create or replace function public.void_food(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  update app.food_log set voided = true where id = p_id;
  update health.metric_samples set voided = true where ref = p_id;
end $$;

create or replace function public.get_food_log(p_day date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (select coalesce(jsonb_agg(to_jsonb(f) order by f.created_at), '[]'::jsonb)
          from app.food_log f where f.day = p_day and not f.voided);
end $$;

create or replace function public.get_foods(p_query text default null, p_limit int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
    select * from app.foods
    where not archived and (p_query is null or name ilike '%' || p_query || '%' or brand ilike '%' || p_query || '%' or barcode = p_query)
    order by last_used_at desc nulls last, use_count desc limit p_limit) x);
end $$;

create or replace function public.save_food(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r app.foods;
begin
  perform app.assert_owner();
  if p->>'id' is not null then
    update app.foods set name = coalesce(nullif(btrim(p->>'name'), ''), name), brand = coalesce(p->>'brand', brand),
      per100 = coalesce(p->'per100', per100), serving_g = coalesce((p->>'serving_g')::numeric, serving_g),
      archived = coalesce((p->>'archived')::boolean, archived)
    where id = (p->>'id')::uuid returning * into r;
  else
    insert into app.foods (barcode, name, brand, per100, serving_g, serving_label, source)
    values (nullif(p->>'barcode', ''), btrim(p->>'name'), nullif(p->>'brand', ''), coalesce(p->'per100', '{}'::jsonb),
            nullif((p->>'serving_g')::numeric, 0), p->>'serving_label', 'custom')
    on conflict (barcode) do update set name = excluded.name, brand = excluded.brand, per100 = excluded.per100,
      serving_g = coalesce(excluded.serving_g, app.foods.serving_g), source = 'custom', archived = false
    returning * into r;
  end if;
  return to_jsonb(r);
end $$;

-- ---------- krachttraining loggen ----------
create table if not exists app.workout_templates (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  exercises  jsonb not null default '[]',  -- [{title, muscle, sets, rest_s, notes}]
  archived   boolean not null default false,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table app.workout_templates enable row level security;

create or replace function public.get_templates()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (select coalesce(jsonb_agg(to_jsonb(t) order by t.last_used_at desc nulls last, t.name), '[]'::jsonb)
          from app.workout_templates t where not t.archived);
end $$;

create or replace function public.save_template(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r app.workout_templates;
begin
  perform app.assert_owner();
  if p->>'id' is not null then
    update app.workout_templates set
      name = coalesce(nullif(btrim(p->>'name'), ''), name),
      exercises = coalesce(p->'exercises', exercises),
      archived = coalesce((p->>'archived')::boolean, archived),
      last_used_at = case when (p->>'touch')::boolean then now() else last_used_at end,
      updated_at = now()
    where id = (p->>'id')::uuid returning * into r;
  else
    insert into app.workout_templates (name, exercises) values (btrim(p->>'name'), coalesce(p->'exercises', '[]'::jsonb))
    returning * into r;
  end if;
  return to_jsonb(r);
end $$;

-- Bibliotheek: alle oefeningen uit je historiek (met spiergroep indien bekend)
create or replace function public.get_exercise_library()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (select coalesce(jsonb_agg(to_jsonb(x) order by x.sessions desc), '[]'::jsonb) from (
    select s.exercise_title as title, max(t.primary_muscle_group) as muscle,
           count(distinct s.workout_id) as sessions, max(w.day) as last_day
    from health.hevy_sets s
    join health.hevy_workouts w on w.id = s.workout_id and s.synced_at = w.synced_at and w.deleted_at is null
    left join health.hevy_exercise_templates t on t.id = s.exercise_template_id
    group by s.exercise_title) x);
end $$;

-- Per oefening: sets van de vorige keer + records (voor "Vorige" en PR-detectie)
create or replace function public.get_exercise_context(p_titles text[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (select coalesce(jsonb_object_agg(t.title, jsonb_build_object(
      'last', (select coalesce(jsonb_agg(jsonb_build_object('type', s.set_type, 'kg', s.weight_kg, 'reps', s.reps,
                       'duration_s', s.duration_s, 'distance_m', s.distance_m) order by s.set_index), '[]'::jsonb)
               from ai.strength_sets s
               where s.exercise = t.title and s.workout_id = (
                 select s2.workout_id from ai.strength_sets s2 join health.hevy_workouts w2 on w2.id = s2.workout_id
                 where s2.exercise = t.title order by w2.start_ts desc limit 1)),
      'last_day', (select max(day) from ai.strength_sets where exercise = t.title),
      'best_1rm', (select max(est_1rm_kg) from ai.strength_sets where exercise = t.title and set_type <> 'warmup'),
      'max_kg', (select max(weight_kg) from ai.strength_sets where exercise = t.title and set_type <> 'warmup'),
      'max_reps', (select max(reps) from ai.strength_sets where exercise = t.title and set_type <> 'warmup'),
      'best_volume_set', (select max(volume_kg) from ai.strength_sets where exercise = t.title and set_type <> 'warmup')
    )), '{}'::jsonb)
    from unnest(p_titles) as t(title));
end $$;

-- Training opslaan (uit de app). Geeft records (PR's) terug.
create or replace function public.save_workout(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  w jsonb := p;
  ex jsonb;
  exs jsonb := '[]'::jsonb;
  tid text;
  prs jsonb;
  v_id text := coalesce(p->>'id', 'hh-' || gen_random_uuid()::text);
  titles text[];
  v_before jsonb;
begin
  perform app.assert_owner();
  -- oefening-templates (spiergroep) bijhouden
  for ex in select value from jsonb_array_elements(coalesce(p->'exercises', '[]'::jsonb)) loop
    tid := coalesce(nullif(ex->>'exercise_template_id', ''), 'hh:' || md5(lower(btrim(ex->>'title'))));
    insert into health.hevy_exercise_templates (id, title, type, primary_muscle_group, secondary_muscle_groups, is_custom, updated_at)
    values (tid, btrim(ex->>'title'), 'weight_reps', nullif(ex->>'muscle', ''), '{}', true, now())
    on conflict (id) do update set primary_muscle_group = coalesce(excluded.primary_muscle_group, health.hevy_exercise_templates.primary_muscle_group);
    exs := exs || jsonb_build_array(ex || jsonb_build_object('exercise_template_id', tid));
  end loop;
  w := (w - 'exercises') || jsonb_build_object('id', v_id, 'exercises', exs);

  titles := array(select distinct btrim(e->>'title') from jsonb_array_elements(exs) e);
  -- records vóór deze training (deze training zelf uitgesloten)
  select coalesce(jsonb_object_agg(x.exercise, jsonb_build_object('best_1rm', x.b, 'max_kg', x.m, 'max_reps', x.r)), '{}'::jsonb) into v_before
  from (select exercise, max(est_1rm_kg) b, max(weight_kg) m, max(reps) r from ai.strength_sets
        where exercise = any(titles) and set_type <> 'warmup' and workout_id <> v_id group by exercise) x;

  perform public.hevy_upsert_workouts(jsonb_build_array(w));
  update health.hevy_workouts set source = 'app' where id = v_id;

  select coalesce(jsonb_agg(jsonb_build_object('exercise', n.exercise, 'kind', n.kind, 'value', n.val, 'previous', n.prev)), '[]'::jsonb)
  into prs from (
    select a.exercise, 'Geschatte 1RM' as kind, a.b::float8 as val, (v_before->a.exercise->>'best_1rm')::float8 as prev
    from (select exercise, max(est_1rm_kg) b from ai.strength_sets where workout_id = v_id and set_type <> 'warmup' group by exercise) a
    where a.b is not null and v_before ? a.exercise and a.b > coalesce((v_before->a.exercise->>'best_1rm')::numeric, 0)
    union all
    select a.exercise, 'Zwaarste gewicht', a.m::float8, (v_before->a.exercise->>'max_kg')::float8
    from (select exercise, max(weight_kg) m from ai.strength_sets where workout_id = v_id and set_type <> 'warmup' group by exercise) a
    where a.m is not null and v_before ? a.exercise and a.m > coalesce((v_before->a.exercise->>'max_kg')::float8, 0)
  ) n;

  return jsonb_build_object('id', v_id, 'records', prs,
    'summary', (select to_jsonb(s) from ai.strength_workouts s where s.id = v_id));
end $$;

-- ---------- rusttimer (pushmelding na de rust) ----------
create table if not exists app.rest_timers (
  id         uuid primary key default gen_random_uuid(),
  due_at     timestamptz not null,
  title      text not null,
  body       text,
  state      text not null default 'active' check (state in ('active', 'cancelled', 'sent')),
  created_at timestamptz not null default now()
);
alter table app.rest_timers enable row level security;

create or replace function public.internal_timer_start(p_seconds int, p_title text, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r app.rest_timers;
begin
  update app.rest_timers set state = 'cancelled' where state = 'active';
  insert into app.rest_timers (due_at, title, body)
  values (now() + make_interval(secs => greatest(5, least(p_seconds, 1800))), p_title, p_body)
  returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.internal_timer_get(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select to_jsonb(t) from app.rest_timers t where t.id = p_id;
$$;

create or replace function public.internal_timer_mark(p_id uuid, p_state text)
returns void language sql security definer set search_path = '' as $$
  update app.rest_timers set state = p_state where id = p_id and state = 'active';
$$;

create or replace function public.rest_timer_adjust(p_id uuid, p_delta int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r app.rest_timers;
begin
  perform app.assert_owner();
  update app.rest_timers set due_at = greatest(now(), due_at + make_interval(secs => p_delta))
  where id = p_id and state = 'active' returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.rest_timer_cancel(p_id uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  update app.rest_timers set state = 'cancelled' where state = 'active' and (p_id is null or id = p_id);
end $$;

-- ---------- rechten ----------
do $$
declare f text;
begin
  foreach f in array array[
    'public.log_food(jsonb)', 'public.void_food(uuid)', 'public.get_food_log(date)', 'public.get_foods(text,integer)',
    'public.save_food(jsonb)', 'public.get_templates()', 'public.save_template(jsonb)', 'public.get_exercise_library()',
    'public.get_exercise_context(text[])', 'public.save_workout(jsonb)', 'public.rest_timer_adjust(uuid,integer)',
    'public.rest_timer_cancel(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['public.internal_timer_start(integer,text,text)', 'public.internal_timer_get(uuid)',
                           'public.internal_timer_mark(uuid,text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
revoke all on function app.meal_hour(text) from public;

-- doelen: koolhydraten, vet, vezels
update app.settings set value = value || '{"carbs_g":250,"fat_g":75,"fiber_g":30}'::jsonb
where key = 'goals' and not (value ? 'carbs_g');
