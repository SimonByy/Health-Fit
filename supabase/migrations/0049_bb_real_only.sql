-- Body Battery: alleen nog echte Garmin-metingen bewaren.
-- Voorheen schreef elke pull (elke 10 min) de laatste waarde uit de dagsamenvatting weg met tijdstip "nu",
-- ook als het horloge al uren niet gesynct had. Daardoor stond er 's middags nog 98 terwijl het horloge 54 gaf.
-- Nu: enkel de echte tijdreeks van Garmin, het tijdstip van de laatste horloge-sync wordt bewaard,
-- en vanaf de laatste meting schat de readiness verder met jouw eigen gemiddelde verbruik per uur.

-- 1) Nepmetingen van de laatste dagen ongeldig maken (de echte reeks komt bij de volgende pull terug)
update health.metric_samples set voided = true
where metric = 'body_battery_now' and ts > now() - interval '3 days' and not coalesce(voided, false);

-- 2) Reeks opslaan: een echte meting is altijd geldig
create or replace function public.internal_garmin_bb_series(p_series jsonb)
 returns int language plpgsql security definer set search_path to '' as $$
declare n int := 0; tz text := 'Europe/Brussels';
begin
  with pts as (
    select to_timestamp((e->>0)::numeric / 1000) ts, (e->>1)::numeric lvl
    from jsonb_array_elements(coalesce(p_series, '[]'::jsonb)) e
    where jsonb_typeof(e->0) = 'number' and jsonb_typeof(e->1) = 'number'),
  q as (
    select distinct on (date_trunc('hour', ts) + floor(extract(minute from ts) / 15) * interval '15 min')
      date_trunc('hour', ts) + floor(extract(minute from ts) / 15) * interval '15 min' as slot, ts, lvl
    from pts order by 1, ts desc)
  insert into health.metric_samples (metric, ts, day, hour, qty, units, source)
  select 'body_battery_now', slot, (slot at time zone tz)::date, extract(hour from slot at time zone tz)::smallint, lvl, '%', 'Garmin' from q
  on conflict (metric, ts) do update set qty = excluded.qty, voided = false;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.internal_garmin_bb_series(jsonb) from public, anon, authenticated;

-- 3) Pull verwerken: geen "nu"-metingen meer; laatste horloge-sync bijhouden
drop function if exists public.internal_garmin_pull_ingest(jsonb, numeric, text[]);
create or replace function public.internal_garmin_pull_ingest(p_raw jsonb, p_bb_now numeric, p_errors text[], p_watch_sync timestamptz default null)
 returns jsonb language plpgsql security definer set search_path to '' as $$
declare h text := md5(p_raw::text); prev text; res jsonb; changed boolean;
begin
  select hash into prev from app.garmin_pull_log order by id desc limit 1;
  changed := prev is distinct from h;
  if changed then
    res := health.ingest_garmin_raw(p_raw);
    insert into app.garmin_pull_log(hash, errors) values (h, p_errors);
    delete from app.garmin_pull_log where at < now() - interval '7 days';
  end if;
  if p_watch_sync is not null then
    insert into app.sync_state(source, last_run, last_success, last_error) values ('garmin_watch', now(), p_watch_sync, null)
    on conflict (source) do update set last_run = now(), last_success = excluded.last_success;
  end if;
  insert into app.sync_state(source, last_run, last_success, last_error)
  values ('garmin', now(), now(), nullif(array_to_string(p_errors, ' | '), ''))
  on conflict (source) do update set last_run = now(), last_success = now(), last_error = excluded.last_error;
  update app.sync_requests set done_at = now(), note = 'garmin-pull' where source = 'garmin' and done_at is null;
  return jsonb_build_object('changed', changed, 'result', res, 'watch_sync', p_watch_sync);
end $$;
revoke all on function public.internal_garmin_pull_ingest(jsonb, numeric, text[], timestamptz) from public, anon, authenticated;
grant execute on function public.internal_garmin_pull_ingest(jsonb, numeric, text[], timestamptz) to service_role;

-- 4) Jouw eigen verbruik per wakker uur (laatste 7 dagen, 10u–20u), begrensd tussen 1,5 en 9 per uur
create or replace function app.bb_drain_rate(p_day date)
 returns numeric language sql stable security definer set search_path to '' as $$
  with s as (
    select day, ts at time zone 'Europe/Brussels' lt, qty from health.metric_samples
    where metric = 'body_battery_now' and not coalesce(voided, false) and day between p_day - 7 and p_day - 1),
  d as (
    select day,
      (select qty from s s2 where s2.day = s.day and s2.lt::time between '09:30' and '11:00' order by s2.lt limit 1) a,
      (select lt  from s s2 where s2.day = s.day and s2.lt::time between '09:30' and '11:00' order by s2.lt limit 1) at_,
      (select qty from s s2 where s2.day = s.day and s2.lt::time between '19:00' and '21:00' order by s2.lt desc limit 1) b,
      (select lt  from s s2 where s2.day = s.day and s2.lt::time between '19:00' and '21:00' order by s2.lt desc limit 1) bt
    from s group by day)
  select greatest(1.5, least(9, round(avg((a - b) / nullif(extract(epoch from bt - at_) / 3600, 0))::numeric, 1)))
  from d where a is not null and b is not null and a > b;
