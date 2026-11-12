-- Readiness en Body Battery live door de dag + Garmin-sync op verzoek (al toegepast als migratie "readiness_live")
create table if not exists app.sync_requests (
  id bigserial primary key,
  source text not null default 'garmin',
  created_at timestamptz not null default now(),
  done_at timestamptz,
  note text
);
alter table app.sync_requests enable row level security;

create or replace function public.request_garmin_sync()
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare r app.sync_requests;
begin
  perform app.assert_owner();
  select * into r from app.sync_requests where source = 'garmin' and done_at is null order by id desc limit 1;
  if r.id is null then insert into app.sync_requests (source) values ('garmin') returning * into r; end if;
  return to_jsonb(r);
end $function$;
grant execute on function public.request_garmin_sync() to authenticated;

create or replace function public.get_readiness(p_day date default null)
 returns jsonb language plpgsql stable security definer set search_path to ''
as $function$
declare
  tz text := 'Europe/Brussels';
  today date := (now() at time zone tz)::date;
  d date := coalesce(p_day, today);
  r record; hb numeric; rb numeric;
  s_sleep numeric; s_bb numeric; s_hrv numeric; s_rhr numeric;
  wsum numeric := 0; tot numeric := 0; score int; score_now int;
  base_level numeric; base_ts timestamptz; actual boolean := false;
  wake_ts timestamptz; bb_now numeric; drain numeric := 0; load_pts numeric := 0; hours numeric;
  str_min numeric; car_min numeric; sync jsonb;
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

  -- Startpunt voor vandaag: laatste echte meting, anders Body Battery bij opstaan
  wake_ts := (d + case when extract(isodow from d) >= 6 then time '09:30' else time '08:30' end) at time zone tz;
  select qty, ts into base_level, base_ts from health.metric_samples
    where metric = 'body_battery_now' and day = d and not coalesce(voided, false) order by ts desc limit 1;
  if base_level is not null then actual := true;
  else base_level := r.body_battery_wake; base_ts := wake_ts; end if;

  if base_level is not null then
    if d = today then
      hours := greatest(0, extract(epoch from (now() - greatest(base_ts, wake_ts))) / 3600);
      -- 's nachts (na 23u) niet verder rekenen
      hours := least(hours, greatest(0, extract(epoch from (((d + time '23:30') at time zone tz) - greatest(base_ts, wake_ts))) / 3600));
    else
      hours := greatest(0, extract(epoch from (((d + time '23:00') at time zone tz) - greatest(base_ts, wake_ts))) / 3600);
    end if;
    drain := hours * 2.5;
    select coalesce(sum(duration_min), 0) into str_min from ai.strength_workouts
      where day = d and (start_local::timestamp at time zone tz) > base_ts;
    select coalesce(sum(duration_min), 0) into car_min from ai.workouts
      where day = d and coalesce(lower(name), '') not like '%strength%' and coalesce(lower(name), '') not like '%kracht%';
    if actual then car_min := 0; end if; -- een echte meting bevat de cardio al
    drain := drain + str_min * 0.25 + car_min * 0.35;
    bb_now := greatest(5, least(100, round(base_level - drain)));
    -- trainingsbelasting van vandaag drukt de readiness ook
    load_pts := least(25, (select coalesce(sum(duration_min), 0) from ai.strength_workouts where day = d) * 0.15
                       + (select coalesce(sum(duration_min), 0) from ai.workouts where day = d) * 0.1);
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
    'bb_now', bb_now, 'bb_actual', actual, 'bb_base_ts', base_ts, 'drain', round(drain), 'load', round(load_pts),
    'sync', sync,
    'parts', jsonb_strip_nulls(jsonb_build_object('slaap', round(s_sleep), 'body_battery', round(s_bb), 'hrv', round(s_hrv), 'rusthartslag', round(s_rhr))));
end $function$;
