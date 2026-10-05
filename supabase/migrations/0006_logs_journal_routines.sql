-- =====================================================================
-- 0006: handmatige metingen, dagboek, routines + pushmeldingen,
--       inzichten (weekoverzicht), Hevy CSV-import
-- Verwijderen gebeurt via soft delete (voided/archived).
-- De private VAPID-sleutel staat in Vault als 'vapid_keys' (niet in deze repo).
-- =====================================================================

-- ---------- handmatige metingen ----------
alter table health.metric_samples add column if not exists voided boolean not null default false;

create or replace view ai.daily_metrics as
select s.day,
  s.metric,
  coalesce(c.label, s.metric) as label,
  coalesce(c.category, 'overig') as category,
  case coalesce(c.agg, 'avg')
    when 'sum' then sum(s.qty)
    when 'max' then max(coalesce(s.max, s.qty))
    when 'min' then min(coalesce(s.min, s.qty))
    else avg(coalesce(s.avg, s.qty))
  end as value,
  min(coalesce(s.min, s.qty)) as min_value,
  max(coalesce(s.max, s.qty)) as max_value,
  max(s.units) as unit
from health.metric_samples s
left join health.metric_catalog c on c.metric = s.metric
where not s.voided
group by s.day, s.metric, c.label, c.category, c.agg;

create or replace view ai.nutrition_by_meal as
select s.day,
  case when s.hour < 4 then 'Laat' else health.meal_slot(s.hour) end as meal,
  min(s.hour) as first_hour,
  round(sum(s.qty) filter (where s.metric = 'dietary_energy')::numeric, 0) as kcal,
  round(sum(s.qty) filter (where s.metric = 'protein')::numeric, 1) as protein_g,
  round(sum(s.qty) filter (where s.metric = 'carbohydrates')::numeric, 1) as carbs_g,
  round(sum(s.qty) filter (where s.metric = 'total_fat')::numeric, 1) as fat_g,
  round(sum(s.qty) filter (where s.metric = 'fiber')::numeric, 1) as fiber_g,
  round(sum(s.qty) filter (where s.metric = 'dietary_sugar')::numeric, 1) as sugar_g
from health.metric_samples s
join health.metric_catalog c on c.metric = s.metric and c.category = 'voeding'
where not s.voided and s.metric not in ('dietary_water', 'dietary_caffeine')
group by s.day, 2;

