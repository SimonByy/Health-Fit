-- 1. Verpakkingsgrootte: app.foods.package_g (van het etiket) en per ingrediënt "pack" (in de eenheid
--    van het ingrediënt: gram/ml, of stuks per verpakking). De boodschappenlijst geeft "pack" mee,
--    zodat de app "1200 g · 4 × 300 g" kan tonen.
-- 2. mp_day_eaten: alle geplande maaltijden van een dag in één keer als gegeten loggen (of terug).
alter table app.foods add column if not exists package_g numeric;

update app.foods set package_g = v.g from (values
  ('AH Mager rundergehakt', 300), ('AH Tortilla wraps volkoren large', 370), ('AH Iets kruimige aardappelen', 1000),
  ('AH Appelmoes 0% suiker toegevoegd', 355), ('AH Scharrel kipfilet blokjes van de haas', 300), ('AH IJsbergsla', 200),
  ('AH Goudse jong belegen 30+ geraspt', 150), ('AH Taco saus mild', 230), ('AH Basmatirijst (droog)', 1000),
  ('Upfront Eiwit oats framboos witte choco', 300), ('AH Blauwe bessen', 300), ('AH Wokgroente oosters', 400),
  ('AH Woksaus teriyaki', 180)) v(name, g)
where app.foods.name = v.name and app.foods.source = 'ah';

-- "pack" invullen in de bestaande recepten waar het product een verpakkingsgrootte heeft
update app.mp_recipes r set ingredients = (
  select jsonb_agg(case
    when f.package_g is null or e ? 'pack' then e
    when coalesce(e->>'unit', 'g') in ('g', 'ml') then e || jsonb_build_object('pack', f.package_g)
    when e->>'unit' = 'stuk' and jsonb_typeof(e->'g_per_unit') = 'number' and (e->>'g_per_unit')::numeric > 0
      then e || jsonb_build_object('pack', round(f.package_g / (e->>'g_per_unit')::numeric))
    else e end order by o)
  from jsonb_array_elements(r.ingredients) with ordinality x(e, o)
  left join app.foods f on f.id::text = e->>'food_id')
where not hidden and jsonb_array_length(ingredients) > 0;

