-- 0009: energiebalans (echt onderhoud), sneller voeding loggen (kopiëren, maaltijden, recepten),
--       progressie per oefening en werksets per spiergroep.

-- ======================================================================
-- Spiergroepen: voorkeuren per oefening + automatische herkenning op naam
-- ======================================================================
create table if not exists app.exercise_prefs (
  title        text primary key,
  muscle       text,
  rep_min      int check (rep_min between 1 and 100),
  rep_max      int check (rep_max between 1 and 100),
  increment_kg numeric check (increment_kg > 0 and increment_kg <= 50),
  updated_at   timestamptz not null default now()
);
alter table app.exercise_prefs enable row level security;

-- Herkent de spiergroep uit de (Engelse Hevy-)naam van een oefening. Volgorde is belangrijk.
create or replace function health.guess_muscle(p_title text)
returns text language sql immutable set search_path = '' as $$
  select case
    when t ~ '(treadmill|elliptical|stair|bike|cycling|rowing machine|running|walking)' then 'cardio'
    when t ~ 'calf' then 'calves'
    when t ~ 'adduction' then 'adductors'
    when t ~ 'abduction' then 'abductors'
    when t ~ '(leg curl|romanian|straight leg deadlift|stiff leg|good morning|nordic)' then 'hamstrings'
    when t ~ '(hip thrust|glute|kickback \(machine\))' then 'glutes'
    when t ~ '(deadlift|back extension|hyperextension)' then 'lower_back'
    when t ~ '(squat|leg press|leg extension|lunge|step up)' then 'quadriceps'
    when t ~ '(crunch|plank|twist|leg raise|sit up|ab wheel|hollow)' then 'abdominals'
    when t ~ 'shrug' then 'traps'
    when t ~ '(rear delt|reverse fly|face pull)' then 'shoulders'
    when t ~ '(lateral raise|shoulder press|overhead press|military|arnold|upright row|front raise)' then 'shoulders'
    when t ~ '(pulldown|pull up|pull-up|chin up|pullover)' then 'lats'
    when t ~ 'row' then 'upper_back'
    when t ~ '(forearm|forarm|wrist)' then 'forearms'
    when t ~ '(tricep|pushdown|skullcrusher|skull crusher|dip|jm press|french press|kickback)' then 'triceps'
    when t ~ 'curl' then 'biceps'
    when t ~ '(bench|chest|fly|flys|push up|pec|supine press)' then 'chest'
    when t ~ 'press' then 'shoulders'
    else 'other' end
  from (select lower(coalesce(p_title, '')) as t) x
$$;

-- Effectieve spiergroep: eigen keuze > Hevy-template > herkenning op naam
create or replace function health.muscle_of(p_title text, p_template_muscle text)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select muscle from app.exercise_prefs where title = p_title), nullif(p_template_muscle, ''), health.guess_muscle(p_title))
$$;

create or replace view ai.strength_sets as
select s.workout_id, w.day, w.title as workout_title,
  s.exercise_index, s.exercise_title as exercise,
  health.muscle_of(s.exercise_title, t.primary_muscle_group) as primary_muscle, t.secondary_muscle_groups as secondary_muscles,
  s.set_index, s.set_type, s.weight_kg, s.reps, s.rpe, s.distance_m, s.duration_s,
  case when s.weight_kg > 0 and s.reps between 1 and 15
       then round((s.weight_kg * (1 + s.reps / 30.0))::numeric, 1) end as est_1rm_kg,
  coalesce(s.weight_kg, 0) * coalesce(s.reps, 0) as volume_kg
from health.hevy_sets s
join health.hevy_workouts w on w.id = s.workout_id and s.synced_at = w.synced_at and w.deleted_at is null
left join health.hevy_exercise_templates t on t.id = s.exercise_template_id;
comment on view ai.strength_sets is 'Elke krachttrainingsset (Hevy-import of in de app gelogd). set_type: normal/warmup/dropset/failure. primary_muscle = spiergroep (chest, lats, upper_back, shoulders, biceps, triceps, quadriceps, hamstrings, glutes, calves, abdominals, ...). volume_kg = gewicht x reps. est_1rm_kg = geschatte 1RM (Epley).';

