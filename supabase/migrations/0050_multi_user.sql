-- 0050: Health Hub voor meerdere gebruikers.
-- Elke gebruikerstabel krijgt user_id (bestaande data = Simon), sleutels worden per gebruiker,
-- Row Level Security filtert alles op app.uid(). De RPC-functies draaien voortaan als rol hh_app
-- (zonder BYPASSRLS), zodat elke functie automatisch alleen de data van de ingelogde gebruiker ziet.
--
-- Wie is "de gebruiker" (app.uid()):
--   1. ingelogde gebruiker: sub uit de JWT (kan niet vervalst worden)
--   2. edge function met service-sleutel: header x-hh-user (alleen geldig bij role = service_role)
--   3. achtergrondtaken (pg_cron, triggers): GUC app.uid
--   4. OVERGANG: service-sleutel of postgres zonder gebruiker -> de eerste beheerder (Simon).
--      Moet weg (app.settings legacy_fallback = false) voor de registratie opengaat.

-- ---------------------------------------------------------------- rol en helpers
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'hh_app') then
    create role hh_app nologin nobypassrls;
  end if;
end $$;
grant hh_app to postgres;
grant usage, create on schema app, health, public to hh_app;
grant usage on schema auth to hh_app;
grant execute on function auth.uid() to hh_app;
grant usage on schema ai to hh_app;

