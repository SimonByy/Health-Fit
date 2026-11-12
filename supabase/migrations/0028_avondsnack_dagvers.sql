-- Boodschappen: avondsnack is (zoals ontbijt en snack) iets wat je per dag vers neemt,
-- dus vers spul voor een avondsnack vanaf de tussendag komt op de lijst van de tussendag.
do $$
declare d text := pg_get_functiondef('public.mp_shopping_build(bigint)'::regprocedure);
begin
  if position('''ontbijt'', ''snack'', ''avondsnack'')' in d) = 0 then
    execute replace(d, 's.slot in (''ontbijt'', ''snack'')', 's.slot in (''ontbijt'', ''snack'', ''avondsnack'')');
  end if;
end $$;
revoke all on function public.mp_shopping_build(bigint) from public, anon, authenticated;
