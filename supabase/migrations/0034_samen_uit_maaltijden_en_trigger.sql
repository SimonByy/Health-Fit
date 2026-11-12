-- 1. Macro-trigger: alleen overschrijven als ALLE ingrediënten met een hoeveelheid gekoppeld zijn.
--    Half gekoppeld = de waarden die de app/import meegaf blijven staan, macros_checked = false.
create or replace function app.mp_recipes_calc()
returns trigger language plpgsql set search_path = '' as $$
declare c jsonb := app.mp_calc(new.ingredients);
begin
  if (c->>'linked')::int > 0 and (c->>'missing')::int = 0 then
    new.kcal := (c->>'kcal')::numeric; new.protein := (c->>'protein')::numeric;
    new.carbs := (c->>'carbs')::numeric; new.fat := (c->>'fat')::numeric;
    new.macros_checked := true;
  else
    new.macros_checked := false;
  end if;
  return new;
end $$;

-- 2. "Vaak samen" haalt ook combinaties uit je vaste maaltijden (bv. geïmporteerd uit Bevel),
--    niet alleen uit je eigen logs in Health Hub.
create or replace function public.get_day_pairs(p_day date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (
    with cur as (
      select meal, lower(btrim(name)) as n, food_id from app.food_log where day = p_day and not voided
    ), hist as (
      select distinct f.day, f.meal, c.meal as for_meal from app.food_log f join cur c on c.n = lower(btrim(f.name))
      where not f.voided and f.day < p_day and f.day >= p_day - 120
    ), from_log as (
      select h.for_meal, lower(btrim(f.name)) as n, count(distinct (f.day, f.meal))::int as times,
             (array_agg(jsonb_build_object('name', f.name, 'food_id', f.food_id, 'grams', f.grams, 'kcal', f.kcal,
                'protein', f.protein, 'carbs', f.carbs, 'fat', f.fat) order by f.day desc, f.created_at desc))[1] as last
      from app.food_log f join hist h on h.day = f.day and h.meal = f.meal
      where not f.voided
      group by 1, 2 having count(distinct (f.day, f.meal)) >= 2
    ), from_presets as (
      select c.meal as for_meal, lower(btrim(o->>'name')) as n, max(greatest(m.use_count, 2))::int as times,
             (array_agg(jsonb_build_object('name', o->>'name', 'food_id', o->>'food_id', 'grams', (o->>'grams')::numeric,
                'kcal', (o->>'kcal')::numeric, 'protein', (o->>'protein')::numeric, 'carbs', (o->>'carbs')::numeric, 'fat', (o->>'fat')::numeric)
                order by m.use_count desc))[1] as last
      from app.meal_presets m
      cross join lateral jsonb_array_elements(m.items) i
      join cur c on (c.food_id is not null and c.food_id::text = i->>'food_id') or c.n = lower(btrim(i->>'name'))
      cross join lateral jsonb_array_elements(m.items) o
      where not m.archived and o <> i
      group by 1, 2
    ), cand as (
      select for_meal, n, max(times) as times, (array_agg(last order by times desc))[1] as last
      from (select * from from_log union all select * from from_presets) u
      where not exists (select 1 from cur c where c.meal = u.for_meal and c.n = u.n)
      group by 1, 2
    ), ranked as (
      select *, row_number() over (partition by for_meal order by times desc, n) as rn from cand
    )
    select coalesce(jsonb_object_agg(for_meal, items), '{}'::jsonb) from (
      select for_meal, jsonb_agg(last || jsonb_build_object('times', times) order by rn) as items from ranked where rn <= 3 group by for_meal) x);
end $$;
revoke all on function public.get_day_pairs(date) from public, anon;
grant execute on function public.get_day_pairs(date) to authenticated;
