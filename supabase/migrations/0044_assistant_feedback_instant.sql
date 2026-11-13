-- AI-bolletje: gesprekkenlijst; feedback na een training meteen via de agent.

-- Gesprekken
alter table app.chat_messages add column if not exists hidden boolean not null default false;

create or replace function public.get_chats(p_limit int default 30)
 returns jsonb language plpgsql stable security definer set search_path to ''
as $$
begin
  perform app.assert_owner();
  return coalesce((select jsonb_agg(c order by c.last_at desc) from (
    select conversation_id as id,
           left((array_agg(content order by id) filter (where role = 'user'))[1], 70) as title,
           max(created_at) as last_at, count(*) as n
    from app.chat_messages where not hidden
    group by conversation_id order by max(created_at) desc limit greatest(1, least(p_limit, 100))) c), '[]'::jsonb);
end $$;
grant execute on function public.get_chats(int) to authenticated;

create or replace function public.chat_hide(p_conversation uuid)
 returns void language plpgsql security definer set search_path to ''
as $$
begin
  perform app.assert_owner();
  update app.chat_messages set hidden = true where conversation_id = p_conversation;
end $$;
grant execute on function public.chat_hide(uuid) to authenticated;

-- Feedback-wachtrij: nieuwe training -> agent schrijft meteen feedback
create table if not exists app.feedback_queue (
  id bigserial primary key,
  ref text not null unique,
  sport text not null,
  status text not null default 'nieuw',
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
alter table app.feedback_queue enable row level security;

create or replace function app.feedback_enqueue()
 returns trigger language plpgsql security definer set search_path to ''
as $$
begin
  if tg_table_name = 'workouts' then
    if new.source = 'Garmin' and new.day >= (now() at time zone 'Europe/Brussels')::date - 1
       and coalesce(new.name, '') !~* 'strength|kracht|functional'
       and not exists (select 1 from app.coach_feedback f where f.kind = 'training' and f.ref = new.id) then
      insert into app.feedback_queue (ref, sport) values (new.id, 'cardio') on conflict (ref) do nothing;
    end if;
  else
    if new.deleted_at is null and new.start_ts > now() - interval '2 days'
       and not exists (select 1 from app.coach_feedback f where f.kind = 'training' and f.ref = new.id::text) then
      insert into app.feedback_queue (ref, sport) values (new.id::text, 'kracht') on conflict (ref) do nothing;
    end if;
  end if;
  return new;
exception when others then return new;
end $$;

drop trigger if exists feedback_enqueue on health.workouts;
create trigger feedback_enqueue after insert on health.workouts for each row execute function app.feedback_enqueue();
drop trigger if exists feedback_enqueue on health.hevy_workouts;
create trigger feedback_enqueue after insert on health.hevy_workouts for each row execute function app.feedback_enqueue();
drop trigger if exists agent_kick on app.feedback_queue;
create trigger agent_kick after insert on app.feedback_queue for each row execute function app.agent_kick('feedback');

-- Agent: claim/pending/finish kennen nu ook 'feedback'; schrijven in app.coach_feedback mag
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
    when 'feedback' then update app.feedback_queue set status = 'bezig' where id = p_id and status = 'nieuw' returning to_jsonb(feedback_queue.*) into r;
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
    union all select 'feedback', id from app.feedback_queue where status = 'nieuw'
  ) x;
$$;

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
  elsif p_kind = 'feedback' then
    -- mislukt: niet opnieuw proberen; de uurlijkse Claude-taak schrijft dan de feedback
    update app.feedback_queue set status = case when p_ok then 'klaar' else 'fout' end, processed_at = now() where id = p_id;
  end if;
end $$;

create or replace function public.internal_agent_write(q text)
 returns jsonb language plpgsql security definer set search_path to ''
as $$
declare r jsonb; s text := regexp_replace(btrim(q), ';\s*$', ''); n int; bare text;
begin
  bare := app.sql_strip_literals(s);
  if bare ~ ';' then raise exception 'Eén statement per keer'; end if;
  if bare ~* '\m(delete|drop|alter|grant|revoke|truncate|create|copy|execute|pg_read_file|dblink|set_config)\M' then raise exception 'Niet toegestaan'; end if;
  if not (
       s ~* '^(insert\s+into|update)\s+app\.(mp_week_items|mp_recipes|mp_weeks|menu_wishes|capture_inbox|briefing_replies|recipe_inbox|menu_rebalance|push_outbox|coach_sessions|store_products|foods|coach_feedback)\M'
    or s ~* '^select\s+public\.(log_food|log_entry|save_food|mp_set_portion_step|copy_food_items|void_food)\s*\('
  ) then
    raise exception 'Alleen INSERT/UPDATE op toegestane app-tabellen of select public.log_food/log_entry/save_food/mp_set_portion_step/copy_food_items/void_food(...)';
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
end $$;

