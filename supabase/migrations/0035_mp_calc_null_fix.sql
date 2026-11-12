-- Fix: een ingrediënt zonder per100 gaf linked = NULL (niet false), waardoor het niet als
-- "ontbrekend" telde en een half gekoppeld recept als "echte waarden" werd gemarkeerd.
create or replace function app.mp_calc(p_ings jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  with i as (
    select e,
      case when jsonb_typeof(e->'amount') = 'number' then (e->>'amount')::numeric end as amt,
      nullif(e->>'unit', '') as unit,
      case when jsonb_typeof(e->'g_per_unit') = 'number' then (e->>'g_per_unit')::numeric end as gpu,
      coalesce((e->>'pantry')::boolean, false) as pantry,
      coalesce(jsonb_typeof(e->'per100') = 'object', false) as linked
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
-- alles opnieuw doorrekenen; recepten die nu half gekoppeld blijken: macro's leeg (concept)
update app.mp_recipes set updated_at = updated_at;
update app.mp_recipes set kcal = null, protein = null, carbs = null, fat = null
 where not macros_checked and note = 'Bevel-import 12/11/2026';