-- Werksets per spiergroep per week (maandag = weekstart)
create or replace view ai.muscle_sets_weekly as
select date_trunc('week', day)::date as week_start, primary_muscle as muscle,
       count(*) as working_sets, round(sum(volume_kg)::numeric, 0) as volume_kg,
       count(distinct workout_id) as sessions
from ai.strength_sets
where set_type <> 'warmup' and primary_muscle not in ('cardio')
group by 1, 2;
comment on view ai.muscle_sets_weekly is 'Aantal werksets (excl. opwarmsets) per spiergroep per week. Vaak aangeraden voor spiergroei: ongeveer 10-20 werksets per spiergroep per week.';

create or replace function public.get_muscle_volume(p_weeks int default 8)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (select coalesce(jsonb_agg(to_jsonb(m) order by m.week_start, m.muscle), '[]'::jsonb)
          from ai.muscle_sets_weekly m
          where m.week_start >= date_trunc('week', (now() at time zone 'Europe/Brussels')::date)::date - (p_weeks * 7));
end $$;

create or replace function public.set_exercise_pref(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r app.exercise_prefs;
begin
  perform app.assert_owner();
  if coalesce(btrim(p->>'title'), '') = '' then raise exception 'Oefening ontbreekt'; end if;
  insert into app.exercise_prefs as x (title, muscle, rep_min, rep_max, increment_kg)
  values (btrim(p->>'title'), nullif(p->>'muscle', ''), (p->>'rep_min')::int, (p->>'rep_max')::int, (p->>'increment_kg')::numeric)
  on conflict (title) do update set
    muscle = case when p ? 'muscle' then nullif(p->>'muscle', '') else x.muscle end,
    rep_min = case when p ? 'rep_min' then (p->>'rep_min')::int else x.rep_min end,
    rep_max = case when p ? 'rep_max' then (p->>'rep_max')::int else x.rep_max end,
    increment_kg = case when p ? 'increment_kg' then (p->>'increment_kg')::numeric else x.increment_kg end,
    updated_at = now()
  returning * into r;
  if r.rep_min is not null and r.rep_max is not null and r.rep_min > r.rep_max then
    raise exception 'Minimum herhalingen is groter dan maximum';
  end if;
  return to_jsonb(r);
end $$;

-- Context per oefening, nu met spiergroep en herhalingsbereik (eigen keuze of afgeleid uit je historiek)
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
      'best_volume_set', (select max(volume_kg) from ai.strength_sets where exercise = t.title and set_type <> 'warmup'),
      'muscle', health.muscle_of(t.title, (select primary_muscle_group from health.hevy_exercise_templates where title = t.title limit 1)),
      'pref', (select to_jsonb(p) from app.exercise_prefs p where p.title = t.title),
      -- typisch bereik uit de laatste 6 trainingen (25e-75e percentiel van je werksets)
      'typical', (select jsonb_build_object('rep_min', round(percentile_cont(0.25) within group (order by reps)),
                                            'rep_max', round(percentile_cont(0.75) within group (order by reps)))
                  from ai.strength_sets s
                  where s.exercise = t.title and s.set_type <> 'warmup' and s.reps > 0
                    and s.workout_id in (select s3.workout_id from ai.strength_sets s3 join health.hevy_workouts w3 on w3.id = s3.workout_id
                                         where s3.exercise = t.title group by s3.workout_id order by max(w3.start_ts) desc limit 6))
    )), '{}'::jsonb)
    from unnest(p_titles) as t(title));
end $$;

