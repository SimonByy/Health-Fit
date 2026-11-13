-- Directe verwerking door de AI-agent (edge function "agent", Gemini) in plaats van elk uur.
-- Bij een nieuwe rij roept de databank meteen de agent aan (pg_net). Lukt het de agent niet,
-- dan blijft de rij op 'nieuw' en pikt de uurlijkse Claude-taak ze op.

create extension if not exists pg_net;

-- Tekst tussen aanhalingstekens weglaten voor de veiligheidscontroles (zodat "do 20/11" in een notitie geen fout geeft)
create or replace function app.sql_strip_literals(s text)
 returns text language sql immutable set search_path to ''
as $f$ select regexp_replace(regexp_replace(s, '\$([A-Za-z_]*)\$.*?\$\1\$', '$$', 'g'), '''(?:[^'']|'''')*''', '''''', 'g') $f$;

-- Lezen: één SELECT/WITH, alleen-lezen transactie, max 200 rijen
create or replace function public.internal_agent_read(q text)
 returns jsonb language plpgsql security definer set search_path to ''
as $$
declare r jsonb; s text := regexp_replace(btrim(q), ';\s*$', ''); bare text;
begin
  bare := app.sql_strip_literals(s);
  if bare ~ ';' or s !~* '^(select|with)\s' then raise exception 'Alleen één SELECT- of WITH-query'; end if;
  if bare ~* '\m(insert|update|delete|drop|alter|grant|revoke|truncate|create|copy|vacuum|pg_read_file|pg_ls_dir|pg_read_binary_file|lo_import|dblink|set_config)\M' then
    raise exception 'Niet toegestaan in een leesquery';
  end if;
  set local transaction_read_only = on;
  set local statement_timeout = '8s';
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) s limit 200) t', s) into r;
  return r;
end $$;
revoke all on function public.internal_agent_read(text) from public, anon, authenticated;
grant execute on function public.internal_agent_read(text) to service_role;

-- Schrijven: alleen INSERT/UPDATE op een vaste lijst tabellen, of een vaste lijst functies
create or replace function public.internal_agent_write(q text)
 returns jsonb language plpgsql security definer set search_path to ''
as $$
declare r jsonb; s text := regexp_replace(btrim(q), ';\s*$', ''); n int; bare text;
begin
  bare := app.sql_strip_literals(s);
  if bare ~ ';' then raise exception 'Eén statement per keer'; end if;
  if bare ~* '\m(delete|drop|alter|grant|revoke|truncate|create|copy|execute|pg_read_file|dblink|set_config)\M' then raise exception 'Niet toegestaan'; end if;
  if not (
       s ~* '^(insert\s+into|update)\s+app\.(mp_week_items|mp_recipes|mp_weeks|menu_wishes|capture_inbox|briefing_replies|recipe_inbox|menu_rebalance|push_outbox|coach_sessions|store_products|foods)\M'
    or s ~* '^select\s+public\.(log_food|log_entry|save_food|mp_set_portion_step|copy_food_items|void_food)\s*\('
  ) then
    raise exception 'Alleen INSERT/UPDATE op toegestane app-tabellen of select public.log_food/log_entry/save_food/mp_set_portion_step/copy_food_items/void_food(...)';
  end if;
  -- eigenaar-functies verwachten een ingelogde eigenaar
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
end $$;
revoke all on function public.internal_agent_write(text) from public, anon, authenticated;
grant execute on function public.internal_agent_write(text) to service_role;

-- Een item claimen (zodat het niet dubbel verwerkt wordt) en afsluiten
create or replace function public.internal_agent_claim(p_kind text, p_id bigint)
 returns jsonb language plpgsql security definer set search_path to ''
as $$
declare r jsonb;
begin
  case p_kind
    when 'wish' then update app.menu_wishes set status = 'bezig' where id = p_id and status = 'nieuw' returning to_jsonb(menu_wishes.*) into r;
    when 'capture' then update app.capture_inbox set status = 'bezig' where id = p_id and status = 'nieuw' returning to_jsonb(capture_inbox.*) into r;
    when 'reply' then update app.briefing_replies set status = 'bezig' where id = p_id and status = 'nieuw' returning to_jsonb(briefing_replies.*) into r;
    when 'recipe' then update app.recipe_inbox set status = 'bezig' where id = p_id and status = 'nieuw' returning to_jsonb(recipe_inbox.*) into r;
    when 'rebalance' then update app.menu_rebalance set note = 'bezig' where id = p_id and done_at is null and coalesce(note, '') <> 'bezig' returning to_jsonb(menu_rebalance.*) into r;
    else raise exception 'Onbekend soort %', p_kind;
  end case;
  return r;
