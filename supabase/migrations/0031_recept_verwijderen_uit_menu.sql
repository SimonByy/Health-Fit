-- Een recept verwijderen mag ook als het in je weekmenu staat: het verdwijnt dan uit de
-- komende dagen (vandaag en later) en van je boodschappenlijst. Voorbije dagen blijven staan.
-- Het recept wordt verborgen (niet gewist), zodat oude weken en logs kloppen.
drop function if exists public.mp_hide_recipe(bigint);
create function public.mp_hide_recipe(p_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'Europe/Brussels')::date; v_n int;
begin
  perform app.assert_owner();
  delete from app.mp_week_items where recipe_id = p_id and day >= v_today;
  get diagnostics v_n = row_count;
  delete from app.mp_list_recipes l using app.mp_weeks w
   where w.id = l.week_id and l.recipe_id = p_id and w.week_start >= v_today - 6;
  update app.mp_recipes set hidden = true, updated_at = now() where id = p_id;
  return jsonb_build_object('removed_items', v_n);
end $$;
revoke all on function public.mp_hide_recipe(bigint) from public, anon;
grant execute on function public.mp_hide_recipe(bigint) to authenticated;
