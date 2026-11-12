-- Overzichten voor de vernieuwde app: krachtprogressie en voedingsweek.

create or replace function public.get_strength_overview(p_weeks int default 12)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_from date := (current_date - (p_weeks * 7));
begin
  perform app.assert_owner();
  return jsonb_build_object(
    'weekly', (select coalesce(jsonb_agg(to_jsonb(w) order by w.week_start), '[]'::jsonb) from (
        select date_trunc('week', day)::date as week_start, count(*) as sessions,
               sum(working_sets) as working_sets, round(sum(volume_kg)) as volume_kg
        from ai.strength_workouts where day >= v_from group by 1) w),
    'lifts', (select coalesce(jsonb_agg(to_jsonb(l) order by l.recent desc, l.sessions desc), '[]'::jsonb) from (
        select s.exercise, max(s.primary_muscle) as muscle,
               count(distinct s.workout_id) as sessions,
               max(s.day) as last_day,
               count(distinct s.workout_id) filter (where s.day >= current_date - 28) as recent,
               (select jsonb_agg(jsonb_build_object('day', d.day, 'rm', d.rm, 'kg', d.kg, 'reps', d.reps) order by d.day)
                  from (select day, round(max(est_1rm_kg), 1) as rm, max(weight_kg) as kg,
                               (array_agg(reps order by weight_kg desc nulls last, reps desc))[1] as reps
                        from ai.strength_sets x
                        where x.exercise = s.exercise and x.set_type <> 'warmup' and x.day >= v_from
                        group by day) d) as series
        from ai.strength_sets s
        where s.set_type <> 'warmup' and s.day >= v_from
        group by s.exercise
        having count(distinct s.workout_id) >= 3) l),
    'recent', (select coalesce(jsonb_agg(to_jsonb(r) order by r.day desc), '[]'::jsonb) from (
        select id, day, title, duration_min, exercises, working_sets, round(volume_kg) as volume_kg
        from ai.strength_workouts order by day desc limit 12) r)
  );
end $$;

create or replace function public.get_food_week(p_days int default 7)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return jsonb_build_object(
    'goals', (select value from app.settings where key = 'goals'),
    'days', (select coalesce(jsonb_agg(jsonb_build_object(
                'day', g.day::date,
                'kcal', ds.kcal_in, 'protein', ds.protein_g, 'carbs', ds.carbs_g, 'fat', ds.fat_g) order by g.day), '[]'::jsonb)
             from generate_series(current_date - (p_days - 1), current_date, interval '1 day') g(day)
             left join ai.daily_summary ds on ds.day = g.day::date)
  );
end $$;

revoke all on function public.get_strength_overview(int) from public, anon;
revoke all on function public.get_food_week(int) from public, anon;
grant execute on function public.get_strength_overview(int) to authenticated;
grant execute on function public.get_food_week(int) to authenticated;
