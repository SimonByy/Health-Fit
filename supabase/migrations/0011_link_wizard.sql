-- 0011: koppel-assistent. Opdrachten-ontvangst logt nu welke waarden binnenkwamen
--       (en negeert lege/0-waarden van metingen zonder data), plus een statusfunctie.

-- Getal uit tekst: "523,4" "1.234,5" "8234 stappen" "1.234.567"
create or replace function health.to_num(v jsonb)
returns double precision language plpgsql immutable set search_path = '' as $$
declare t text;
begin
  if v is null or jsonb_typeof(v) = 'null' then return null; end if;
  if jsonb_typeof(v) = 'number' then return (v #>> '{}')::double precision; end if;
  t := regexp_replace(v #>> '{}', '[^0-9,.\-]', '', 'g');
  if t ~ ',' and t ~ '\.' then t := replace(replace(t, '.', ''), ',', '.');      -- 1.234,5
  elsif t ~ ',' then t := replace(t, ',', '.');                                   -- 523,4
  elsif t ~ '^\d{1,3}(\.\d{3}){2,}$' then t := replace(t, '.', '');               -- 1.234.567
  end if;
  if t ~ '^-?\d+(\.\d+)?$' then return t::double precision; end if;
  return null;
end $$;

create or replace function public.ingest_daily_values(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  dayobj jsonb;
  d date;
  kv record;
  v double precision;
  v_ts timestamptz;
  n int := 0;
  skipped text[] := '{}';
  got jsonb := '{}';
  days text[] := '{}';
begin
  for dayobj in
    select value from jsonb_array_elements(case when p ? 'days' then p->'days' else jsonb_build_array(p) end)
  loop
    -- datum optioneel (standaard vandaag); alleen jjjj-mm-dd wordt gelezen
    d := coalesce(case when dayobj->>'date' ~ '^\d{4}-\d{2}-\d{2}' then left(dayobj->>'date', 10)::date end,
                  (now() at time zone 'Europe/Brussels')::date);
    days := days || d::text;
    v_ts := ((d::timestamp + interval '23:59:59.999') at time zone 'Europe/Brussels');
    for kv in select key, value from jsonb_each(coalesce(dayobj->'values', '{}'::jsonb)) loop
      v := health.to_num(kv.value);
      -- leeg of 0 = Opdrachten vond geen gegevens voor die meting: niets opslaan
      continue when v is null or v <= 0;
      -- tellingen zijn altijd gehele getallen: "8.234" (Nederlandse notatie) = 8234
      if kv.key in ('step_count', 'flights_climbed') and v <> trunc(v) and v < 1000 then v := round(v * 1000); end if;
      if kv.key in ('sleep_hours', 'sleep_minutes') then
        if kv.key = 'sleep_minutes' then v := v / 60; end if;
        continue when v > 24;
        insert into health.sleep_summaries (day, source, total_h)
        values (d, 'Opdrachten', v)
        on conflict (day, source) do update set total_h = excluded.total_h, inserted_at = now();
        n := n + 1; got := got || jsonb_build_object(kv.key, round(v::numeric, 2));
      elsif exists (select 1 from health.metric_catalog c where c.metric = kv.key) then
        insert into health.metric_samples (metric, ts, day, hour, qty, units, source, granularity)
        values (kv.key, v_ts, d, 23, v, (select c.unit from health.metric_catalog c where c.metric = kv.key), 'Opdrachten', 'day')
        on conflict (metric, ts) do update set qty = excluded.qty, voided = false, inserted_at = now();
        n := n + 1; got := got || jsonb_build_object(kv.key, round(v::numeric, 2));
      else
        skipped := skipped || kv.key;
      end if;
    end loop;
  end loop;

  insert into app.ingest_log(source, stats)
  values ('opdrachten', jsonb_build_object('values', n, 'onbekend', skipped, 'ontvangen', got, 'dagen', days));
  insert into app.sync_state(source, last_run, last_success, last_items, last_error)
  values ('apple_health', now(), now(), n, null)
  on conflict (source) do update set last_run = now(), last_success = now(), last_items = n, last_error = null;
  return jsonb_build_object('values', n, 'unknown', skipped, 'received', got);
end $$;

-- Status voor de koppel-assistent
create or replace function public.get_link_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare t date := (now() at time zone 'Europe/Brussels')::date;
begin
  perform app.assert_owner();
  return jsonb_build_object(
    'export', (select jsonb_build_object('at', max(received_at), 'n', count(*)) from app.ingest_log where source = 'apple_health' and error is null),
    'shortcut', (select to_jsonb(l) from (select received_at, stats, error from app.ingest_log where source = 'opdrachten' order by received_at desc limit 1) l),
    'shortcut_runs_7d', (select count(*) from app.ingest_log where source = 'opdrachten' and received_at > now() - interval '7 days'),
    'routine', (select to_jsonb(r) from (select id, title, days, time_local, active from app.routines
                where not archived and url like '%koppelen%' order by created_at desc limit 1) r),
    'coverage', (select jsonb_build_object(
        'first_day', min(day), 'last_day', max(day),
        'steps_days_14', count(distinct day) filter (where metric = 'step_count' and day > t - 14),
        'hr_days_14', count(distinct day) filter (where metric in ('resting_heart_rate', 'heart_rate') and day > t - 14),
        'food_days_14', count(distinct day) filter (where metric = 'dietary_energy' and day > t - 14))
      from health.metric_samples where not voided and source <> 'Health Hub'),
    'sleep_nights_14', (select count(distinct day) from health.sleep_summaries where day > t - 14),
    'workouts_total', (select count(*) from health.workouts),
    'sources', (select coalesce(jsonb_agg(x order by x.n desc), '[]') from (
        select source, count(*) n, max(day) last_day from health.metric_samples
        where not voided and source <> 'Health Hub' and day > t - 30 group by source) x)
  );
end $$;
revoke all on function public.get_link_status() from public, anon;
grant execute on function public.get_link_status() to authenticated;