create or replace function app.do_log_entry(p_metric text, p_value double precision, p_ts timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_ts timestamptz := date_trunc('second', coalesce(p_ts, now()));
  v_unit text;
begin
  v_unit := case p_metric
    when 'weight_body_mass' then 'kg' when 'body_fat_percentage' then '%'
    when 'dietary_water' then 'mL' when 'dietary_caffeine' then 'mg' end;
  if v_unit is null then raise exception 'Onbekende meting: %', p_metric; end if;
  if p_value is null or p_value <= 0 or p_value > 10000 then raise exception 'Ongeldige waarde'; end if;
  insert into health.metric_samples (metric, ts, day, hour, qty, units, source)
  values (p_metric, v_ts, health.local_day(v_ts),
          extract(hour from v_ts at time zone 'Europe/Brussels')::smallint, p_value, v_unit, 'Health Hub')
  on conflict (metric, ts) do update set qty = excluded.qty, voided = false, source = 'Health Hub', inserted_at = now();
  return jsonb_build_object('metric', p_metric, 'ts', v_ts, 'value', p_value, 'unit', v_unit);
end $$;

create or replace function public.log_entry(p_metric text, p_value double precision, p_ts timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return app.do_log_entry(p_metric, p_value, p_ts);
end $$;

create or replace function public.void_entry(p_metric text, p_ts timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  update health.metric_samples set voided = true
  where metric = p_metric and ts = p_ts and source = 'Health Hub';
end $$;

create or replace function public.internal_log_entry(p_metric text, p_value double precision, p_ts timestamptz default null)
returns jsonb language sql security definer set search_path = '' as $$
  select app.do_log_entry(p_metric, p_value, p_ts);
$$;

-- daily_summary: cafeïne toegevoegd (nieuwe kolom achteraan)
create or replace view ai.daily_summary as
with m as (
  select day,
    max(value) filter (where metric = 'step_count') as steps,
    max(value) filter (where metric = 'active_energy') as active_kcal,
    max(value) filter (where metric = 'basal_energy_burned') as resting_kcal,
    max(value) filter (where metric = 'walking_running_distance') as walk_run_km,
    max(value) filter (where metric = 'apple_exercise_time') as exercise_min,
    max(value) filter (where metric = 'flights_climbed') as flights,
    max(value) filter (where metric = 'resting_heart_rate') as resting_hr,
    max(value) filter (where metric = 'heart_rate_variability') as hrv_ms,
    max(value) filter (where metric = 'vo2_max') as vo2max,
    max(value) filter (where metric = 'respiratory_rate') as resp_rate,
    max(value) filter (where metric = 'weight_body_mass') as weight_kg,
    max(value) filter (where metric = 'body_fat_percentage') as body_fat_pct,
    max(value) filter (where metric = 'dietary_energy') as kcal_in,
    max(value) filter (where metric = 'protein') as protein_g,
    max(value) filter (where metric = 'carbohydrates') as carbs_g,
    max(value) filter (where metric = 'total_fat') as fat_g,
    max(value) filter (where metric = 'fiber') as fiber_g,
    max(value) filter (where metric = 'dietary_sugar') as sugar_g,
    max(value) filter (where metric = 'sodium') as sodium_mg,
    max(value) filter (where metric = 'dietary_water') as water_ml,
    max(value) filter (where metric = 'dietary_caffeine') as caffeine_mg
  from ai.daily_metrics group by day
),
st as (
  select day, count(*) as strength_sessions, sum(volume_kg) as strength_volume_kg,
         sum(working_sets) as strength_sets, sum(duration_min) as strength_min
  from ai.strength_workouts group by day
),
wk as (
  select day, count(*) as cardio_sessions, sum(duration_min) as cardio_min,
         sum(distance_km) as cardio_km, sum(active_kcal) as cardio_kcal
  from ai.workouts where not duplicate_of_hevy group by day
),
days as (
  select day from m union select day from ai.sleep union select day from st union select day from wk
)
select d.day,
  extract(isodow from d.day)::int as weekday,
  round(m.steps::numeric, 0) as steps,
  round(m.active_kcal::numeric, 0) as active_kcal,
  round(m.resting_kcal::numeric, 0) as resting_kcal,
  round((coalesce(m.active_kcal,0) + coalesce(m.resting_kcal,0))::numeric, 0) as total_kcal_out,
  round(m.walk_run_km::numeric, 2) as walk_run_km,
  round(m.exercise_min::numeric, 0) as exercise_min,
  round(m.flights::numeric, 0) as flights,
  round(m.resting_hr::numeric, 0) as resting_hr,
  round(m.hrv_ms::numeric, 0) as hrv_ms,
  round(m.vo2max::numeric, 1) as vo2max,
  round(m.resp_rate::numeric, 1) as resp_rate,
  round(m.weight_kg::numeric, 1) as weight_kg,
  round(m.body_fat_pct::numeric, 1) as body_fat_pct,
  sl.total_h as sleep_h, sl.deep_h as deep_sleep_h, sl.rem_h as rem_sleep_h,
  round(m.kcal_in::numeric, 0) as kcal_in,
  round(m.protein_g::numeric, 0) as protein_g,
  round(m.carbs_g::numeric, 0) as carbs_g,
  round(m.fat_g::numeric, 0) as fat_g,
  round(m.fiber_g::numeric, 0) as fiber_g,
  round(m.sugar_g::numeric, 0) as sugar_g,
  round(m.sodium_mg::numeric, 0) as sodium_mg,
  round(m.water_ml::numeric, 0) as water_ml,
  coalesce(st.strength_sessions, 0) as strength_sessions,
  st.strength_sets, st.strength_volume_kg, st.strength_min,
  coalesce(wk.cardio_sessions, 0) as cardio_sessions,
  wk.cardio_min, wk.cardio_km, wk.cardio_kcal,
  round(m.caffeine_mg::numeric, 0) as caffeine_mg
from days d
left join m on m.day = d.day
left join ai.sleep sl on sl.day = d.day
left join st on st.day = d.day
left join wk on wk.day = d.day;
comment on view ai.daily_summary is 'HOOFDVIEW: één rij per dag met activiteit, hart, lichaam, slaap (nacht die eindigde op die dag), voeding-totalen, water, cafeïne, krachttraining (Hevy) en cardio. weekday: 1=maandag..7=zondag. Lege waarde = geen data.';

-- ---------- dagboek ----------
create table if not exists app.journal (
  day        date primary key,
  content    text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table app.journal enable row level security;

create or replace function public.save_journal(p_day date, p_text text, p_append boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r app.journal;
begin
  perform app.assert_owner();
  insert into app.journal as j (day, content) values (p_day, coalesce(btrim(p_text), ''))
  on conflict (day) do update set
    content = case when p_append and j.content <> ''
                   then j.content || E'\n\n' || coalesce(btrim(p_text), '')
                   else coalesce(btrim(p_text), '') end,
    updated_at = now()
  returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.get_journal(p_limit int default 60)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (select coalesce(jsonb_agg(to_jsonb(j) order by j.day desc), '[]'::jsonb)
          from (select * from app.journal where content <> '' order by day desc limit p_limit) j);
end $$;

create or replace view ai.journal as
select day, extract(isodow from day)::int as weekday, content
from app.journal where content <> '';
comment on view ai.journal is 'Dagboek: wat Simon elke avond vertelt over zijn dag (vrije tekst). Gebruik voor context over hoe hij zich voelde, stress, energie.';
grant select on ai.journal to ai_reader;

-- ---------- routines (meldingen) ----------
create table if not exists app.routines (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  body          text,
  kind          text not null default 'notify' check (kind in ('notify', 'weekly_review')),
  days          int[] not null default '{1,2,3,4,5,6,7}',
  time_local    time not null,
  url           text not null default '/#/vandaag',
  active        boolean not null default true,
  archived      boolean not null default false,
  last_fired_at timestamptz,
  created_by    text not null default 'user',
  created_at    timestamptz not null default now()
);
alter table app.routines enable row level security;

create or replace function app.do_save_routine(p jsonb, p_by text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_days int[];
  v_time time;
  r app.routines;
begin
  v_days := case when jsonb_typeof(p->'days') = 'array'
                 then array(select jsonb_array_elements_text(p->'days')::int)
                 else '{1,2,3,4,5,6,7}'::int[] end;
  if exists (select 1 from unnest(v_days) d where d < 1 or d > 7) or cardinality(v_days) = 0 then
    raise exception 'days moet getallen 1 (maandag) t.e.m. 7 (zondag) bevatten';
  end if;
  v_time := (p->>'time')::time;
  if p->>'id' is null then
    if coalesce(btrim(p->>'title'), '') = '' or v_time is null then
      raise exception 'title en time zijn verplicht';
    end if;
    insert into app.routines (title, body, kind, days, time_local, url, active, created_by)
    values (btrim(p->>'title'), p->>'body', coalesce(p->>'kind', 'notify'), v_days, v_time,
            coalesce(p->>'url', '/#/vandaag'), coalesce((p->>'active')::boolean, true), p_by)
    returning * into r;
  else
    update app.routines set
      title = coalesce(nullif(btrim(p->>'title'), ''), title),
      body = coalesce(p->>'body', body),
      kind = coalesce(p->>'kind', kind),
      days = case when jsonb_typeof(p->'days') = 'array' then v_days else days end,
      time_local = coalesce(v_time, time_local),
      url = coalesce(p->>'url', url),
      active = coalesce((p->>'active')::boolean, active),
      archived = coalesce((p->>'archived')::boolean, archived)
    where id = (p->>'id')::uuid
    returning * into r;
    if r.id is null then raise exception 'Routine niet gevonden'; end if;
  end if;
  return to_jsonb(r);
end $$;

create or replace function public.save_routine(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return app.do_save_routine(p, 'user');
end $$;

create or replace function public.get_routines()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (select coalesce(jsonb_agg(to_jsonb(r) order by r.time_local, r.title), '[]'::jsonb)
          from app.routines r where not r.archived);
end $$;

create or replace function public.internal_save_routine(p jsonb)
returns jsonb language sql security definer set search_path = '' as $$
  select app.do_save_routine(p, 'ai');
$$;

create or replace function public.internal_list_routines()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(r) order by r.time_local), '[]'::jsonb)
  from app.routines r where not r.archived;
$$;

-- Routines die nu moeten afgaan (venster van 30 min), en meteen als verstuurd markeren
create or replace function public.internal_claim_due_routines()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare res jsonb; t timestamp := now() at time zone 'Europe/Brussels';
begin
  with due as (
    update app.routines r set last_fired_at = now()
    where r.active and not r.archived
      and extract(isodow from t)::int = any(r.days)
      and t::time >= r.time_local
      and t::time < r.time_local + interval '30 minutes'
      and (r.last_fired_at is null or (r.last_fired_at at time zone 'Europe/Brussels')::date < t::date)
    returning r.*
  )
  select coalesce(jsonb_agg(to_jsonb(due)), '[]'::jsonb) into res from due;
  return res;
end $$;

-- ---------- push-abonnementen ----------
create table if not exists app.push_subscriptions (
  endpoint   text primary key,
  sub        jsonb not null,
  active     boolean not null default true,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok    timestamptz,
  last_error text
);
alter table app.push_subscriptions enable row level security;

create or replace function public.save_push_subscription(p jsonb, p_ua text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  if p->>'endpoint' is null then raise exception 'Ongeldig abonnement'; end if;
  insert into app.push_subscriptions (endpoint, sub, user_agent) values (p->>'endpoint', p, p_ua)
  on conflict (endpoint) do update set sub = excluded.sub, active = true, user_agent = excluded.user_agent, last_error = null;
end $$;

create or replace function public.internal_push_targets()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(sub), '[]'::jsonb) from app.push_subscriptions where active;
$$;

create or replace function public.internal_push_result(p_endpoint text, p_ok boolean, p_gone boolean, p_error text)
returns void language sql security definer set search_path = '' as $$
  update app.push_subscriptions set
    last_ok = case when p_ok then now() else last_ok end,
    last_error = case when p_ok then null else p_error end,
    active = case when p_gone then false else active end
  where endpoint = p_endpoint;
$$;

-- ---------- inzichten (weekoverzicht) ----------
create table if not exists app.insights (
  id         bigserial primary key,
  kind       text not null,
  title      text not null,
  content    text not null,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
alter table app.insights enable row level security;

create or replace function public.internal_add_insight(p_kind text, p_title text, p_content text)
returns bigint language sql security definer set search_path = '' as $$
  insert into app.insights (kind, title, content) values (p_kind, p_title, p_content) returning id;
$$;

create or replace function public.get_insights(p_limit int default 10)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (select coalesce(jsonb_agg(to_jsonb(i) order by i.id desc), '[]'::jsonb)
          from (select * from app.insights order by id desc limit p_limit) i);
end $$;

create or replace function public.mark_insight_read(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  update app.insights set read_at = now() where id = p_id and read_at is null;
end $$;

-- ---------- Hevy CSV-import (zonder Hevy Pro) ----------
create or replace function public.import_hevy_workouts(p jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform app.assert_owner();
  n := public.hevy_upsert_workouts(p);
  insert into app.sync_state(source, last_run, last_success, last_items, last_error)
  values ('hevy_csv', now(), now(), n, null)
  on conflict (source) do update set last_run = now(), last_success = now(), last_items = n, last_error = null;
  insert into app.ingest_log(source, stats) values ('hevy_csv', jsonb_build_object('workouts', n));
  return n;
end $$;

-- ---------- dashboard uitgebreid ----------
create or replace function public.get_dashboard(p_day date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  d date := coalesce(p_day, (now() at time zone 'Europe/Brussels')::date);
  res jsonb;
begin
  perform app.assert_owner();
  select jsonb_build_object(
    'day', d,
    'today', (select to_jsonb(s) from ai.daily_summary s where s.day = d),
    'avg7', (select jsonb_build_object(
        'steps', round(avg(steps)), 'sleep_h', round(avg(sleep_h), 2),
        'resting_hr', round(avg(resting_hr)), 'hrv_ms', round(avg(hrv_ms)),
        'kcal_in', round(avg(kcal_in)), 'protein_g', round(avg(protein_g)),
        'active_kcal', round(avg(active_kcal)), 'weight_kg', round(avg(weight_kg), 1),
        'water_ml', round(avg(water_ml)), 'caffeine_mg', round(avg(caffeine_mg)))
      from ai.daily_summary s where s.day between d - 7 and d - 1),
    'series', (select coalesce(jsonb_agg(jsonb_build_object(
        'day', s.day, 'steps', s.steps, 'sleep_h', s.sleep_h, 'resting_hr', s.resting_hr,
        'hrv_ms', s.hrv_ms, 'kcal_in', s.kcal_in, 'protein_g', s.protein_g,
        'weight_kg', s.weight_kg, 'active_kcal', s.active_kcal,
        'strength_volume_kg', s.strength_volume_kg, 'cardio_min', s.cardio_min) order by s.day), '[]'::jsonb)
      from ai.daily_summary s where s.day between d - 29 and d),
    'last_weight', (select jsonb_build_object('day', s.day, 'kg', s.weight_kg)
      from ai.daily_summary s where s.weight_kg is not null and s.day <= d order by s.day desc limit 1),
    'goals', (select value from app.settings where key = 'goals'),
    'recent', public.get_activities(6, 0),
    'day_activities', (select coalesce(jsonb_agg(x), '[]'::jsonb)
      from jsonb_array_elements(public.get_activities(300, 0)) x where x->>'day' = d::text),
    'journal', (select content from app.journal where day = d and content <> ''),
    'insight', (select to_jsonb(i) from app.insights i where i.created_at > now() - interval '8 days'
                order by i.id desc limit 1),
    'sync', (select coalesce(jsonb_object_agg(source, jsonb_build_object(
        'last_success', last_success, 'last_run', last_run, 'last_error', last_error)), '{}'::jsonb)
      from app.sync_state)
  ) into res;
  return res;
end $$;

-- doelen uitbreiden met water en cafeïne-limiet
update app.settings set value = value || '{"water_ml":2500,"caffeine_mg":400}'::jsonb
where key = 'goals' and not (value ? 'water_ml');

insert into app.settings(key, value) values
  ('vapid_public', '"BPxq8AIvEqpI9tbNMM9NvK1rBwD1ya6OFgL0sbCHoDtD39eOJlBZkJPwj9TX41_hD6libe_ygQ32fFg-mT7Dw4M"')
on conflict (key) do update set value = excluded.value;

-- standaard: weekoverzicht elke maandag om 08:00
insert into app.routines (title, body, kind, days, time_local, url, created_by)
select 'Weekoverzicht', 'Je weekoverzicht staat klaar', 'weekly_review', '{1}', '08:00', '/#/vandaag', 'system'
where not exists (select 1 from app.routines where kind = 'weekly_review');

-- ---------- rechten ----------
do $$
declare f text;
begin
  foreach f in array array[
    'public.log_entry(text,double precision,timestamptz)', 'public.void_entry(text,timestamptz)',
    'public.save_journal(date,text,boolean)', 'public.get_journal(integer)',
    'public.save_routine(jsonb)', 'public.get_routines()',
    'public.save_push_subscription(jsonb,text)', 'public.get_insights(integer)',
    'public.mark_insight_read(bigint)', 'public.import_hevy_workouts(jsonb)', 'public.get_dashboard(date)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array[
    'public.internal_log_entry(text,double precision,timestamptz)', 'public.internal_save_routine(jsonb)',
    'public.internal_list_routines()', 'public.internal_claim_due_routines()',
    'public.internal_push_targets()', 'public.internal_push_result(text,boolean,boolean,text)',
    'public.internal_add_insight(text,text,text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
revoke all on function app.do_log_entry(text,double precision,timestamptz) from public;
revoke all on function app.do_save_routine(jsonb,text) from public;

-- ---------- meldingen: elke 5 minuten controleren ----------
select cron.schedule(
  'notify',
  '*/5 * * * *',
  $$ select net.http_post(
       url := 'https://jzqqriddjpcigmxmnaug.supabase.co/functions/v1/notify',
       headers := jsonb_build_object('Content-Type', 'application/json',
                                     'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_token')),
       body := '{}'::jsonb,
       timeout_milliseconds := 150000) $$
);
