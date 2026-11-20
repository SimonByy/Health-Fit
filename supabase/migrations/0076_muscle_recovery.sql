-- 0076_muscle_recovery: realistischer herstel in get_muscle_fatigue.
-- Vroeger: halfwaardetijd 36 u en 8 sets = 100%, waardoor een spier met een paar sets na 1 dag al "klaar" stond.
-- Nu: halfwaardetijd 48 u, 6 harde sets = 100%, en een ondergrens: een spier die je hard trainde
-- (≥ 4 werksets in die training) is de eerste 24 u minstens "belast" (55%) en tot 48 u minstens "half belast" (30%);
-- met 2–3 sets tot 48 u minstens 30%. Geeft ook ready_in_h terug (uren tot onder 25%).
create or replace function public.get_muscle_fatigue()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
begin
  perform app.assert_owner();
  return coalesce((
    with s as (
      select ss.primary_muscle m, ss.exercise, ss.workout_id, ss.day, w.title,
        coalesce(w.start_ts, (ss.day + time '12:00') at time zone 'Europe/Brussels') ts
      from ai.strength_sets ss left join health.hevy_workouts w on w.id = ss.workout_id
      where ss.set_type <> 'warmup' and ss.day >= (now() at time zone 'Europe/Brussels')::date - 7
        and ss.primary_muscle not in ('cardio', 'other', 'full_body')
    ),
    d as (select *, power(0.5, extract(epoch from (now() - ts)) / 3600 / 48) f from s),
    per_ex as (select m, workout_id, title, day, exercise, count(*) sets, sum(f) f from d group by 1,2,3,4,5),
    -- per training per spier: hoeveel sets en hoe lang geleden
    per_w as (select m, workout_id, count(*) sets, extract(epoch from (now() - max(ts))) / 3600 h from d group by 1,2),
    floor_m as (
      select m, max(case when sets >= 4 and h < 24 then 55
                         when sets >= 2 and h < 48 then 30 else 0 end) fl,
                max(case when sets >= 2 and h < 48 then 48 - h else 0 end) fl_h
      from per_w group by m),
    per_m as (select m, sum(f) f, sum(sets) sets, max(day) last_day from per_ex group by m),
    res as (
      select pm.*, greatest(least(100, round(pm.f * 100 / 6.0)), coalesce(fm.fl, 0))::int pct, coalesce(fm.fl_h, 0) fl_h
      from per_m pm left join floor_m fm using (m))
    select jsonb_agg(jsonb_build_object(
      'muscle', r.m, 'pct', r.pct, 'sets_7d', r.sets, 'last_day', r.last_day,
      'hours_since', round(extract(epoch from (now() - (select max(ts) from d where d.m = r.m))) / 3600),
      'ready_in_h', case when r.pct < 25 then 0 else ceil(greatest(r.fl_h,
        case when r.f * 100 / 6.0 > 25 then 48 * ln(r.f * 100 / 6.0 / 25) / ln(2) else 0 end)) end,
      'why', (select jsonb_agg(jsonb_build_object('day', e.day, 'workout', e.title, 'exercise', e.exercise, 'sets', e.sets, 'share', round(e.f * 100 / 6.0)) order by e.day desc, e.f desc)
              from per_ex e where e.m = r.m)
    ) order by r.pct desc, r.f desc) from res r
  ), '[]'::jsonb);
end $function$;
