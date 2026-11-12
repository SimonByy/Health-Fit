-- Eigen readiness-score (de Venu 3 heeft geen Training Readiness):
-- slaapscore 30 %, Body Battery bij opstaan 30 %, HRV t.o.v. 7-daags gemiddelde 25 %, rusthartslag t.o.v. 7-daags gemiddelde 15 %.
create or replace function public.get_readiness(p_day date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  d date := coalesce(p_day, (now() at time zone 'Europe/Brussels')::date);
  r record; hb numeric; rb numeric;
  s_sleep numeric; s_bb numeric; s_hrv numeric; s_rhr numeric;
  wsum numeric := 0; tot numeric := 0; score int;
begin
  perform app.assert_owner();
  select * into r from ai.recovery_daily where day = d;
  select avg(hrv_ms), avg(resting_hr) into hb, rb from ai.recovery_daily where day between d - 7 and d - 1;
  s_sleep := r.sleep_score;
  s_bb := r.body_battery_wake;
  if r.hrv_ms is not null and hb > 0 then s_hrv := greatest(0, least(100, 70 + (r.hrv_ms / hb - 1) * 200)); end if;
  if r.resting_hr is not null and rb > 0 then s_rhr := greatest(0, least(100, 75 - (r.resting_hr - rb) * 8)); end if;
  if s_sleep is not null then tot := tot + s_sleep * 0.30; wsum := wsum + 0.30; end if;
  if s_bb is not null then tot := tot + s_bb * 0.30; wsum := wsum + 0.30; end if;
  if s_hrv is not null then tot := tot + s_hrv * 0.25; wsum := wsum + 0.25; end if;
  if s_rhr is not null then tot := tot + s_rhr * 0.15; wsum := wsum + 0.15; end if;
  if wsum >= 0.3 then score := round(tot / wsum); end if;
  return jsonb_build_object(
    'day', d, 'score', score,
    'label', case when score is null then null when score >= 75 then 'Klaar voor zwaar werk' when score >= 50 then 'Normaal trainen' when score >= 30 then 'Rustig aan' else 'Herstel voorop' end,
    'sleep_score', r.sleep_score, 'hrv', r.hrv_ms, 'hrv_base', round(hb), 'rhr', r.resting_hr, 'rhr_base', round(rb, 1),
    'bb_wake', r.body_battery_wake, 'bb_high', r.body_battery_high, 'bb_low', r.body_battery_low, 'stress', r.stress_avg,
    'parts', jsonb_strip_nulls(jsonb_build_object('slaap', round(s_sleep), 'body_battery', round(s_bb), 'hrv', round(s_hrv), 'rusthartslag', round(s_rhr))));
end $$;
revoke all on function public.get_readiness(date) from public, anon;
grant execute on function public.get_readiness(date) to authenticated;