-- Oefeningenlijst met spiergroep
create or replace function public.get_exercise_library()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (select coalesce(jsonb_agg(to_jsonb(x) order by x.sessions desc), '[]'::jsonb) from (
    select exercise as title, max(primary_muscle) as muscle, count(distinct workout_id) as sessions, max(day) as last_day
    from ai.strength_sets group by exercise) x);
end $$;

-- ======================================================================
-- Energiebalans: gewichtstrend (EWMA) en echt onderhoud uit inname + trend
-- ======================================================================
-- Gewichtstrend: exponentieel gewogen gemiddelde (alpha 0,1), dagen zonder weging nemen de trend over.
create or replace function health.weight_trend(p_from date, p_to date)
returns table(day date, weight_kg numeric, trend_kg numeric)
language plpgsql stable security definer set search_path = '' as $$
declare
  r record;
  tr numeric := null;
  v_start date;
begin
  select min(s.day) into v_start from ai.daily_summary s where s.weight_kg is not null and s.day >= p_from - 90 and s.day <= p_to;
  if v_start is null then return; end if;
  for r in select g::date as d, s.weight_kg as w
           from generate_series(v_start, p_to, interval '1 day') g
           left join ai.daily_summary s on s.day = g::date loop
    if r.w is not null then tr := case when tr is null then r.w else tr + 0.1 * (r.w - tr) end; end if;
    if r.d >= p_from then
      day := r.d; weight_kg := r.w; trend_kg := round(tr, 2);
      return next;
    end if;
  end loop;
end $$;

create or replace view ai.weight_trend as
select * from health.weight_trend((now() at time zone 'Europe/Brussels')::date - 365, (now() at time zone 'Europe/Brussels')::date);
comment on view ai.weight_trend is 'Gewicht per dag (weight_kg, leeg als niet gewogen) en afgevlakte trend (trend_kg, exponentieel gemiddelde). Gebruik trend_kg voor veranderingen: dagelijkse schommelingen zijn vooral vocht.';

-- Onderhoud = gemiddelde inname - (trendverandering x 7700 kcal/kg) / dagen.
-- Dagen met < 800 kcal gelogd tellen als onvolledig en worden genegeerd.
create or replace function health.energy_estimate(p_days int default 28, p_end date default null)
returns table(window_start date, window_end date, days int, logged_days int, weigh_ins int,
              avg_intake_kcal numeric, trend_start_kg numeric, trend_end_kg numeric, weekly_change_kg numeric,
              maintenance_kcal numeric, device_estimate_kcal numeric, confidence text, note text)
language plpgsql stable security definer set search_path = '' as $$
declare
  e date := coalesce(p_end, (now() at time zone 'Europe/Brussels')::date - 1);
  s date := e - p_days + 1;
  t0 numeric; t1 numeric; first_w date;
begin
  window_start := s; window_end := e; days := p_days;
  select count(*) filter (where d.kcal_in >= 800), count(d.weight_kg),
         round(avg(d.kcal_in) filter (where d.kcal_in >= 800)),
         round(avg(d.total_kcal_out) filter (where d.total_kcal_out > 1000))
    into logged_days, weigh_ins, avg_intake_kcal, device_estimate_kcal
  from ai.daily_summary d where d.day between s and e;
  select min(d.day) into first_w from ai.daily_summary d where d.weight_kg is not null;
  select w.trend_kg into t0 from health.weight_trend(s - 1, s - 1) w;
  select w.trend_kg into t1 from health.weight_trend(e, e) w;
  trend_start_kg := t0; trend_end_kg := t1;
  if t0 is not null and t1 is not null then weekly_change_kg := round((t1 - t0) / p_days * 7, 2); end if;

  if coalesce(logged_days, 0) < p_days / 2 then
    confidence := 'onvoldoende'; note := format('Te weinig dagen met voeding gelogd (%s van %s, minstens %s nodig).', coalesce(logged_days, 0), p_days, p_days / 2);
  elsif coalesce(weigh_ins, 0) < 4 or t0 is null or first_w > s - 7 then
    confidence := 'onvoldoende'; note := 'Te weinig wegingen: weeg je minstens 2-3 keer per week, liefst al een week vóór de periode.';
  else
    maintenance_kcal := round((avg_intake_kcal - (t1 - t0) * 7700 / p_days) / 10) * 10;
    confidence := case when logged_days >= p_days * 0.85 and weigh_ins >= p_days * 0.4 then 'hoog'
                       when logged_days >= p_days * 0.65 and weigh_ins >= p_days * 0.25 then 'redelijk' else 'laag' end;
    note := case confidence when 'hoog' then 'Gebaseerd op consequent loggen en wegen.'
                            when 'redelijk' then 'Bruikbaar; logt en weegt je vaker, dan wordt het nauwkeuriger.'
                            else 'Ruwe schatting: weinig gelogde dagen of wegingen.' end;
  end if;
  return next;
