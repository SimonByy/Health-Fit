-- "Vaak samen": per maaltijd van een dag de producten die je in het verleden vaak samen at met
-- wat je daar al logde (minstens 2 keer samen in dezelfde maaltijd). Met de laatst gelogde
-- hoeveelheid en waarden, zodat de app ze in één tik kan toevoegen.
create or replace function public.get_day_pairs(p_day date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (
    with cur as (
      select meal, lower(btrim(name)) as n from app.food_log where day = p_day and not voided group by 1, 2
    ), hist as (
      select distinct f.day, f.meal, c.meal as for_meal from app.food_log f join cur c on c.n = lower(btrim(f.name))
      where not f.voided and f.day < p_day and f.day >= p_day - 120
    ), cand as (
      select h.for_meal, lower(btrim(f.name)) as n, count(distinct (f.day, f.meal)) as times,
             (array_agg(jsonb_build_object('name', f.name, 'food_id', f.food_id, 'grams', f.grams, 'kcal', f.kcal,
                'protein', f.protein, 'carbs', f.carbs, 'fat', f.fat) order by f.day desc, f.created_at desc))[1] as last
      from app.food_log f join hist h on h.day = f.day and h.meal = f.meal
      where not f.voided and not exists (select 1 from cur c where c.meal = h.for_meal and c.n = lower(btrim(f.name)))
      group by 1, 2 having count(distinct (f.day, f.meal)) >= 2
    ), ranked as (
      select *, row_number() over (partition by for_meal order by times desc, n) as rn from cand
    )
    select coalesce(jsonb_object_agg(for_meal, items), '{}'::jsonb) from (
      select for_meal, jsonb_agg(last || jsonb_build_object('times', times) order by rn) as items from ranked where rn <= 3 group by for_meal) x);
end $$;
revoke all on function public.get_day_pairs(date) from public, anon;
grant execute on function public.get_day_pairs(date) to authenticated;
