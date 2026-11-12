-- Macro's van een menu-recept worden altijd uitgerekend uit de gekoppelde ingrediënten
-- (waarden per 100 g van het etiket), zowel bij bewaren in de app als bij inserts van de planner.
-- Niet gekoppeld = macros_checked false (de app toont dan "geschat").

create or replace function app.mp_calc(p_ings jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  with i as (
    select e,
      case when jsonb_typeof(e->'amount') = 'number' then (e->>'amount')::numeric end as amt,
      nullif(e->>'unit', '') as unit,
      case when jsonb_typeof(e->'g_per_unit') = 'number' then (e->>'g_per_unit')::numeric end as gpu,
      coalesce((e->>'pantry')::boolean, false) as pantry,
      jsonb_typeof(e->'per100') = 'object' as linked
    from jsonb_array_elements(coalesce(p_ings, '[]'::jsonb)) e
  ), g as (
    select *, case when amt is null then null when unit is null or unit in ('g', 'ml') then amt when gpu is not null then amt * gpu end as grams from i
  )
  select jsonb_build_object(
    'kcal', round(coalesce(sum((e->'per100'->>'kcal')::numeric * grams / 100) filter (where linked and grams is not null), 0), 1),
    'protein', round(coalesce(sum((e->'per100'->>'protein')::numeric * grams / 100) filter (where linked and grams is not null), 0), 1),
    'carbs', round(coalesce(sum((e->'per100'->>'carbs')::numeric * grams / 100) filter (where linked and grams is not null), 0), 1),
    'fat', round(coalesce(sum((e->'per100'->>'fat')::numeric * grams / 100) filter (where linked and grams is not null), 0), 1),
    'linked', count(*) filter (where linked and grams is not null),
    'missing', count(*) filter (where amt is not null and not pantry and not (linked and grams is not null)))
  from g;
$$;

create or replace function app.mp_recipes_calc()
returns trigger language plpgsql set search_path = '' as $$
declare c jsonb := app.mp_calc(new.ingredients);
begin
  if (c->>'linked')::int > 0 then
    new.kcal := (c->>'kcal')::numeric; new.protein := (c->>'protein')::numeric;
    new.carbs := (c->>'carbs')::numeric; new.fat := (c->>'fat')::numeric;
    new.macros_checked := (c->>'missing')::int = 0;
  else
    new.macros_checked := false;
  end if;
  return new;
end $$;

drop trigger if exists mp_recipes_calc on app.mp_recipes;
create trigger mp_recipes_calc before insert or update on app.mp_recipes
  for each row execute function app.mp_recipes_calc();

-- bestaande recepten één keer doorrekenen
update app.mp_recipes set updated_at = updated_at;