end $$;

create or replace view ai.energy_balance as select * from health.energy_estimate(28);
comment on view ai.energy_balance is 'Geschat werkelijk onderhoud (maintenance_kcal) over de laatste 28 volledige dagen, berekend uit gemiddelde inname en de verandering van de gewichtstrend (7700 kcal per kg). device_estimate_kcal = schatting van horloge/Apple Health (actief + rust). confidence: hoog/redelijk/laag/onvoldoende.';
grant select on ai.muscle_sets_weekly, ai.weight_trend, ai.energy_balance, ai.strength_sets to ai_reader;

create or replace function public.get_energy(p_days int default 28)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'Europe/Brussels')::date;
  est jsonb;
  g jsonb;
begin
  perform app.assert_owner();
  select to_jsonb(x) into est from health.energy_estimate(greatest(14, least(p_days, 90))) x;
  select value into g from app.settings where key = 'goals';
  return jsonb_build_object(
    'estimate', est,
    'goal_kcal', g->'kcal_in',
    'expected_weekly_change_kg', case when est->>'maintenance_kcal' is not null and g ? 'kcal_in'
         then round(((g->>'kcal_in')::numeric - (est->>'maintenance_kcal')::numeric) * 7 / 7700, 2) end,
    'series', (select coalesce(jsonb_agg(jsonb_build_object('day', w.day, 'weight', w.weight_kg, 'trend', w.trend_kg) order by w.day), '[]'::jsonb)
               from health.weight_trend(today - 364, today) w));
end $$;

-- ======================================================================
-- Voeding: kopiëren, vaste maaltijden, recepten
-- ======================================================================
alter table app.foods add column if not exists recipe jsonb;  -- {ingredients:[{food_id,name,grams}], total_g, servings}

create table if not exists app.meal_presets (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  items        jsonb not null default '[]',  -- [{food_id?, grams?, name, kcal, protein, carbs, fat}]
  use_count    int not null default 0,
  last_used_at timestamptz,
  archived     boolean not null default false,
  created_at   timestamptz not null default now()
);
alter table app.meal_presets enable row level security;

