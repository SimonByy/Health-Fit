-- Gelogd eten aanpassen (hoeveelheid, maaltijd of waarden) in één stap.
create or replace function public.edit_food(p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  perform app.assert_owner();
  if not exists (select 1 from app.food_log where id = p_id and not voided) then raise exception 'Dit item bestaat niet meer'; end if;
  perform public.void_food(p_id);
  r := public.log_food(p);
  return r;
end $$;
revoke all on function public.edit_food(uuid, jsonb) from public, anon;
grant execute on function public.edit_food(uuid, jsonb) to authenticated;
