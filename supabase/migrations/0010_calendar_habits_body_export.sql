-- 0010: agenda (maandoverzicht), gewoontes/supplementen, lichaamsmaten, volledige data-export.

-- ---------- lichaamsmaten ----------
insert into health.metric_catalog(metric, label, category, agg, unit, sort) values
  ('chest_circumference', 'Borst', 'lichaam', 'avg', 'cm', 45),
  ('arm_circumference', 'Bovenarm', 'lichaam', 'avg', 'cm', 46),
  ('thigh_circumference', 'Dij', 'lichaam', 'avg', 'cm', 47),
  ('hip_circumference', 'Heup', 'lichaam', 'avg', 'cm', 48)
on conflict (metric) do nothing;

create or replace function app.do_log_entry(p_metric text, p_value double precision, p_ts timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ts timestamptz := date_trunc('second', coalesce(p_ts, now()));
  v_unit text;
begin
  v_unit := case p_metric
    when 'weight_body_mass' then 'kg' when 'body_fat_percentage' then '%'
    when 'dietary_water' then 'mL' when 'dietary_caffeine' then 'mg'
    when 'waist_circumference' then 'cm' when 'chest_circumference' then 'cm' when 'arm_circumference' then 'cm'
    when 'thigh_circumference' then 'cm' when 'hip_circumference' then 'cm' end;
  if v_unit is null then raise exception 'Onbekende meting: %', p_metric; end if;
  if p_value is null or p_value <= 0 or p_value > 10000 then raise exception 'Ongeldige waarde'; end if;
  insert into health.metric_samples (metric, ts, day, hour, qty, units, source)
  values (p_metric, v_ts, health.local_day(v_ts),
          extract(hour from v_ts at time zone 'Europe/Brussels')::smallint, p_value, v_unit, 'Health Hub')
  on conflict (metric, ts) do update set qty = excluded.qty, voided = false, source = 'Health Hub', inserted_at = now();
  return jsonb_build_object('metric', p_metric, 'ts', v_ts, 'value', p_value, 'unit', v_unit);
end $$;

create or replace view ai.body_measurements as
select s.day, s.metric, c.label, round(avg(s.qty)::numeric, 1) as value, c.unit
from health.metric_samples s join health.metric_catalog c on c.metric = s.metric
where not s.voided and s.metric in ('weight_body_mass', 'body_fat_percentage', 'lean_body_mass', 'waist_circumference',
  'chest_circumference', 'arm_circumference', 'thigh_circumference', 'hip_circumference')
group by s.day, s.metric, c.label, c.unit;
comment on view ai.body_measurements is 'Lichaamsmetingen per dag: gewicht, vetpercentage, vetvrije massa en omtrekken (taille, borst, bovenarm, dij, heup in cm).';
grant select on ai.body_measurements to ai_reader;

create or replace function public.get_measurements()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (select coalesce(jsonb_object_agg(x.metric, x.data), '{}'::jsonb) from (
    select metric, jsonb_build_object('label', min(label), 'unit', min(unit),
      'points', jsonb_agg(jsonb_build_object('day', day, 'value', value) order by day)) as data
    from ai.body_measurements where metric <> 'weight_body_mass' group by metric) x);
end $$;

-- ---------- gewoontes / supplementen ----------
create table if not exists app.habits (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  emoji      text,
  sort       int not null default 100,
  archived   boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists app.habit_log (
  habit_id uuid not null references app.habits(id),
  day      date not null,
  done     boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (habit_id, day)
);
alter table app.habits enable row level security;
alter table app.habit_log enable row level security;

create or replace function public.get_habits(p_day date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'name', h.name, 'emoji', h.emoji, 'sort', h.sort,
      'done', coalesce((select l.done from app.habit_log l where l.habit_id = h.id and l.day = p_day), false),
      -- reeks: aaneengesloten dagen tot en met gisteren (+ vandaag als al gedaan)
      'streak', (with recursive r(d) as (
                   select case when exists (select 1 from app.habit_log l where l.habit_id = h.id and l.day = p_day and l.done) then p_day else p_day - 1 end
                   union all
                   select r.d - 1 from r where exists (select 1 from app.habit_log l where l.habit_id = h.id and l.day = r.d and l.done) and r.d > p_day - 400)
                 select count(*) - 1 from r),
      'last7', (select count(*) from app.habit_log l where l.habit_id = h.id and l.done and l.day between p_day - 6 and p_day))
    order by h.sort, h.created_at), '[]'::jsonb)
    from app.habits h where not h.archived);
end $$;

create or replace function public.toggle_habit(p_id uuid, p_day date)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v boolean;
begin
  perform app.assert_owner();
  insert into app.habit_log as l (habit_id, day, done) values (p_id, p_day, true)
  on conflict (habit_id, day) do update set done = not l.done, updated_at = now()
  returning done into v;
  return v;