create table if not exists app.config (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
alter table app.config enable row level security;
insert into app.config (key, value) values ('legacy_fallback', 'true'::jsonb), ('legacy_user', to_jsonb('eecf2f83-eee9-450c-b1cc-05176bfab8a8'::text))
on conflict (key) do nothing;

create or replace function app.uid() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare c jsonb; h jsonb; u text;
begin
  c := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  if c ? 'sub' and nullif(c->>'sub', '') is not null then return (c->>'sub')::uuid; end if;
  if coalesce(c->>'role', '') = 'service_role' then
    h := nullif(current_setting('request.headers', true), '')::jsonb;
    u := nullif(h->>'x-hh-user', '');
    if u is not null then return u::uuid; end if;
  end if;
  u := nullif(current_setting('app.uid', true), '');
  if u is not null then return u::uuid; end if;
  -- overgang: service-sleutel of postgres (pg_cron, Claude-taken) zonder gebruiker
  if (c is null or coalesce(c->>'role', '') = 'service_role')
     and coalesce((select value::text from app.config where key = 'legacy_fallback'), 'false') = 'true' then
    return ((select value #>> '{}' from app.config where key = 'legacy_user'))::uuid;
  end if;
  return null;
end $$;
grant execute on function app.uid() to hh_app, authenticated, anon, service_role, ai_reader;

-- profiel per gebruiker (toestemming GDPR, weergavenaam)
create table if not exists app.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  consent_at timestamptz,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);
alter table app.profiles enable row level security;
insert into app.profiles (user_id, display_name, consent_at, is_admin)
select user_id, 'Simon', now(), true from app.owners on conflict (user_id) do nothing;

-- ---------------------------------------------------------------- user_id op elke gebruikerstabel
do $$
declare t text;
  simon uuid := 'eecf2f83-eee9-450c-b1cc-05176bfab8a8';
  tabs text[] := array[
    'app.ah_basket_sync','app.ai_usage','app.briefing_replies','app.briefings','app.capture_inbox','app.chat_messages',
    'app.coach_feedback','app.coach_sessions','app.exercise_prefs','app.feedback_queue','app.food_log','app.foods',
    'app.garmin_auth','app.garmin_pull_log','app.habit_log','app.habits','app.ingest_log','app.insights','app.journal',
    'app.meal_presets','app.menu_rebalance','app.menu_wishes','app.mp_list_checks','app.mp_list_extras','app.mp_list_recipes',
    'app.mp_recipes','app.mp_week_items','app.mp_weeks','app.push_outbox','app.push_subscriptions','app.recipe_inbox',
    'app.rest_timers','app.routines','app.settings','app.store_products','app.sync_requests','app.sync_state',
    'app.wake_events','app.workout_templates',
    'health.hevy_sets','health.hevy_workouts','health.metric_samples','health.sleep_segments','health.sleep_summaries','health.workouts'];
begin
  foreach t in array tabs loop
    execute format('alter table %s add column if not exists user_id uuid', t);
    execute format('update %s set user_id = %L where user_id is null', t, simon);
    execute format('alter table %s alter column user_id set default app.uid(), alter column user_id set not null', t);
    execute format('alter table %s add constraint %I foreign key (user_id) references auth.users(id) on delete cascade', t,
                   replace(t, '.', '_') || '_user_fk');
    execute format('create index if not exists %I on %s (user_id)', replace(t, '.', '_') || '_user_idx', t);
    execute format('alter table %s enable row level security', t);
    execute format('drop policy if exists hh_own on %s', t);
    execute format('create policy hh_own on %s for all to hh_app, authenticated, ai_reader using (user_id = app.uid()) with check (user_id = app.uid())', t);
  end loop;
end $$;

-- globale instellingen (VAPID-sleutel e.d.) onder een systeemgebruiker die iedereen mag lezen
-- (geen FK: dit is geen echte gebruiker)
alter table app.settings drop constraint app_settings_user_fk;
update app.settings set user_id = '00000000-0000-0000-0000-000000000000' where key in ('vapid_public', 'ai_model');
create policy hh_system_read on app.settings for select to hh_app, authenticated, ai_reader
  using (user_id = '00000000-0000-0000-0000-000000000000');

-- gedeelde bibliotheken
create policy hh_read_all on health.metric_catalog for select to hh_app, authenticated, ai_reader using (true);
create policy hh_read_all on health.hevy_exercise_templates for select to hh_app, authenticated, ai_reader using (true);
create policy hh_write_all on health.hevy_exercise_templates for insert to hh_app with check (true);
create policy hh_update_all on health.hevy_exercise_templates for update to hh_app using (true) with check (true);
create policy hh_own on app.profiles for all to hh_app, authenticated using (user_id = app.uid()) with check (user_id = app.uid());

-- ---------------------------------------------------------------- sleutels per gebruiker
alter table health.metric_samples drop constraint metric_samples_pkey, add primary key (user_id, metric, ts);
alter table health.sleep_summaries drop constraint sleep_summaries_pkey, add primary key (user_id, day, source);
alter table health.sleep_segments drop constraint sleep_segments_pkey, add primary key (user_id, start_ts, stage);
alter table health.workouts drop constraint workouts_pkey, add primary key (user_id, id);
alter table app.sync_state drop constraint sync_state_pkey, add primary key (user_id, source);
alter table app.settings drop constraint settings_pkey, add primary key (user_id, key);
alter table app.briefings drop constraint briefings_pkey, add primary key (user_id, day);
alter table app.journal drop constraint journal_pkey, add primary key (user_id, day);
alter table app.exercise_prefs drop constraint exercise_prefs_pkey, add primary key (user_id, title);
alter table app.ai_usage drop constraint ai_usage_pkey, add primary key (user_id, day, model);
alter table app.garmin_auth drop constraint garmin_auth_pkey, add primary key (user_id);
alter table app.push_subscriptions drop constraint push_subscriptions_pkey, add primary key (user_id, endpoint);
do $$
declare r record;
begin
  for r in select conrelid::regclass::text t, conname, pg_get_constraintdef(oid) d from pg_constraint
    where contype = 'u' and conrelid::regclass::text in
      ('app.coach_feedback','app.coach_sessions','app.feedback_queue','app.foods','app.mp_weeks','app.store_products') loop
    execute format('alter table %s drop constraint %I', r.t, r.conname);
    execute format('alter table %s add constraint %I %s', r.t, r.conname, replace(r.d, 'UNIQUE (', 'UNIQUE (user_id, '));
  end loop;
end $$;
do $$
declare r record;
begin
  for r in select schemaname || '.' || indexname i, indexdef d from pg_indexes
    where schemaname = 'app' and tablename = 'mp_recipes' and indexdef ilike '%unique%lower(name)%' loop
    execute format('drop index %s', r.i);
    execute replace(r.d, '(lower(name))', '(user_id, lower(name))');
  end loop;
end $$;

-- ---------------------------------------------------------------- views: rechten van de opvrager
do $$
declare v text;
begin
  for v in select schemaname || '.' || viewname from pg_views where schemaname = 'ai' loop
    execute format('alter view %s set (security_invoker = true)', v);
  end loop;
end $$;

-- ---------------------------------------------------------------- rechten voor hh_app
grant select, insert, update, delete on all tables in schema app, health to hh_app;
grant usage, select on all sequences in schema app, health to hh_app;
grant select on all tables in schema ai to hh_app;
grant execute on all functions in schema app, health to hh_app;
revoke all on app.config from hh_app;
grant select on all tables in schema app, health to ai_reader;

-- ---------------------------------------------------------------- functies: ON CONFLICT per gebruiker
do $$
declare r record; d text; n text;
begin
  for r in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname in ('public', 'app', 'health') and p.prokind = 'f' and p.prosrc ~* 'on conflict'
      and p.proname !~ '^(quiz_|meal_data|meal_favorite)' loop
    d := pg_get_functiondef(r.oid);
    n := d;
    n := regexp_replace(n, 'on conflict\s*\(\s*metric\s*,\s*ts\s*\)', 'on conflict (user_id, metric, ts)', 'gi');
    n := regexp_replace(n, 'on conflict\s*\(\s*day\s*,\s*source\s*\)', 'on conflict (user_id, day, source)', 'gi');
    n := regexp_replace(n, 'on conflict\s*\(\s*start_ts\s*,\s*stage\s*\)', 'on conflict (user_id, start_ts, stage)', 'gi');
    n := regexp_replace(n, 'on conflict\s*\(\s*source\s*\)', 'on conflict (user_id, source)', 'gi');
    n := regexp_replace(n, 'on conflict\s*\(\s*ref\s*\)', 'on conflict (user_id, ref)', 'gi');
    n := regexp_replace(n, 'on conflict\s*\(\s*week_start\s*\)', 'on conflict (user_id, week_start)', 'gi');
    n := regexp_replace(n, 'on conflict\s*\(\s*day\s*,\s*model\s*\)', 'on conflict (user_id, day, model)', 'gi');
    n := regexp_replace(n, 'on conflict\s*\(\s*day\s*\)', 'on conflict (user_id, day)', 'gi');
    n := regexp_replace(n, 'on conflict\s*\(\s*key\s*\)', 'on conflict (user_id, key)', 'gi');
    n := regexp_replace(n, 'on conflict\s*\(\s*barcode\s*\)', 'on conflict (user_id, barcode)', 'gi');
    n := regexp_replace(n, 'on conflict\s*\(\s*endpoint\s*\)', 'on conflict (user_id, endpoint)', 'gi');
    n := regexp_replace(n, 'on conflict\s*\(\s*title\s*\)', 'on conflict (user_id, title)', 'gi');
    n := regexp_replace(n, 'on conflict\s*\(\s*day\s*,\s*kind\s*\)', 'on conflict (user_id, day, kind)', 'gi');
    n := regexp_replace(n, 'on conflict\s*\(\s*kind\s*,\s*day\s*,\s*ref\s*\)', 'on conflict (user_id, kind, day, ref)', 'gi');
    n := regexp_replace(n, 'on conflict\s*\(\s*name\s*,\s*store\s*\)', 'on conflict (user_id, name, store)', 'gi');
    -- (id) alleen voor health.workouts en garmin_auth (Hevy-id's blijven globaal uniek: een view hangt van die sleutel af)
    n := regexp_replace(n, '(insert into\s+health\.workouts\M[^;]*?on conflict\s*)\(\s*id\s*\)', '\1(user_id, id)', 'gi');
    n := regexp_replace(n, '(insert into\s+app\.garmin_auth\M[^;]*?on conflict\s*)\(\s*id\s*\)', '\1(user_id)', 'gi');
    if n <> d then execute n; end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- functies draaien als hh_app (RLS geldt)
-- Gebruikersfuncties en hun helpers. Functies die over alle gebruikers moeten kijken
-- (wachtrijen, push, sleutels, tokens) blijven van postgres en worden apart per gebruiker gemaakt.
do $$
declare r record;
  keep text[] := array[
    'app.assert_owner','app.is_owner','app.uid','app.get_secret','app.claim_first_owner','app.agent_kick','app.garmin_pull_kick',
    'app.sync_request_kick','app.tts_kick','app.feedback_enqueue','app.mp_recipe_macros_changed','app.creatine_nudge',
    'public.am_i_owner','public.ai_schema_doc','public.internal_agent_pending','public.internal_agent_claim','public.internal_agent_finish',
    'public.internal_claim_outbox','public.internal_push_targets','public.internal_push_result','public.internal_claim_due_routines',
    'public.internal_get_secret','public.internal_is_owner','public.internal_shortcut_key_ok','public.internal_capture_image',
    'public.internal_timer_get','public.internal_timer_mark','public.internal_garmin_auth_get','public.internal_garmin_auth_save',
    'public.internal_garmin_pull_fail','public.set_secret','public.rotate_ingest_token'];
begin
  for r in select p.oid, s.nspname || '.' || p.proname fn from pg_proc p join pg_namespace s on s.oid = p.pronamespace
    where s.nspname in ('public', 'app', 'health') and p.prokind = 'f' and p.prosecdef
      and p.proname !~ '^(quiz_|meal_data|meal_favorite)'
      and not exists (select 1 from pg_depend dd where dd.objid = p.oid and dd.deptype = 'e') loop
    if not (r.fn = any(keep)) then
      execute format('alter function %s owner to hh_app', r.oid::regprocedure);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- toegang: elke gebruiker met toestemming
create or replace function app.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.profiles p where p.user_id = app.uid() and p.consent_at is not null);
$$;
create or replace function app.assert_owner() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if app.uid() is null or not app.is_owner() then
    raise exception 'Geen toegang' using errcode = '42501';
  end if;
end $$;
create or replace function public.internal_is_owner(p_uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.profiles where user_id = p_uid and consent_at is not null);
$$;

-- nieuwe gebruiker: profiel en standaardinstellingen (toestemming geeft hij zelf in de app)
create or replace function app.claim_first_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into app.profiles (user_id, display_name) values (new.id, split_part(coalesce(new.email, ''), '@', 1))
  on conflict (user_id) do nothing;
  insert into app.settings (user_id, key, value)
  values (new.id, 'goals', '{"kcal_in": 2000, "protein_g": 140, "carbs_g": 230, "fat_g": 65, "fiber_g": 30, "water_ml": 2500, "steps": 8000, "sleep_h": 8, "active_kcal": 500, "caffeine_mg": 400}'::jsonb)
  on conflict do nothing;
  return new;
end $$;

-- toestemming geven / account verwijderen (GDPR)
create or replace function public.accept_terms(p_name text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid();
begin
  if u is null then raise exception 'Niet ingelogd' using errcode = '42501'; end if;
  insert into app.profiles (user_id, display_name, consent_at) values (u, nullif(btrim(p_name), ''), now())
  on conflict (user_id) do update set consent_at = coalesce(app.profiles.consent_at, now()),
    display_name = coalesce(nullif(btrim(p_name), ''), app.profiles.display_name);
  return (select to_jsonb(p) from app.profiles p where p.user_id = u);
end $$;
grant execute on function public.accept_terms(text) to authenticated;

create or replace function public.get_profile() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object('user_id', user_id, 'display_name', display_name, 'consent_at', consent_at, 'is_admin', is_admin)
    from app.profiles where user_id = auth.uid()), jsonb_build_object('user_id', auth.uid(), 'consent_at', null));
$$;
grant execute on function public.get_profile() to authenticated;

create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid();
begin
  if u is null then raise exception 'Niet ingelogd' using errcode = '42501'; end if;
  if exists (select 1 from app.profiles where user_id = u and is_admin) then
    raise exception 'De beheerder kan zijn account niet zelf verwijderen';
  end if;
  delete from app.settings where user_id = u;
  delete from auth.users where id = u;  -- alle andere data volgt via ON DELETE CASCADE
end $$;
grant execute on function public.delete_my_account() to authenticated;

-- ---------------------------------------------------------------- sleutels per gebruiker (Gemini, Hevy, ingest-token)
create table if not exists app.user_secrets (
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  value text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, name)
);
alter table app.user_secrets enable row level security;  -- geen policies: alleen via de functies hieronder
revoke all on app.user_secrets from hh_app, ai_reader, authenticated, anon;

