-- Voeding: "Niet gegeten" (grijs, telt niet mee) en terug naar "Gegeten".
alter table app.food_log add column if not exists skipped boolean not null default false;

create or replace function public.food_set_eaten(p_ids uuid[], p_eaten boolean)
 returns int language plpgsql security definer set search_path to ''
as $$
declare n int;
begin
  perform app.assert_owner();
  update app.food_log set skipped = not p_eaten, voided = not p_eaten
   where id = any(p_ids) and (skipped or not voided);   -- echt verwijderde items blijven weg
  get diagnostics n = row_count;
  update health.metric_samples set voided = not p_eaten where ref = any(p_ids);
  return n;
end $$;
revoke all on function public.food_set_eaten(uuid[], boolean) from public, anon;
grant execute on function public.food_set_eaten(uuid[], boolean) to authenticated;

-- Dagoverzicht: ook de niet-gegeten (grijze) items tonen
create or replace function public.get_food_log(p_day date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (select coalesce(jsonb_agg(to_jsonb(f) order by f.created_at), '[]'::jsonb)
          from app.food_log f where f.day = p_day and (not f.voided or f.skipped));
end $$;

-- Verwijderen van een grijs item: echt weg
create or replace function public.void_food_many(p_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  update app.food_log set voided = true, skipped = false where id = any(p_ids);
  update health.metric_samples set voided = true where ref = any(p_ids);
end $$;