end $$;

-- p: {id?, name, emoji?, sort?, archived?}
create or replace function public.save_habit(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r app.habits;
begin
  perform app.assert_owner();
  if p->>'id' is not null then
    update app.habits set name = coalesce(nullif(btrim(p->>'name'), ''), name), emoji = coalesce(p->>'emoji', emoji),
      sort = coalesce((p->>'sort')::int, sort), archived = coalesce((p->>'archived')::boolean, archived)
    where id = (p->>'id')::uuid returning * into r;
  else
    if coalesce(btrim(p->>'name'), '') = '' then raise exception 'Naam ontbreekt'; end if;
    insert into app.habits (name, emoji, sort) values (btrim(p->>'name'), nullif(p->>'emoji', ''),
      coalesce((p->>'sort')::int, (select coalesce(max(sort), 0) + 10 from app.habits)))
    returning * into r;
  end if;
  return to_jsonb(r);
end $$;

create or replace view ai.habits_daily as
select l.day, h.name as habit, l.done
from app.habit_log l join app.habits h on h.id = l.habit_id
where not h.archived;
comment on view ai.habits_daily is 'Dagelijkse gewoontes/supplementen die de gebruiker afvinkt (bv. creatine, stretchen). done = true als afgevinkt; ontbrekende dag = niet gedaan.';
grant select on ai.habits_daily to ai_reader;

-- ---------- agenda: per dag wat er gelogd is ----------
create or replace function public.get_calendar(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  if p_to - p_from > 62 then raise exception 'Periode te lang'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'day', g.d,
      'kcal', s.kcal_in, 'steps', s.steps, 'weight', s.weight_kg, 'sleep_h', s.sleep_h,
      'strength', coalesce(s.strength_sessions, 0), 'cardio', coalesce(s.cardio_sessions, 0),
      'journal', exists (select 1 from app.journal j where j.day = g.d and coalesce(btrim(j.content), '') <> ''),
      'habits', (select count(*) from app.habit_log l join app.habits h on h.id = l.habit_id where l.day = g.d and l.done and not h.archived))
    order by g.d), '[]'::jsonb)
    from generate_series(p_from, p_to, interval '1 day') as g0(t)
    cross join lateral (select g0.t::date as d) g
    left join ai.daily_summary s on s.day = g.d);
end $$;

-- ---------- volledige export (back-up) ----------
create or replace function public.export_all()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return jsonb_build_object(
    'exported_at', now(),
    'app', 'Health Hub',
    'settings', (select jsonb_object_agg(key, value) from app.settings),
    'daily_summary', (select coalesce(jsonb_agg(to_jsonb(s) order by s.day), '[]') from ai.daily_summary s),
    'body_measurements', (select coalesce(jsonb_agg(to_jsonb(b) order by b.day), '[]') from ai.body_measurements b),
    'sleep', (select coalesce(jsonb_agg(to_jsonb(s)), '[]') from ai.sleep s),
    'cardio_workouts', (select coalesce(jsonb_agg(to_jsonb(w) order by w.start_local), '[]') from ai.workouts w),
    'strength_workouts', (select coalesce(jsonb_agg(to_jsonb(w) order by w.start_local), '[]') from ai.strength_workouts w),
    'strength_sets', (select coalesce(jsonb_agg(to_jsonb(s) order by s.day, s.workout_id, s.exercise_index, s.set_index), '[]') from ai.strength_sets s),
    'food_log', (select coalesce(jsonb_agg(to_jsonb(f) order by f.day, f.created_at), '[]') from app.food_log f where not f.voided),
    'foods', (select coalesce(jsonb_agg(to_jsonb(f)), '[]') from app.foods f where not f.archived),
    'meal_presets', (select coalesce(jsonb_agg(to_jsonb(m)), '[]') from app.meal_presets m where not m.archived),
    'workout_templates', (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from app.workout_templates t where not t.archived),
    'exercise_prefs', (select coalesce(jsonb_agg(to_jsonb(e)), '[]') from app.exercise_prefs e),
    'journal', (select coalesce(jsonb_agg(to_jsonb(j) order by j.day), '[]') from app.journal j),
    'habits', (select coalesce(jsonb_agg(to_jsonb(h)), '[]') from app.habits h),
    'habit_log', (select coalesce(jsonb_agg(to_jsonb(l) order by l.day), '[]') from app.habit_log l),
    'routines', (select coalesce(jsonb_agg(to_jsonb(r)), '[]') from app.routines r where not r.archived)
  );
end $$;

do $$
declare fn text;
begin
  foreach fn in array array['get_measurements()', 'get_habits(date)', 'toggle_habit(uuid,date)', 'save_habit(jsonb)',
    'get_calendar(date,date)', 'export_all()'] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