end $$;

create or replace function public.internal_agent_pending()
 returns jsonb language sql stable security definer set search_path to ''
as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select 'wish' kind, id from app.menu_wishes where status = 'nieuw'
    union all select 'capture', id from app.capture_inbox where status = 'nieuw'
    union all select 'reply', id from app.briefing_replies where status = 'nieuw'
    union all select 'recipe', id from app.recipe_inbox where status = 'nieuw'
    union all select 'rebalance', id from app.menu_rebalance where done_at is null and coalesce(note, '') <> 'bezig'
  ) x;
$$;

-- ok = true: klaar met boodschap; ok = false: terug op 'nieuw' zodat de Claude-taak het oppikt
create or replace function public.internal_agent_finish(p_kind text, p_id bigint, p_ok boolean, p_msg text, p_extra jsonb default '{}'::jsonb)
 returns void language plpgsql security definer set search_path to ''
as $$
begin
  if p_kind = 'wish' then
    update app.menu_wishes set status = case when p_ok then 'klaar' else 'nieuw' end,
      answer = case when p_ok then p_msg else answer end, processed_at = case when p_ok then now() end where id = p_id;
  elsif p_kind = 'capture' then
    update app.capture_inbox set status = case when p_ok then 'klaar' else 'nieuw' end,
      result = case when p_ok then p_msg else result end, kind = coalesce(p_extra->>'kind', kind),
      processed_at = case when p_ok then now() end where id = p_id;
  elsif p_kind = 'reply' then
    update app.briefing_replies set status = case when p_ok then 'klaar' else 'nieuw' end,
      answer = case when p_ok then p_msg else answer end, answered_at = case when p_ok then now() end where id = p_id;
  elsif p_kind = 'recipe' then
    update app.recipe_inbox set status = case when p_ok then 'klaar' else 'nieuw' end,
      recipe_id = coalesce((p_extra->>'recipe_id')::bigint, recipe_id),
      processed_at = case when p_ok then now() end, error = null where id = p_id;
  elsif p_kind = 'rebalance' then
    update app.menu_rebalance set done_at = case when p_ok then now() end, note = case when p_ok then p_msg else null end where id = p_id;
  end if;
end $$;
revoke all on function public.internal_agent_claim(text, bigint) from public, anon, authenticated;
revoke all on function public.internal_agent_pending() from public, anon, authenticated;
revoke all on function public.internal_agent_finish(text, bigint, boolean, text, jsonb) from public, anon, authenticated;
grant execute on function public.internal_agent_claim(text, bigint) to service_role;
grant execute on function public.internal_agent_pending() to service_role;
grant execute on function public.internal_agent_finish(text, bigint, boolean, text, jsonb) to service_role;

-- Trigger: meteen de agent aanroepen
create or replace function app.agent_kick()
 returns trigger language plpgsql security definer set search_path to ''
as $$
begin
  perform net.http_post(
    url := 'https://jzqqriddjpcigmxmnaug.supabase.co/functions/v1/agent',
    body := jsonb_build_object('kind', tg_argv[0], 'id', new.id),
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 2000);
  return new;
exception when others then
  return new; -- nooit het opslaan zelf laten mislukken
end $$;

drop trigger if exists agent_kick on app.menu_wishes;
create trigger agent_kick after insert on app.menu_wishes for each row execute function app.agent_kick('wish');
drop trigger if exists agent_kick on app.capture_inbox;
create trigger agent_kick after insert on app.capture_inbox for each row execute function app.agent_kick('capture');
drop trigger if exists agent_kick on app.briefing_replies;
create trigger agent_kick after insert on app.briefing_replies for each row execute function app.agent_kick('reply');
drop trigger if exists agent_kick on app.recipe_inbox;
create trigger agent_kick after insert on app.recipe_inbox for each row execute function app.agent_kick('recipe');
drop trigger if exists agent_kick on app.menu_rebalance;
create trigger agent_kick after insert on app.menu_rebalance for each row execute function app.agent_kick('rebalance');