-- Eén food_log-rij opnieuw loggen (met actuele productwaarden als het een product is)
create or replace function app.relog(f app.food_log, p_day date, p_meal text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if f.food_id is not null and f.grams is not null then
    return public.log_food(jsonb_build_object('day', p_day, 'meal', p_meal, 'grams', f.grams, 'food', jsonb_build_object('id', f.food_id)));
  end if;
  return public.log_food(jsonb_build_object('day', p_day, 'meal', p_meal, 'name', f.name,
    'kcal', f.kcal, 'protein', f.protein, 'carbs', f.carbs, 'fat', f.fat, 'fiber', f.fiber));
end $$;
revoke all on function app.relog(app.food_log, date, text) from public, anon, authenticated;

-- Maaltijd (of hele dag als p_meal null) kopiëren. Geeft de nieuwe ids terug (voor ongedaan maken).
create or replace function public.copy_meal(p_from date, p_meal text, p_to date, p_to_meal text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare f app.food_log; ids jsonb := '[]'; r jsonb;
begin
  perform app.assert_owner();
  for f in select * from app.food_log where day = p_from and not voided and (p_meal is null or meal = p_meal) order by created_at loop
    r := app.relog(f, p_to, coalesce(p_to_meal, f.meal));
    ids := ids || jsonb_build_array(r->>'id');
  end loop;
  return ids;
end $$;

create or replace function public.void_food_many(p_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  update app.food_log set voided = true where id = any(p_ids);
  update health.metric_samples set voided = true where ref = any(p_ids);
end $$;

create or replace function public.get_meal_presets()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (select coalesce(jsonb_agg(to_jsonb(m) || jsonb_build_object(
      'kcal', (select round(sum((i->>'kcal')::numeric)) from jsonb_array_elements(m.items) i),
      'protein', (select round(sum((i->>'protein')::numeric)) from jsonb_array_elements(m.items) i))
    order by m.last_used_at desc nulls last, m.name), '[]'::jsonb)
    from app.meal_presets m where not m.archived);
end $$;

-- p: {id?, name, from_day+from_meal (bewaar wat je die maaltijd at) | items, archived?}
create or replace function public.save_meal_preset(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r app.meal_presets; v_items jsonb := p->'items';
begin
  perform app.assert_owner();
  if p->>'from_day' is not null then
    select coalesce(jsonb_agg(jsonb_build_object('food_id', f.food_id, 'grams', f.grams, 'name', f.name,
             'kcal', f.kcal, 'protein', f.protein, 'carbs', f.carbs, 'fat', f.fat, 'fiber', f.fiber) order by f.created_at), '[]')
      into v_items from app.food_log f
      where f.day = (p->>'from_day')::date and f.meal = p->>'from_meal' and not f.voided;
    if jsonb_array_length(v_items) = 0 then raise exception 'Niets om te bewaren in deze maaltijd'; end if;
  end if;
  if p->>'id' is not null then
    update app.meal_presets set name = coalesce(nullif(btrim(p->>'name'), ''), name), items = coalesce(v_items, items),
      archived = coalesce((p->>'archived')::boolean, archived)
    where id = (p->>'id')::uuid returning * into r;
  else
    insert into app.meal_presets (name, items) values (coalesce(nullif(btrim(p->>'name'), ''), 'Maaltijd'), coalesce(v_items, '[]'))
    returning * into r;
  end if;
  return to_jsonb(r);
end $$;

create or replace function public.log_meal_preset(p_id uuid, p_day date, p_meal text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m app.meal_presets; i jsonb; ids jsonb := '[]'; r jsonb;
begin
  perform app.assert_owner();
  select * into m from app.meal_presets where id = p_id and not archived;
  if m.id is null then raise exception 'Maaltijd niet gevonden'; end if;
  for i in select value from jsonb_array_elements(m.items) loop
    if i->>'food_id' is not null and i->>'grams' is not null
       and exists (select 1 from app.foods where id = (i->>'food_id')::uuid) then
      r := public.log_food(jsonb_build_object('day', p_day, 'meal', p_meal, 'grams', (i->>'grams')::numeric,
                                              'food', jsonb_build_object('id', i->>'food_id')));
    else
      r := public.log_food(jsonb_build_object('day', p_day, 'meal', p_meal, 'name', i->>'name',
             'kcal', i->'kcal', 'protein', i->'protein', 'carbs', i->'carbs', 'fat', i->'fat', 'fiber', i->'fiber'));
    end if;
    ids := ids || jsonb_build_array(r->>'id');
  end loop;
  update app.meal_presets set use_count = use_count + 1, last_used_at = now() where id = p_id;
  return ids;
end $$;

-- Recept: voedingswaarden per 100 g uit de ingrediënten.
-- p: {id?, name, servings, total_g? (gewicht na bereiden; standaard som van ingrediënten), ingredients:[{food_id, grams}]}
create or replace function public.save_recipe(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  ing jsonb := '[]'; i jsonb; f app.foods;
  tot jsonb := '{}'; k text; sum_g numeric := 0; total_g numeric; servings numeric := greatest(coalesce((p->>'servings')::numeric, 1), 1);
  per jsonb := '{}'; r app.foods;
begin
  perform app.assert_owner();
  if coalesce(btrim(p->>'name'), '') = '' then raise exception 'Geef het recept een naam'; end if;
  for i in select value from jsonb_array_elements(coalesce(p->'ingredients', '[]')) loop
    select * into f from app.foods where id = (i->>'food_id')::uuid;
    if f.id is null or coalesce((i->>'grams')::numeric, 0) <= 0 then continue; end if;
    sum_g := sum_g + (i->>'grams')::numeric;
    ing := ing || jsonb_build_array(jsonb_build_object('food_id', f.id, 'name', f.name, 'grams', (i->>'grams')::numeric));
    foreach k in array array['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium_mg'] loop
      if f.per100->>k is not null then
        tot := tot || jsonb_build_object(k, coalesce((tot->>k)::numeric, 0) + (f.per100->>k)::numeric * (i->>'grams')::numeric / 100);
      end if;
    end loop;
  end loop;
  if sum_g = 0 then raise exception 'Voeg minstens één ingrediënt toe'; end if;
  total_g := coalesce(nullif((p->>'total_g')::numeric, 0), sum_g);
  foreach k in array array['kcal', 'protein', 'carbs', 'fat', 'fiber', 'sugar', 'sodium_mg'] loop
    if tot ? k then per := per || jsonb_build_object(k, round((tot->>k)::numeric / total_g * 100, 2)); end if;
  end loop;
  if p->>'id' is not null then
    update app.foods set name = btrim(p->>'name'), per100 = per, serving_g = round(total_g / servings, 1),
      serving_label = '1 portie', source = 'recipe', archived = false,
      recipe = jsonb_build_object('ingredients', ing, 'total_g', total_g, 'servings', servings)
    where id = (p->>'id')::uuid returning * into r;
  else
    insert into app.foods (name, per100, serving_g, serving_label, source, recipe)
    values (btrim(p->>'name'), per, round(total_g / servings, 1), '1 portie', 'recipe',
            jsonb_build_object('ingredients', ing, 'total_g', total_g, 'servings', servings))
    returning * into r;
  end if;
  return to_jsonb(r);
end $$;

-- save_food: bron instelbaar (OFF-product bewaren als ingrediënt blijft 'off')
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
            nullif((p->>'serving_g')::numeric, 0), p->>'serving_label', coalesce(nullif(p->>'source', ''), 'custom'))
    on conflict (barcode) do update set name = excluded.name, brand = excluded.brand, per100 = excluded.per100,
      serving_g = coalesce(excluded.serving_g, app.foods.serving_g), source = excluded.source, archived = false
    returning * into r;
  end if;
  return to_jsonb(r);
end $$;

-- Rechten: alleen ingelogde gebruikers (eigenaarscontrole zit in elke functie)
do $$
declare fn text;
begin
  foreach fn in array array['get_muscle_volume(int)', 'set_exercise_pref(jsonb)', 'get_energy(int)', 'copy_meal(date,text,date,text)',
    'void_food_many(uuid[])', 'get_meal_presets()', 'save_meal_preset(jsonb)', 'log_meal_preset(uuid,date,text)', 'save_recipe(jsonb)'] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;

-- Training verwijderen (zacht: deleted_at), bv. een testtraining uit de app
create or replace function public.remove_workout(p_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  update health.hevy_workouts set deleted_at = now() where id = p_id;
end $$;
revoke all on function public.remove_workout(text) from public, anon;
grant execute on function public.remove_workout(text) to authenticated;
