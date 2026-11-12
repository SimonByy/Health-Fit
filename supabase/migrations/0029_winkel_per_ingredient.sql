-- Boodschappen: per ingrediënt kan je de winkel vastzetten ("winkel": "AH" of "Okay").
-- AH = altijd op de zondaglijst (bv. XXL Fitpudding, AH Proteïne melk), Okay = altijd op de tussendag.
-- Zonder winkel beslist de gewone regel (vers spul voor later in de week → tussendag).
do $$
declare d text := pg_get_functiondef('public.mp_shopping_build(bigint)'::regprocedure);
begin
  if position('e->>''winkel''' in d) = 0 then
    execute replace(d, '           case
             when coalesce(nullif(e->>''dept'', ''''), ''Overig'') not in',
      '           case
             when e->>''winkel'' = ''AH'' then ''zondag''
             when e->>''winkel'' = ''Okay'' then ''tussendag''
             when coalesce(nullif(e->>''dept'', ''''), ''Overig'') not in');
  end if;
  if position('e->>''winkel''' in pg_get_functiondef('public.mp_shopping_build(bigint)'::regprocedure)) = 0 then
    raise exception 'mp_shopping_build niet aangepast';
  end if;
end $$;
revoke all on function public.mp_shopping_build(bigint) from public, anon, authenticated;

-- AH-only producten en Okay-producten in de huidige recepten vastzetten
update app.mp_recipes r set ingredients = (
  select jsonb_agg(case
    when e->>'name' ilike '%fitpudding%' or e->>'name' ilike 'proteïne melk%' or e->>'name' ilike 'AH %' or coalesce(e->>'food_name','') ilike 'proteïn%melk%' then e || '{"winkel":"AH"}'
    when e->>'name' ilike '%(okay)%' or e->>'name' ilike 'boni%' then e || '{"winkel":"Okay"}'
    else e end order by o)
  from jsonb_array_elements(r.ingredients) with ordinality x(e, o))
where not hidden and jsonb_array_length(ingredients) > 0;
