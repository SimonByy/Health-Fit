-- Garmin via athletedata MCP: elke 10 min + direct bij de sync-knop.
create extension if not exists pg_net;

create table if not exists app.athletedata_raw (
  id bigserial primary key,
  fetched_at timestamptz not null default now(),
  hash text not null,
  payload jsonb not null,
  errors text[]
);
alter table app.athletedata_raw enable row level security;
create index if not exists athletedata_raw_fetched on app.athletedata_raw (fetched_at desc);

create or replace function public.internal_athletedata_set(p_key text, p_value jsonb)
 returns void language sql security definer set search_path to '' as $$
  insert into app.settings(key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value, updated_at = now();
$$;
create or replace function public.internal_athletedata_get(p_key text)
 returns jsonb language sql stable security definer set search_path to '' as $$
  select value from app.settings where key = p_key;
$$;

-- Vertaalt de ruwe athletedata-antwoorden naar het formaat van health.ingest_garmin_raw.
-- Wordt ingevuld na ?mode=discover (toolnamen en vormen zijn dan bekend). Tot dan: null = alleen opslaan.
create or replace function app.athletedata_map(p_raw jsonb)
 returns jsonb language sql immutable set search_path to '' as $$ select null::jsonb $$;

create or replace function public.internal_athletedata_ingest(p_raw jsonb, p_errors text[] default '{}')
 returns jsonb language plpgsql security definer set search_path to '' as $$
declare h text := md5(p_raw::text); prev text; mapped jsonb; res jsonb; changed boolean;
begin
  select hash into prev from app.athletedata_raw order by id desc limit 1;
  changed := prev is distinct from h;
  if changed then
    insert into app.athletedata_raw(hash, payload, errors) values (h, p_raw, p_errors);
    delete from app.athletedata_raw where fetched_at < now() - interval '3 days';
    mapped := app.athletedata_map(p_raw);
    if mapped is not null then res := health.ingest_garmin_raw(mapped); end if;
  end if;
  insert into app.sync_state(source, last_run, last_success, last_error, last_items)
  values ('garmin', now(), case when coalesce(array_length(p_errors,1),0) = 0 then now() end,
          nullif(array_to_string(p_errors, ' | '), ''), null)
  on conflict (source) do update set last_run = excluded.last_run,
    last_success = coalesce(excluded.last_success, app.sync_state.last_success),
    last_error = excluded.last_error;
  update app.sync_requests set done_at = now(), note = 'athletedata'
   where source = 'garmin' and done_at is null and (mapped is not null or not changed);
  return jsonb_build_object('changed', changed, 'ingested', mapped is not null, 'result', res);
end $$;

revoke all on function public.internal_athletedata_set(text, jsonb) from public, anon, authenticated;
revoke all on function public.internal_athletedata_get(text) from public, anon, authenticated;
revoke all on function public.internal_athletedata_ingest(jsonb, text[]) from public, anon, authenticated;

-- aanroep vanuit SQL
create or replace function app.athletedata_kick()
 returns void language sql security definer set search_path to '' as $$
  select net.http_post(
    url := 'https://jzqqriddjpcigmxmnaug.supabase.co/functions/v1/garmin-pull',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_token')),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
$$;

-- sync-knop: nieuwe sync_request -> meteen ophalen
create or replace function app.sync_request_kick()
 returns trigger language plpgsql security definer set search_path to '' as $$
begin
  if new.source = 'garmin' then perform app.athletedata_kick(); end if;
  return new;
end $$;
drop trigger if exists sync_requests_kick on app.sync_requests;
create trigger sync_requests_kick after insert on app.sync_requests
  for each row execute function app.sync_request_kick();

-- elke 10 minuten tussen 6u en 24u (UTC-tijden: cron draait in UTC; ruim genomen)
select cron.unschedule('garmin-pull') where exists (select 1 from cron.job where jobname = 'garmin-pull');
select cron.schedule('garmin-pull', '*/10 4-23 * * *', $$ select app.athletedata_kick() $$);