-- eigen sleutel eerst; voor de oorspronkelijke gebruiker blijven de oude Vault-sleutels werken
create or replace function app.get_secret(p_name text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select value from app.user_secrets where user_id = app.uid() and name = p_name),
    case when app.uid() = ((select value #>> '{}' from app.config where key = 'legacy_user'))::uuid
         then (select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1) end);
$$;
grant execute on function app.get_secret(text) to hh_app;

create or replace function public.set_secret(p_name text, p_value text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  if p_name not in ('hevy_api_key', 'gemini_api_key') then raise exception 'Onbekende sleutel %', p_name; end if;
  if nullif(btrim(p_value), '') is null then
    delete from app.user_secrets where user_id = app.uid() and name = p_name;
  else
    insert into app.user_secrets (user_id, name, value) values (app.uid(), p_name, btrim(p_value))
    on conflict (user_id, name) do update set value = excluded.value, updated_at = now();
  end if;
end $$;

create or replace function public.rotate_ingest_token() returns text
language plpgsql security definer set search_path = '' as $$
declare tok text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  perform app.assert_owner();
  insert into app.user_secrets (user_id, name, value) values (app.uid(), 'ingest_token', tok)
  on conflict (user_id, name) do update set value = excluded.value, updated_at = now();
  return tok;
end $$;

-- edge functions: welke gebruiker hoort bij een token (ingest-health, Opdrachten)?
create or replace function public.internal_user_by_secret(p_name text, p_value text) returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select user_id from app.user_secrets where name = p_name and value = p_value and length(p_value) >= 16 limit 1),
    case when exists (select 1 from vault.decrypted_secrets where name = p_name and decrypted_secret = p_value and length(p_value) >= 16)
         then ((select value #>> '{}' from app.config where key = 'legacy_user'))::uuid end);
$$;
revoke all on function public.internal_user_by_secret(text, text) from public, anon, authenticated;
grant execute on function public.internal_user_by_secret(text, text) to service_role;

-- ---------------------------------------------------------------- AI-SQL: altijd binnen de eigen gebruiker
create or replace function public.internal_agent_read(q text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb; s text := regexp_replace(btrim(q), ';\s*$', ''); bare text;
begin
  if app.uid() is null then raise exception 'Geen gebruiker'; end if;
  bare := app.sql_strip_literals(s);
  if bare ~ ';' or s !~* '^(select|with)\s' then raise exception 'Alleen één SELECT- of WITH-query'; end if;
  if bare ~* '\m(insert|update|delete|drop|alter|grant|revoke|truncate|create|copy|vacuum|pg_read_file|pg_ls_dir|pg_read_binary_file|lo_import|dblink|set_config|current_setting|get_secret|user_secrets|vault|auth|internal_\w*|set_secret|config)\M' then
    raise exception 'Niet toegestaan in een leesquery';
  end if;
  set local transaction_read_only = on;
  set local statement_timeout = '8s';
  execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) s limit 200) t', s) into r;
  return r;
end $$;
alter function public.internal_agent_read(text) owner to hh_app;

create or replace function public.internal_agent_write(q text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb; s text := regexp_replace(btrim(q), ';\s*$', ''); n int; bare text; u uuid := app.uid();
begin
  if u is null then raise exception 'Geen gebruiker'; end if;
  bare := app.sql_strip_literals(s);
  if bare ~ ';' then raise exception 'Eén statement per keer'; end if;
  if bare ~* '\m(delete|drop|alter|grant|revoke|truncate|create|copy|execute|pg_read_file|dblink|set_config|current_setting|get_secret|user_secrets|vault|auth|internal_\w*|set_secret|config|user_id)\M' then raise exception 'Niet toegestaan'; end if;
  if not (
       s ~* '^(insert\s+into|update)\s+app\.(mp_week_items|mp_recipes|mp_weeks|menu_wishes|capture_inbox|briefing_replies|recipe_inbox|menu_rebalance|push_outbox|coach_sessions|store_products|foods|coach_feedback)\M'
    or s ~* '^select\s+public\.(log_food|log_entry|save_food|mp_set_portion_step|copy_food_items|void_food|mp_item_remove|mp_item_add)\s*\('
  ) then
    raise exception 'Alleen INSERT/UPDATE op toegestane app-tabellen of select public.log_food/log_entry/save_food/mp_set_portion_step/copy_food_items/void_food/mp_item_remove/mp_item_add(...)';
  end if;
  -- de aangeroepen functies zien dezelfde gebruiker
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
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
alter function public.internal_agent_write(text) owner to hh_app;
revoke all on function public.internal_agent_read(text), public.internal_agent_write(text) from public, anon, authenticated;
grant execute on function public.internal_agent_read(text), public.internal_agent_write(text) to service_role;
