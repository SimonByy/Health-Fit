-- =====================================================================
-- 0007: gratis Apple Health-koppeling
--  * dagtotalen via iOS Opdrachten (granularity = 'day')
--  * import van de Apple Health-export (zip) via de app
-- Dagtotalen tellen alleen mee als er voor die dag en metric geen
-- gedetailleerdere data (per uur/meting) is, zodat niets dubbel telt.
-- =====================================================================

alter table health.metric_samples add column if not exists granularity text not null default 'sample';

create or replace view ai.daily_metrics as
with s as (
  select ms.*, bool_or(ms.granularity <> 'day') over (partition by ms.day, ms.metric) as has_detail
  from health.metric_samples ms
  where not ms.voided
)
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
from s
left join health.metric_catalog c on c.metric = s.metric
where not (s.granularity = 'day' and s.has_detail)
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
where not s.voided and s.granularity <> 'day' and s.metric not in ('dietary_water', 'dietary_caffeine')
group by s.day, 2;

-- Getal uit JSON halen, ook als tekst met komma ("7,5") of met eenheid ("8234 stappen")
create or replace function health.to_num(v jsonb)
returns double precision language plpgsql immutable set search_path = '' as $$
declare t text;
begin
  if v is null or jsonb_typeof(v) = 'null' then return null; end if;
  if jsonb_typeof(v) = 'number' then return (v #>> '{}')::double precision; end if;
  t := replace(regexp_replace(v #>> '{}', '[^0-9,.\-]', '', 'g'), ',', '.');
  if t ~ '^-?\d+(\.\d+)?$' then return t::double precision; end if;
  -- "1.234.5" e.d. (duizendtallen): laatste punt is decimaal
  if t ~ '^\d{1,3}(\.\d{3})+$' then return replace(t, '.', '')::double precision; end if;
  return null;
end $$;

-- Dagtotalen uit iOS Opdrachten.
-- Body: {"date":"2026-10-05","values":{"step_count":8234,"protein":150,...,"sleep_hours":7.2}}
--   of: {"days":[{"date":...,"values":{...}}, ...]}
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
begin
  for dayobj in
    select value from jsonb_array_elements(case when p ? 'days' then p->'days' else jsonb_build_array(p) end)
  loop
    d := coalesce(left(dayobj->>'date', 10)::date, (now() at time zone 'Europe/Brussels')::date);
    -- uniek tijdstip dat nooit botst met uur-data (die valt altijd op :00:00)
    v_ts := ((d::timestamp + interval '23:59:59.999') at time zone 'Europe/Brussels');
    for kv in select key, value from jsonb_each(coalesce(dayobj->'values', '{}'::jsonb)) loop
      v := health.to_num(kv.value);
      continue when v is null;
      if kv.key in ('sleep_hours', 'sleep_minutes') then
        if kv.key = 'sleep_minutes' then v := v / 60; end if;
        continue when v <= 0 or v > 24;
        insert into health.sleep_summaries (day, source, total_h)
        values (d, 'Opdrachten', v)
        on conflict (day, source) do update set total_h = excluded.total_h, inserted_at = now();
        n := n + 1;
      elsif exists (select 1 from health.metric_catalog c where c.metric = kv.key) then
        insert into health.metric_samples (metric, ts, day, hour, qty, units, source, granularity)
        values (kv.key, v_ts, d, 23, v, (select c.unit from health.metric_catalog c where c.metric = kv.key), 'Opdrachten', 'day')
        on conflict (metric, ts) do update set qty = excluded.qty, voided = false, inserted_at = now();
        n := n + 1;
      else
        skipped := skipped || kv.key;
      end if;
    end loop;
  end loop;

  insert into app.ingest_log(source, stats) values ('opdrachten', jsonb_build_object('values', n, 'onbekend', skipped));
  insert into app.sync_state(source, last_run, last_success, last_items, last_error)
  values ('apple_health', now(), now(), n, null)
  on conflict (source) do update set last_run = now(), last_success = now(), last_items = n, last_error = null;
  return jsonb_build_object('values', n, 'unknown', skipped);
end $$;

-- Import van de Apple Health-export (zip), door de ingelogde eigenaar via de app
create or replace function public.import_health_export(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return public.ingest_health_export(p);
end $$;

revoke all on function public.ingest_daily_values(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_daily_values(jsonb) to service_role;
revoke all on function public.import_health_export(jsonb) from public, anon;
grant execute on function public.import_health_export(jsonb) to authenticated;
revoke all on function health.to_num(jsonb) from public;
