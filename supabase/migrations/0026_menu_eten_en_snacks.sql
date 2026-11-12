-- Weekmenu ↔ Voeding: een geplande maaltijd afvinken als "gegeten" logt ze in Voeding
-- (en uitvinken haalt ze weer weg). Plus: zelf maaltijden (snack, avondsnack, …) toevoegen
-- aan of verwijderen uit een dag van het weekmenu.

alter table app.mp_week_items add column if not exists food_log_id uuid;

-- mp_get: items krijgen 'eaten' (gelogd en niet verwijderd in Voeding)
create or replace function public.mp_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'Europe/Brussels')::date;
begin
  perform app.assert_owner();
  return jsonb_build_object(
    'today', v_today,
    'current_week_id', app.mp_current_week_id(),
    'goals', (select value from app.settings where key = 'goals'),
    'rules', (select value from app.settings where key = 'mealprep'),
    'briefing', (select jsonb_build_object('day', b.day, 'text', b.text, 'conversation_id', b.conversation_id) from app.briefings b where b.day = v_today),
    'recipes', (select coalesce(jsonb_agg(to_jsonb(r) - 'hidden' order by r.favorite desc, r.disliked, lower(r.name)), '[]'::jsonb) from app.mp_recipes r where not r.hidden),
    'weeks', (select coalesce(jsonb_agg(w.j order by w.week_start desc), '[]'::jsonb) from (
        select mw.week_start, jsonb_build_object('id', mw.id, 'week_start', mw.week_start, 'bonus', mw.bonus, 'prep', mw.prep,
          'notes', mw.notes, 'reviewed_at', mw.reviewed_at,
          'items', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'day', i.day, 'slot', i.slot, 'recipe_id', i.recipe_id, 'portions', i.portions,
                      'food_log_id', case when f.id is not null then i.food_log_id end, 'eaten', f.id is not null) order by i.day, i.slot), '[]'::jsonb)
                    from app.mp_week_items i left join app.food_log f on f.id = i.food_log_id and not f.voided
                    where i.week_id = mw.id),
          'list_recipes', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'recipe_id', l.recipe_id, 'portions', l.portions) order by l.id), '[]'::jsonb)
                    from app.mp_list_recipes l where l.week_id = mw.id),
          'shopping', public.mp_shopping_build(mw.id)) as j
        from app.mp_weeks mw order by mw.week_start desc limit 4) w)
  );
end $$;

-- Afvinken: gegeten → loggen in Voeding met de macro's van het recept × porties
create or replace function public.mp_item_eaten(p_item_id bigint, p_eaten boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare i app.mp_week_items; r app.mp_recipes; v_live boolean; v_meal text; res jsonb;
begin
  perform app.assert_owner();
  select * into i from app.mp_week_items where id = p_item_id for update;
  if i.id is null then raise exception 'Maaltijd niet gevonden'; end if;
  v_live := i.food_log_id is not null and exists (select 1 from app.food_log where id = i.food_log_id and not voided);
  if p_eaten then
    if v_live then return jsonb_build_object('id', i.food_log_id, 'eaten', true); end if;
    select * into r from app.mp_recipes where id = i.recipe_id;
    v_meal := case i.slot when 'ontbijt' then 'Ontbijt' when 'lunch' then 'Lunch' when 'snack' then 'Snack'
                          when 'avond' then 'Avondeten' else 'Laat' end;
    res := public.log_food(jsonb_build_object('day', i.day, 'meal', v_meal,
      'name', r.name || case when i.portions <> 1 then ' (' || trim(to_char(i.portions, 'FM990.99')) || ' porties)' else '' end,
      'kcal', round(coalesce(r.kcal, 0) * i.portions, 1), 'protein', round(coalesce(r.protein, 0) * i.portions, 1),
      'carbs', round(coalesce(r.carbs, 0) * i.portions, 1), 'fat', round(coalesce(r.fat, 0) * i.portions, 1)));
    update app.mp_week_items set food_log_id = (res->>'id')::uuid where id = i.id;
    return res || jsonb_build_object('eaten', true);
  else
    if v_live then perform public.void_food(i.food_log_id); end if;
    update app.mp_week_items set food_log_id = null where id = i.id;
    return jsonb_build_object('eaten', false);
  end if;
end $$;

-- Zelf een maaltijd toevoegen aan een dag (bestaat het vak al, dan vervangen)
create or replace function public.mp_item_add(p_week_id bigint, p_day date, p_slot text, p_recipe_id bigint, p_portions numeric default 1)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_start date; v_id bigint;
begin
  perform app.assert_owner();
  select week_start into v_start from app.mp_weeks where id = p_week_id;
  if v_start is null then raise exception 'Week niet gevonden'; end if;
  if p_day < v_start or p_day > v_start + 6 then raise exception 'Die dag hoort niet bij deze week'; end if;
  if p_slot not in ('ontbijt','lunch','snack','avond','avondsnack') then raise exception 'Onbekende maaltijd'; end if;
  if p_portions is null or p_portions <= 0 or p_portions > 6 then raise exception 'Kies tussen 0,25 en 6 porties'; end if;
  if not exists (select 1 from app.mp_recipes where id = p_recipe_id and status = 'klaar' and not hidden) then
    raise exception 'Dit recept is nog niet klaar';
  end if;
  insert into app.mp_week_items (week_id, day, slot, recipe_id, portions) values (p_week_id, p_day, p_slot, p_recipe_id, p_portions)
  on conflict (week_id, day, slot) do update set recipe_id = excluded.recipe_id, portions = excluded.portions
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.mp_item_remove(p_item_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  delete from app.mp_week_items where id = p_item_id;
end $$;

do $$ declare fn text; begin
  foreach fn in array array['mp_item_eaten(bigint,boolean)', 'mp_item_add(bigint,date,text,bigint,numeric)', 'mp_item_remove(bigint)', 'mp_get()'] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;
