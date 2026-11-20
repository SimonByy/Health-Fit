-- 0078_profile_settings: instelling 'profile' (Instellingen → Profiel en hartslagzones), 'mealprep' lezen,
-- mp_set_auto() voor de schakelaar "Automatisch weekmenu" (laat je andere mealprep-regels ongemoeid),
-- en spierherstel volgens je profiel (snel 36 u, normaal 48 u, traag 60 u halfwaardetijd).
create or replace function public.get_setting(p_key text)
 returns jsonb language plpgsql stable security definer set search_path to ''
as $function$
begin
  perform app.assert_owner();
  if p_key not in ('layout', 'goals', 'briefing', 'tts_voice', 'training_prefs', 'ui', 'sleep', 'profile', 'mealprep') then raise exception 'Onbekende instelling'; end if;
  return (select value from app.settings where key = p_key);
end $function$;

create or replace function public.set_setting(p_key text, p_value jsonb)
 returns void language plpgsql security definer set search_path to ''
as $function$
begin
  perform app.assert_owner();
  if p_key not in ('goals', 'ai_model', 'meal_slots', 'layout', 'training_prefs', 'ui', 'sleep', 'profile') then
    raise exception 'Onbekende instelling %', p_key;
  end if;
  if p_key = 'ai_model' and not exists (select 1 from app.profiles where user_id = app.uid() and is_admin) then
    raise exception 'Alleen voor de beheerder';
  end if;
  if p_key = 'sleep' and (coalesce(p_value->>'wake_weekday', '07:00') !~ '^\d{2}:\d{2}$' or coalesce(p_value->>'wake_weekend', '09:00') !~ '^\d{2}:\d{2}$') then
    raise exception 'Ongeldig uur';
  end if;
  if length(p_value::text) > 20000 then raise exception 'Te groot'; end if;
  insert into app.settings(key, value, updated_at) values (p_key, p_value, now())
  on conflict (user_id, key) do update set value = excluded.value, updated_at = now();
end $function$;

create or replace function public.mp_set_auto(p_on boolean)
 returns void language plpgsql security definer set search_path to ''
as $function$
begin
  perform app.assert_owner();
  insert into app.settings(key, value, updated_at) values ('mealprep', jsonb_build_object('auto', p_on), now())
  on conflict (user_id, key) do update set value = coalesce(app.settings.value, '{}'::jsonb) || jsonb_build_object('auto', p_on), updated_at = now();
end $function$;
grant execute on function public.mp_set_auto(boolean) to authenticated;

-- spierherstel volgens profiel
create or replace function public.get_muscle_fatigue()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare hl numeric := case (select value->>'recovery' from app.settings where key = 'profile' and user_id = app.uid()) when 'snel' then 36 when 'traag' then 60 else 48 end;
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
    d as (select *, power(0.5, extract(epoch from (now() - ts)) / 3600 / hl) f from s),
    per_ex as (select m, workout_id, title, day, exercise, count(*) sets, sum(f) f from d group by 1,2,3,4,5),
    -- per training per spier: hoeveel sets en hoe lang geleden
    per_w as (select m, workout_id, count(*) sets, extract(epoch from (now() - max(ts))) / 3600 h from d group by 1,2),
    floor_m as (
      select m, max(case when sets >= 4 and h < hl / 2 then 55
                         when sets >= 2 and h < hl then 30 else 0 end) fl,
                max(case when sets >= 2 and h < hl then hl - h else 0 end) fl_h
      from per_w group by m),
    per_m as (select m, sum(f) f, sum(sets) sets, max(day) last_day from per_ex group by m),
    res as (
      select pm.*, greatest(least(100, round(pm.f * 100 / 6.0)), coalesce(fm.fl, 0))::int pct, coalesce(fm.fl_h, 0) fl_h
      from per_m pm left join floor_m fm using (m))
    select jsonb_agg(jsonb_build_object(
      'muscle', r.m, 'pct', r.pct, 'sets_7d', r.sets, 'last_day', r.last_day,
      'hours_since', round(extract(epoch from (now() - (select max(ts) from d where d.m = r.m))) / 3600),
      'ready_in_h', case when r.pct < 25 then 0 else ceil(greatest(r.fl_h,
        case when r.f * 100 / 6.0 > 25 then hl * ln(r.f * 100 / 6.0 / 25) / ln(2) else 0 end)) end,
      'why', (select jsonb_agg(jsonb_build_object('day', e.day, 'workout', e.title, 'exercise', e.exercise, 'sets', e.sets, 'share', round(e.f * 100 / 6.0)) order by e.day desc, e.f desc)
              from per_ex e where e.m = r.m)
    ) order by r.pct desc, r.f desc) from res r
  ), '[]'::jsonb);
end $function$;
