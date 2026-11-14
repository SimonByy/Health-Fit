-- De Gemini-agent mag een geplande maaltijd weghalen of toevoegen via de bestaande menu-functies
-- (bv. "maandagavond eet ik uit"), zonder zelf DELETE te mogen schrijven.
create or replace function public.internal_agent_write(q text)
 returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare r jsonb; s text := regexp_replace(btrim(q), ';\s*$', ''); n int; bare text;
begin
  bare := app.sql_strip_literals(s);
  if bare ~ ';' then raise exception 'Eén statement per keer'; end if;
  if bare ~* '\m(delete|drop|alter|grant|revoke|truncate|create|copy|execute|pg_read_file|dblink|set_config)\M' then raise exception 'Niet toegestaan'; end if;
  if not (
       s ~* '^(insert\s+into|update)\s+app\.(mp_week_items|mp_recipes|mp_weeks|menu_wishes|capture_inbox|briefing_replies|recipe_inbox|menu_rebalance|push_outbox|coach_sessions|store_products|foods|coach_feedback)\M'
    or s ~* '^select\s+public\.(log_food|log_entry|save_food|mp_set_portion_step|copy_food_items|void_food|mp_item_remove|mp_item_add)\s*\('
  ) then
    raise exception 'Alleen INSERT/UPDATE op toegestane app-tabellen of select public.log_food/log_entry/save_food/mp_set_portion_step/copy_food_items/void_food/mp_item_remove/mp_item_add(...)';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', (select user_id from app.owners limit 1), 'role', 'authenticated')::text, true);
  set local statement_timeout = '10s';
  if s ~* '^select' then
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from (%s) x', s) into r;
  elsif s ~* '\mreturning\M' then
    execute format('with w as (%s) select coalesce(jsonb_agg(to_jsonb(w)), ''[]''::jsonb) from w', s) into r;
  else
    execute s; get diagnostics n = row_count; r := jsonb_build_object('rows', n);
  end if;
  return r;
end $function$;
revoke all on function public.internal_agent_write(text) from public, anon, authenticated;
grant execute on function public.internal_agent_write(text) to service_role;
