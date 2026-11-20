-- 0079_strain_impacts: gegevens voor "Belasting" (strain, zoals Bevel/Whoop) en "Wat beïnvloedt je herstel".
-- get_load(p_days): per dag de trainingen (duur, gem./max hartslag), krachtsets en stappen. De strain zelf
--   rekent de app uit met jouw max- en rusthartslag (TRIMP volgens Banister).
-- get_impacts(p_days): per gewoonte of gedrag op dag D: gemiddelde HRV, rusthartslag en slaap de nacht erna (dag D+1),
--   met tegenover zonder. Alleen als er minstens 4 dagen met én 4 dagen zonder zijn.
create or replace function public.get_load(p_days int default 42)
 returns jsonb language plpgsql stable security definer set search_path to ''
as $function$
declare d0 date := (now() at time zone 'Europe/Brussels')::date; n int := least(greatest(coalesce(p_days, 42), 7), 120);
begin
  perform app.assert_owner();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'day', g.day,
      'steps', ds.steps, 'strength_sets', coalesce(ds.strength_sets, 0), 'strength_min', coalesce(ds.strength_min, 0),
      'workouts', (select coalesce(jsonb_agg(jsonb_build_object('name', w.name, 'min', w.duration_min, 'avg_hr', w.avg_hr, 'max_hr', w.max_hr, 'kcal', w.active_kcal)), '[]'::jsonb)
                   from ai.workouts w where w.day = g.day and not coalesce(w.duplicate_of_hevy, false))
    ) order by g.day)
    from generate_series(d0 - n + 1, d0, interval '1 day') as gs(t)
    cross join lateral (select gs.t::date as day) g
    left join ai.daily_summary ds on ds.day = g.day), '[]'::jsonb);
end $function$;
grant execute on function public.get_load(int) to authenticated;

create or replace function public.get_impacts(p_days int default 90)
 returns jsonb language plpgsql stable security definer set search_path to ''
as $function$
declare d0 date := (now() at time zone 'Europe/Brussels')::date; n int := least(greatest(coalesce(p_days, 90), 21), 365);
  kgoal numeric := (select nullif(value->>'kcal_in', '')::numeric from app.settings where key = 'goals' and user_id = app.uid());
begin
  perform app.assert_owner();
  return coalesce((
    with days as (
      select ds.day, ds.caffeine_mg, ds.steps, ds.strength_sets, ds.cardio_min, ds.kcal_in,
        nx.hrv_ms nhrv, nx.resting_hr nrhr, nx.sleep_h nsleep
      from ai.daily_summary ds join ai.daily_summary nx on nx.day = ds.day + 1
      where ds.day >= d0 - n and ds.day < d0 and (nx.hrv_ms is not null or nx.resting_hr is not null or nx.sleep_h is not null)),
    factors as (
      -- gewoontes (afgevinkt op dag D)
      select 'habit:' || h.id as key, coalesce(h.emoji || ' ', '') || h.name as label, d.day,
             exists (select 1 from app.habit_log l where l.habit_id = h.id and l.user_id = app.uid() and l.day = d.day and l.done) as yes
      from app.habits h cross join days d where h.user_id = app.uid() and not coalesce(h.archived, false)
      union all select 'cafeine', '☕ Meer dan 200 mg cafeïne', day, coalesce(caffeine_mg, 0) > 200 from days where caffeine_mg is not null
      union all select 'kracht', '🏋 Krachttraining', day, coalesce(strength_sets, 0) > 0 from days
      union all select 'cardio', '🏃 Cardio', day, coalesce(cardio_min, 0) >= 15 from days
      union all select 'stappen', '👟 10.000+ stappen', day, coalesce(steps, 0) >= 10000 from days where steps is not null
      union all select 'veel_eten', '🍽 Meer dan 10% boven je kcal-doel', day, kcal_in > kgoal * 1.1 from days where kcal_in > 500 and kgoal is not null
      union all select 'alcohol', '🍺 Alcohol (uit je dagboek)', d.day,
             exists (select 1 from app.journal j where j.user_id = app.uid() and j.day = d.day and j.content ~* '(alcohol|\mbier|\mpint|\mwijn|cocktail|wodka|vodka|whisky|\mgin\M|shotjes?|\mcava|prosecco|\mfuif|\mcantus)')
      from days d),
    agg as (
      select f.key, f.label,
        count(*) filter (where f.yes) n_yes, count(*) filter (where not f.yes) n_no,
        avg(d.nhrv) filter (where f.yes) hrv_yes, avg(d.nhrv) filter (where not f.yes) hrv_no,
        avg(d.nrhr) filter (where f.yes) rhr_yes, avg(d.nrhr) filter (where not f.yes) rhr_no,
        avg(d.nsleep) filter (where f.yes) sl_yes, avg(d.nsleep) filter (where not f.yes) sl_no
      from factors f join days d using (day) group by f.key, f.label)
    select jsonb_agg(jsonb_build_object('key', key, 'label', label, 'n_yes', n_yes, 'n_no', n_no,
      'hrv', round((hrv_yes - hrv_no)::numeric, 1), 'hrv_base', round(hrv_no::numeric, 1),
      'rhr', round((rhr_yes - rhr_no)::numeric, 1), 'rhr_base', round(rhr_no::numeric, 1),
      'sleep', round((sl_yes - sl_no)::numeric, 2), 'sleep_base', round(sl_no::numeric, 2)) order by abs(coalesce((hrv_yes - hrv_no) / nullif(hrv_no, 0), 0)) desc)
    from agg where n_yes >= 4 and n_no >= 4), '[]'::jsonb);
end $function$;
grant execute on function public.get_impacts(int) to authenticated;
