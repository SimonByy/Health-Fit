-- 0051: achtergrondfuncties per gebruiker (push, routines, wachtrij, Opdrachten-sleutel, voorlezen).

-- Systeemsleutels (VAPID, cron) blijven globaal in Vault; gebruikerssleutels per gebruiker.
create or replace function app.get_secret(p_name text) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when p_name in ('gemini_api_key', 'hevy_api_key', 'ingest_token', 'anthropic_api_key') then coalesce(
      (select value from app.user_secrets where user_id = app.uid() and name = p_name),
      case when app.uid() = ((select value #>> '{}' from app.config where key = 'legacy_user'))::uuid
           then (select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1) end)
    else (select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1)
  end;
$$;

create or replace function public.internal_legacy_user() returns uuid
language sql stable security definer set search_path = '' as $$
  select ((select value #>> '{}' from app.config where key = 'legacy_user'))::uuid;
$$;
revoke all on function public.internal_legacy_user() from public, anon, authenticated;
grant execute on function public.internal_legacy_user() to service_role;

-- push: alleen de toestellen en meldingen van de huidige gebruiker
create or replace function public.internal_push_targets() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(sub), '[]'::jsonb) from app.push_subscriptions where active and user_id = app.uid();
$$;
create or replace function public.internal_claim_outbox() returns setof app.push_outbox
language sql security definer set search_path = '' as $$
  update app.push_outbox set sent_at = now()
  where sent_at is null and created_at > now() - interval '1 day' and user_id = app.uid() returning *;
$$;
create or replace function public.internal_claim_due_routines() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare res jsonb; t timestamp := now() at time zone 'Europe/Brussels';
begin
  with due as (
    update app.routines r set last_fired_at = now()
    where r.user_id = app.uid() and r.active and not r.archived
      and extract(isodow from t)::int = any(r.days)
      and t::time >= r.time_local
      and t::time < r.time_local + interval '30 minutes'
      and (r.last_fired_at is null or (r.last_fired_at at time zone 'Europe/Brussels')::date < t::date)
    returning r.*
  )
  select coalesce(jsonb_agg(to_jsonb(due)), '[]'::jsonb) into res from due;
  return res;
end $$;
-- welke gebruikers hebben iets te versturen of een routine?
create or replace function public.internal_push_users() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(distinct u), '[]'::jsonb) from (
    select user_id u from app.push_outbox where sent_at is null and created_at > now() - interval '1 day'
    union select user_id from app.routines where active and not archived
  ) x;
$$;
revoke all on function public.internal_push_users() from public, anon, authenticated;
grant execute on function public.internal_push_users() to service_role;

-- wachtrij voor de AI-agent: met gebruiker
create or replace function public.internal_agent_pending() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select 'wish' kind, id, user_id from app.menu_wishes where status = 'nieuw'
    union all select 'capture', id, user_id from app.capture_inbox where status = 'nieuw'
    union all select 'reply', id, user_id from app.briefing_replies where status = 'nieuw'
    union all select 'recipe', id, user_id from app.recipe_inbox where status = 'nieuw'
    union all select 'rebalance', id, user_id from app.menu_rebalance where done_at is null and coalesce(note, '') <> 'bezig'
    union all select 'feedback', id, user_id from app.feedback_queue where status = 'nieuw'
  ) x;
$$;

-- creatine-herinnering per gebruiker
create or replace function app.creatine_nudge() returns void
language plpgsql security definer set search_path = '' as $$
declare v_now timestamp := now() at time zone 'Europe/Brussels'; v_day date := v_now::date; h record;
begin
  if extract(hour from v_now) <> 19 then return; end if;
  for h in select id, name, user_id from app.habits where not archived and name ilike '%creatine%' loop
    if exists (select 1 from app.habit_log l where l.habit_id = h.id and l.day = v_day and l.done) then continue; end if;
    if exists (select 1 from app.push_outbox o where o.user_id = h.user_id and o.title = 'Creatine 💊'
               and (o.created_at at time zone 'Europe/Brussels')::date = v_day) then continue; end if;
    insert into app.push_outbox (user_id, title, body, url) values (h.user_id, 'Creatine 💊', 'Nog je ' || h.name || ' nemen? Vink het af op Vandaag.', '/#/vandaag');
  end loop;
end $$;

-- Opdrachten-sleutel: welke gebruiker?
create or replace function public.internal_user_by_shortcut_key(p_key text) returns uuid
language sql stable security definer set search_path = '' as $$
  select user_id from app.settings
  where key = 'shortcut_key_sha256' and length(coalesce(p_key, '')) >= 16
    and value #>> '{}' = encode(extensions.digest(p_key, 'sha256'), 'hex')
  limit 1;
$$;
revoke all on function public.internal_user_by_shortcut_key(text) from public, anon, authenticated;
grant execute on function public.internal_user_by_shortcut_key(text) to service_role;
create or replace function public.internal_shortcut_key_ok(p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.internal_user_by_shortcut_key(p_key) is not null;
$$;

-- voorlezen vooraf klaarzetten: met gebruiker en cron-token (de edge function vertrouwt alleen dat)
create or replace function app.tts_kick() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(
    url := 'https://jzqqriddjpcigmxmnaug.supabase.co/functions/v1/tts',
    body := jsonb_build_object('briefing_day', new.day, 'user_id', new.user_id),
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_token')),
    timeout_milliseconds := 2000);
  return new;
exception when others then
  return new;
end $$;

-- trainingsfeedback-wachtrij: altijd binnen de gebruiker van de training zelf
create or replace function app.feedback_enqueue() returns trigger
language plpgsql security definer set search_path = '' as $$
declare d date;
begin
  if tg_table_name = 'workouts' then
    if new.source = 'Garmin' and new.day >= (now() at time zone 'Europe/Brussels')::date - 1
       and coalesce(new.name, '') !~* 'strength|kracht|functional'
       and not exists (select 1 from app.coach_feedback f where f.user_id = new.user_id and f.kind = 'training' and f.ref = new.id) then
      insert into app.feedback_queue (user_id, ref, sport) values (new.user_id, new.id, 'cardio') on conflict (user_id, ref) do nothing;
      update app.coach_sessions set status = 'gedaan'
       where user_id = new.user_id and day = new.day and status = 'gepland' and kind ~* 'z2|run|loop|chill|interval|tempo|long|cardio';
    end if;
  else
    if new.deleted_at is null and new.start_ts > now() - interval '2 days'
       and not exists (select 1 from app.coach_feedback f where f.user_id = new.user_id and f.kind = 'training' and f.ref = new.id::text) then
      insert into app.feedback_queue (user_id, ref, sport) values (new.user_id, new.id::text, 'kracht') on conflict (user_id, ref) do nothing;
      d := (new.start_ts at time zone 'Europe/Brussels')::date;
      update app.coach_sessions set status = 'gedaan'
       where user_id = new.user_id and day = d and status = 'gepland' and kind !~* 'z2|run|loop|chill|interval|tempo|long|cardio';
    end if;
  end if;
  return new;
exception when others then return new;
end $$;
