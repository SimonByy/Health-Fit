-- 0077_hr_profile: gemeten waarden voor je persoonlijke profiel (Instellingen → Profiel en hartslagzones).
-- rusthartslag = gemiddelde van de laatste 14 dagen; max_hr = hoogste gemeten hartslag in een training (laatste 12 maanden),
-- plus de top-3 om uitschieters (sensorfout) te kunnen herkennen; recent_weight = laatste gewicht.
create or replace function public.get_hr_profile()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare d0 date := (now() at time zone 'Europe/Brussels')::date;
begin
  perform app.assert_owner();
  return jsonb_build_object(
    'rhr_14d', (select round(avg(resting_hr)) from ai.daily_summary where day > d0 - 14 and resting_hr between 30 and 110),
    'rhr_days', (select count(*) from ai.daily_summary where day > d0 - 14 and resting_hr between 30 and 110),
    'max_hr', (select max(max_hr) from ai.workouts where day > d0 - 365 and max_hr between 100 and 230),
    'max_hr_top', (select coalesce(jsonb_agg(jsonb_build_object('day', day, 'name', name, 'hr', max_hr) order by max_hr desc), '[]'::jsonb)
                   from (select day, name, max_hr from ai.workouts where day > d0 - 365 and max_hr between 100 and 230 order by max_hr desc limit 3) t),
    'weight_kg', (select weight_kg from ai.daily_summary where weight_kg is not null order by day desc limit 1));
end $function$;
grant execute on function public.get_hr_profile() to authenticated;