$$;

-- 5) Readiness: verder schatten met jouw eigen verbruik; cardio ná de laatste meting telt mee; laatste horloge-sync tonen
create or replace function public.get_readiness(p_day date default null)
 returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare
  tz text := 'Europe/Brussels';
  today date := (now() at time zone tz)::date;
  d date := coalesce(p_day, today);
  r record; hb numeric; rb numeric;
  s_sleep numeric; s_bb numeric; s_hrv numeric; s_rhr numeric;
  wsum numeric := 0; tot numeric := 0; score int; score_now int;
  base_level numeric; base_ts timestamptz; actual boolean := false;
  wake_ts timestamptz; bb_now numeric; drain numeric := 0; load_pts numeric := 0; hours numeric;
  str_min numeric; car_min numeric; sync jsonb; rate numeric; watch timestamptz;
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

  rate := coalesce(app.bb_drain_rate(d), 2.5);
  select last_success into watch from app.sync_state where source = 'garmin_watch';

  -- Startpunt: laatste echte meting van het horloge, anders Body Battery bij opstaan
  wake_ts := (d + case when extract(isodow from d) >= 6 then time '09:30' else time '08:30' end) at time zone tz;
  select qty, ts into base_level, base_ts from health.metric_samples
    where metric = 'body_battery_now' and day = d and not coalesce(voided, false) order by ts desc limit 1;
  if base_level is not null then actual := true;
  else base_level := r.body_battery_wake; base_ts := wake_ts; end if;

  if base_level is not null then
    if d = today then
      hours := greatest(0, extract(epoch from (now() - greatest(base_ts, wake_ts))) / 3600);
      hours := least(hours, greatest(0, extract(epoch from (((d + time '23:30') at time zone tz) - greatest(base_ts, wake_ts))) / 3600));
    else
      hours := greatest(0, extract(epoch from (((d + time '23:00') at time zone tz) - greatest(base_ts, wake_ts))) / 3600);
    end if;
    drain := hours * rate;
    -- trainingen ná de laatste meting zitten nog niet in de meting
    select coalesce(sum(duration_min), 0) into str_min from ai.strength_workouts
      where day = d and (start_local::timestamp at time zone tz) > base_ts;
    select coalesce(sum(duration_min), 0) into car_min from ai.workouts
      where day = d and not coalesce(duplicate_of_hevy, false) and (start_local::timestamp at time zone tz) > base_ts
        and coalesce(lower(name), '') not like '%strength%' and coalesce(lower(name), '') not like '%kracht%';
    drain := drain + str_min * 0.25 + car_min * 0.35;
    bb_now := greatest(5, least(100, round(base_level - drain)));
    load_pts := least(25, (select coalesce(sum(duration_min), 0) from ai.strength_workouts where day = d) * 0.15
                       + (select coalesce(sum(duration_min), 0) from ai.workouts where day = d and not coalesce(duplicate_of_hevy, false)) * 0.1);
    if score is not null then
      score_now := round(((tot - coalesce(s_bb, 0) * 0.30) + case when s_bb is not null then bb_now * 0.30 else 0 end) / wsum - load_pts);
      score_now := greatest(1, least(100, score_now));
    end if;
  end if;

  select jsonb_build_object('last_success', last_success,
    'pending', exists (select 1 from app.sync_requests q where q.source = 'garmin' and q.done_at is null),
    'requested_at', (select max(created_at) from app.sync_requests q where q.source = 'garmin' and q.done_at is null))
    into sync from app.sync_state where source = 'garmin';

  return jsonb_build_object(
    'day', d, 'score', score, 'score_now', coalesce(score_now, score),
    'label', case when coalesce(score_now, score) is null then null when coalesce(score_now, score) >= 75 then 'Klaar voor zwaar werk'
                  when coalesce(score_now, score) >= 50 then 'Normaal trainen' when coalesce(score_now, score) >= 30 then 'Rustig aan' else 'Herstel voorop' end,
    'sleep_score', r.sleep_score, 'hrv', r.hrv_ms, 'hrv_base', round(hb), 'rhr', r.resting_hr, 'rhr_base', round(rb, 1),
    'bb_wake', r.body_battery_wake, 'bb_high', r.body_battery_high, 'bb_low', r.body_battery_low, 'stress', r.stress_avg,
    'bb_now', bb_now, 'bb_actual', actual, 'bb_base_ts', base_ts, 'bb_base', base_level, 'bb_rate', rate,
    'drain', round(drain), 'load', round(load_pts), 'watch_sync', watch,
    'sync', sync,
    'parts', jsonb_strip_nulls(jsonb_build_object('slaap', round(s_sleep), 'body_battery', round(s_bb), 'hrv', round(s_hrv), 'rusthartslag', round(s_rhr))));
end $function$;
