-- Geselecteerde voeding kopiëren naar een andere dag/maaltijd
create or replace function public.copy_food_items(p_ids uuid[], p_day date, p_meal text default null)
 returns jsonb language plpgsql security definer set search_path to ''
as $$
declare f app.food_log; ids jsonb := '[]'; r jsonb;
begin
  perform app.assert_owner();
  for f in select * from app.food_log where id = any(p_ids) and not voided order by created_at loop
    r := app.relog(f, p_day, coalesce(nullif(p_meal, ''), f.meal));
    ids := ids || jsonb_build_array(r->>'id');
  end loop;
  return ids;
end $$;
revoke all on function public.copy_food_items(uuid[], date, text) from public, anon;
grant execute on function public.copy_food_items(uuid[], date, text) to authenticated;

-- Vaak samen gegeten: combinaties van minstens 2 producten die je minstens 2 keer samen at bij dezelfde maaltijd
create or replace function public.get_meal_combos(p_days int default 60)
 returns jsonb language plpgsql stable security definer set search_path to ''
as $$
begin
  perform app.assert_owner();
  return coalesce((
    with meals as (
      select day, meal, array_agg(distinct lower(name) order by lower(name)) as sig,
             array_agg(name order by created_at) as names,
             round(sum(kcal)) as kcal, round(sum(protein)) as protein, count(*) as n
      from app.food_log
      where not voided and day >= (now() at time zone 'Europe/Brussels')::date - p_days
      group by day, meal
      having count(distinct lower(name)) between 2 and 8
    ), g as (
      select sig, count(*) as times, max(day) as last_day,
             (array_agg(meal order by day desc))[1] as meal,
             (array_agg(names order by day desc))[1] as names,
             (array_agg(kcal order by day desc))[1] as kcal,
             (array_agg(protein order by day desc))[1] as protein
      from meals group by sig having count(*) >= 2
    )
    select jsonb_agg(jsonb_build_object('times', times, 'last_day', last_day, 'meal', meal, 'names', to_jsonb(names), 'kcal', kcal, 'protein', protein)
                     order by times desc, last_day desc)
    from (select * from g order by times desc, last_day desc limit 12) x), '[]'::jsonb);
end $$;
revoke all on function public.get_meal_combos(int) from public, anon;
grant execute on function public.get_meal_combos(int) to authenticated;

-- Tijdlijn van een dag: ontwaken, maaltijden, trainingen, slapen
create or replace function public.get_day_timeline(p_day date default null)
 returns jsonb language plpgsql stable security definer set search_path to ''
as $$
declare
  tz text := 'Europe/Brussels';
  d date := coalesce(p_day, (now() at time zone tz)::date);
  ev jsonb := '[]'; s record; bed time;
begin
  perform app.assert_owner();
  -- ontwaken (nacht die eindigt op d)
  select * into s from ai.sleep where day = d order by total_h desc nulls last limit 1;
  if s.sleep_end_local is not null then
    ev := ev || jsonb_build_array(jsonb_build_object('kind', 'wake', 'at', s.sleep_end_local, 'title', 'Ontwaakt',
      'sub', round(s.total_h::numeric, 1) || ' u geslapen'));
  end if;
  -- maaltijden: eerste moment van loggen per maaltijd
  ev := ev || coalesce((select jsonb_agg(jsonb_build_object('kind', 'food', 'at', m.at, 'meal', m.meal, 'title', m.meal,
      'kcal', m.kcal, 'protein', m.protein, 'carbs', m.carbs, 'fat', m.fat, 'sub', m.names))
    from (select f.meal, (min(f.created_at) at time zone tz) as at, round(sum(f.kcal)) as kcal, round(sum(f.protein)) as protein,
                 round(sum(f.carbs)) as carbs, round(sum(f.fat)) as fat, string_agg(f.name, ', ' order by f.created_at) as names
          from app.food_log f where f.day = d and not f.voided group by f.meal) m), '[]'::jsonb);
  -- trainingen
  ev := ev || coalesce((select jsonb_agg(jsonb_build_object('kind', 'workout', 'at', w.start_local, 'title', w.name,
      'end', w.start_local + make_interval(secs => coalesce(w.duration_min, 0) * 60),
      'sub', concat_ws(' · ', round(w.duration_min) || ' min', case when w.distance_km > 0 then round(w.distance_km, 2) || ' km' end,
                       case when w.avg_hr is not null then 'gem. ' || round(w.avg_hr) || ' bpm' end)))
    from ai.workouts w where w.day = d and not coalesce(w.duplicate_of_hevy, false)), '[]'::jsonb);
  ev := ev || coalesce((select jsonb_agg(jsonb_build_object('kind', 'workout', 'at', w.start_local, 'title', w.title,
      'end', w.start_local + make_interval(secs => coalesce(w.duration_min, 0) * 60),
      'sub', concat_ws(' · ', round(w.duration_min) || ' min', w.working_sets || ' werksets')))
    from ai.strength_workouts w where w.day = d), '[]'::jsonb);
  -- geplande coach-sessies die nog niet gedaan zijn
  ev := ev || coalesce((select jsonb_agg(jsonb_build_object('kind', 'plan', 'at', (d + c.start_local), 'title', c.title,
      'sub', 'gepland'))
    from app.coach_sessions c where c.day = d and c.status = 'gepland' and c.start_local is not null), '[]'::jsonb);
  -- slapen: de nacht die op d begint, anders je gemiddelde bedtijd (gepland)
  select * into s from ai.sleep where day = d + 1 order by total_h desc nulls last limit 1;
  if s.sleep_start_local is not null and s.sleep_start_local::date <= d + 1 then
    ev := ev || jsonb_build_array(jsonb_build_object('kind', 'sleep', 'at', s.sleep_start_local, 'title', 'Gaan slapen',
      'sub', round(s.total_h::numeric, 1) || ' u geslapen'));
  else
    select (time '00:00' + make_interval(secs => round(avg(
             extract(epoch from (x.sleep_start_local::time)) + case when x.sleep_start_local::time < time '12:00' then 86400 else 0 end))::int % 86400))
      into bed
    from ai.sleep x where x.day between d - 7 and d and x.total_h >= 3;
    if bed is not null then
      ev := ev || jsonb_build_array(jsonb_build_object('kind', 'sleep', 'planned', true,
        'at', (case when bed < time '12:00' then d + 1 else d end) + bed, 'title', 'Slapen',
        'sub', 'je gemiddelde bedtijd van de laatste week'));
    end if;
  end if;
  return jsonb_build_object('day', d, 'events',
    coalesce((select jsonb_agg(e order by (e->>'at')::timestamp) from jsonb_array_elements(ev) e), '[]'::jsonb));
end $$;
revoke all on function public.get_day_timeline(date) from public, anon;
grant execute on function public.get_day_timeline(date) to authenticated;
