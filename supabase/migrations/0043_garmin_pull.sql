-- Garmin rechtstreeks (edge function garmin-pull): elke 10 min + direct bij de sync-knop.
create extension if not exists pg_net;

-- Login-sleutel (roterende refresh-token). Geen policies: alleen service role.
create table if not exists app.garmin_auth (
  id int primary key default 1 check (id = 1),
  access_token text, refresh_token text not null, client_id text not null, display_name text,
  updated_at timestamptz not null default now(),
  failed_at timestamptz, last_error text
);
alter table app.garmin_auth enable row level security;

create table if not exists app.garmin_pull_log (
  id bigserial primary key, at timestamptz not null default now(), hash text not null, errors text[]
);
alter table app.garmin_pull_log enable row level security;

create or replace function public.internal_garmin_auth_get()
 returns jsonb language sql stable security definer set search_path to '' as $$
  select to_jsonb(a) - 'id' - 'updated_at' - 'failed_at' - 'last_error' from app.garmin_auth a where id = 1;
$$;

create or replace function public.internal_garmin_auth_save(p jsonb)
 returns void language sql security definer set search_path to '' as $$
  insert into app.garmin_auth (id, access_token, refresh_token, client_id, display_name)
  values (1, p->>'access_token', p->>'refresh_token', p->>'client_id', p->>'display_name')
  on conflict (id) do update set access_token = excluded.access_token, refresh_token = excluded.refresh_token,
    client_id = excluded.client_id, display_name = coalesce(excluded.display_name, app.garmin_auth.display_name),
    updated_at = now(), failed_at = null, last_error = null;
$$;

create or replace function public.internal_garmin_pull_ingest(p_raw jsonb, p_bb_now numeric default null, p_errors text[] default '{}')
 returns jsonb language plpgsql security definer set search_path to '' as $$
declare h text := md5(p_raw::text); prev text; res jsonb; changed boolean;
  tz text := 'Europe/Brussels'; n timestamptz := date_trunc('minute', now());
begin
  select hash into prev from app.garmin_pull_log order by id desc limit 1;
  changed := prev is distinct from h;
  if changed then
    res := health.ingest_garmin_raw(p_raw);
    insert into app.garmin_pull_log(hash, errors) values (h, p_errors);
    delete from app.garmin_pull_log where at < now() - interval '7 days';
  end if;
  if p_bb_now is not null and not exists (
      select 1 from health.metric_samples where metric = 'body_battery_now' and ts > now() - interval '9 minutes'
        and qty = p_bb_now and not coalesce(voided, false)) then
    insert into health.metric_samples (metric, ts, day, hour, qty, units, source)
    values ('body_battery_now', n, (n at time zone tz)::date, extract(hour from n at time zone tz)::smallint, p_bb_now, '%', 'Garmin')
    on conflict (metric, ts) do update set qty = excluded.qty;
  end if;
  insert into app.sync_state(source, last_run, last_success, last_error)
  values ('garmin', now(), now(), nullif(array_to_string(p_errors, ' | '), ''))
  on conflict (source) do update set last_run = now(), last_success = now(), last_error = excluded.last_error;
  update app.sync_requests set done_at = now(), note = 'garmin-pull' where source = 'garmin' and done_at is null;
  return jsonb_build_object('changed', changed, 'result', res, 'bb_now', p_bb_now);
end $$;

-- Mislukt: bij een ongeldige login één pushmelding per dag.
create or replace function public.internal_garmin_pull_fail(p_error text, p_auth boolean default false)
 returns void language plpgsql security definer set search_path to '' as $$
declare last timestamptz;
begin
  update app.sync_state set last_run = now(), last_error = left(p_error, 500) where source = 'garmin';
  if p_auth then
    select failed_at into last from app.garmin_auth where id = 1;
    update app.garmin_auth set failed_at = now(), last_error = left(p_error, 500) where id = 1;
    if last is null or last < now() - interval '1 day' then
      insert into app.push_outbox (title, body, url)
      values ('Garmin opnieuw koppelen', 'De Garmin-login is verlopen. Draai tools/garmin_login.py en zet GARMIN_TOKENS opnieuw.', '/#/vandaag');
    end if;
  end if;
end $$;

revoke all on function public.internal_garmin_auth_get() from public, anon, authenticated;
revoke all on function public.internal_garmin_auth_save(jsonb) from public, anon, authenticated;
revoke all on function public.internal_garmin_pull_ingest(jsonb, numeric, text[]) from public, anon, authenticated;
revoke all on function public.internal_garmin_pull_fail(text, boolean) from public, anon, authenticated;

create or replace function app.garmin_pull_kick()
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
  if new.source = 'garmin' then perform app.garmin_pull_kick(); end if;
  return new;
end $$;
drop trigger if exists sync_requests_kick on app.sync_requests;
create trigger sync_requests_kick after insert on app.sync_requests
  for each row execute function app.sync_request_kick();

-- elke 10 min van 6u tot middernacht (cron in UTC; 5-23 UTC dekt winter- en zomertijd)
select cron.unschedule('garmin-pull') where exists (select 1 from cron.job where jobname = 'garmin-pull');
select cron.schedule('garmin-pull', '*/10 5-23 * * *', $$ select app.garmin_pull_kick() $$);