create or replace function public.mp_shopping_build(p_week_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  with cfg as (
    select w.week_start,
           case lower(coalesce((select s.value->>'tussendag' from app.settings s where s.key = 'mealprep'), 'woensdag'))
             when 'maandag' then 1 when 'dinsdag' then 2 when 'donderdag' then 4 else 3 end as tus_off,
           lower(coalesce((select s.value->>'tussendag' from app.settings s where s.key = 'mealprep'), 'woensdag')) as tus_naam
    from app.mp_weeks w where w.id = p_week_id
  ), first_day as (
    select i.recipe_id, min(i.day) as d from app.mp_week_items i where i.week_id = p_week_id group by i.recipe_id
  ), src as (
    select i.portions as mult, r.ingredients, i.slot, i.day, f.d as first_d
    from app.mp_week_items i join app.mp_recipes r on r.id = i.recipe_id
    join first_day f on f.recipe_id = i.recipe_id
    where i.week_id = p_week_id
    union all
    select l.portions, r.ingredients, 'extra', null::date, null::date
    from app.mp_list_recipes l join app.mp_recipes r on r.id = l.recipe_id where l.week_id = p_week_id
  ), ing as (
    select btrim(e->>'name') as name, nullif(btrim(e->>'unit'), '') as unit,
           coalesce(nullif(e->>'dept', ''), 'Overig') as dept,
           coalesce((e->>'pantry')::boolean, false) as pantry,
           case when jsonb_typeof(e->'amount') = 'number' then (e->>'amount')::numeric * s.mult end as amt,
           case when jsonb_typeof(e->'pack') = 'number' and (e->>'pack')::numeric > 0 then (e->>'pack')::numeric end as pack,
           case
             when e->>'winkel' = 'AH' then 'zondag'
             when e->>'winkel' = 'Okay' then 'tussendag'
             when e->>'winkel' = 'Colruyt' then 'colruyt'
             when coalesce(nullif(e->>'dept', ''), 'Overig') not in ('Groenten & fruit', 'Vlees & vis', 'Zuivel & eieren') then 'zondag'
             when coalesce((e->>'pantry')::boolean, false) then 'zondag'
             when s.slot in ('ontbijt', 'snack', 'avondsnack') and s.day >= c.week_start + c.tus_off then 'tussendag'
             when s.slot in ('lunch', 'avond') and s.first_d >= c.week_start + c.tus_off then 'tussendag'
             else 'zondag'
           end as moment
    from src s cross join cfg c cross join lateral jsonb_array_elements(s.ingredients) e
    where coalesce(btrim(e->>'name'), '') <> ''
  ), agg as (
    select case moment when 'tussendag' then 'tus|' when 'colruyt' then 'col|' else '' end || lower(name) || '|' || coalesce(unit, '') as key,
           min(name) as name, unit, min(dept) as dept, moment,
           bool_and(pantry) as pantry, sum(amt) as amount, max(pack) as pack, null::bigint as extra_id
    from ing group by moment, lower(name), unit
    union all
    select 'extra|' || x.id, x.name, null, x.dept, 'zondag', false, null, null, x.id from app.mp_list_extras x where x.week_id = p_week_id
  ), rows_ as (
    select a.*,
      exists (select 1 from app.mp_weeks w cross join lateral jsonb_array_elements(w.bonus) b
              where w.id = p_week_id and lower(btrim(coalesce(b->>'ingredient', ''))) = lower(a.name)) as bonus,
      coalesce((select c.checked from app.mp_list_checks c where c.week_id = p_week_id and c.key = a.key), false) as checked,
      coalesce(array_position(array['Groenten & fruit','Vlees & vis','Zuivel & eieren','Brood & wraps','Houdbaar','Ontbijt & sport','Diepvries','Overig'], a.dept), 99) as dept_ord
    from agg a
  ), groups as (
    select moment, dept, min(dept_ord) as dept_ord,
      jsonb_agg(jsonb_build_object('key', key, 'name', name, 'amount', round(amount, 1), 'unit', unit, 'pack', pack, 'pantry', pantry,
                                   'bonus', bonus, 'checked', checked, 'extra_id', extra_id, 'moment', moment)
                order by pantry, lower(name)) as items
    from rows_ group by moment, dept
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'moment', g.moment,
           'moment_label', ml.label,
           'afdeling', g.dept,
           'dept', ml.label || ' · ' || g.dept,
           'items', g.items)
         order by case g.moment when 'zondag' then 0 when 'colruyt' then 1 else 2 end, g.dept_ord, g.dept), '[]'::jsonb)
  from groups g
  cross join lateral (
    select case when g.moment = 'zondag' then 'Zondag (AH)'
                when g.moment = 'colruyt' then 'Colruyt / Lidl'
                else initcap(coalesce((select tus_naam from cfg), 'woensdag')) || ' (Okay)' end as label
  ) ml;
$$;
revoke all on function public.mp_shopping_build(bigint) from public, anon, authenticated;

create or replace function public.mp_day_eaten(p_week_id bigint, p_day date, p_eaten boolean default true)
returns int language plpgsql security definer set search_path = '' as $$
declare i record; v_n int := 0;
begin
  perform app.assert_owner();
  if p_eaten and p_day > (now() at time zone 'Europe/Brussels')::date then raise exception 'Je kan geen dag in de toekomst als gegeten aanvinken'; end if;
  for i in select id from app.mp_week_items where week_id = p_week_id and day = p_day loop
    perform public.mp_item_eaten(i.id, p_eaten); v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function public.mp_day_eaten(bigint, date, boolean) from public, anon;
grant execute on function public.mp_day_eaten(bigint, date, boolean) to authenticated;
