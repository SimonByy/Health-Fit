-- =====================================================================
-- Health Hub — kernschema
-- Schema's:
--   app    : eigenaar, instellingen, sync-status, chatgeschiedenis
--   health : ruwe + genormaliseerde data (Apple Health, Hevy)
--   ai     : read-only views waar de AI (en het dashboard) op werkt
-- Geen enkel schema behalve public is via de API bereikbaar; de app
-- praat uitsluitend via RPC-functies met eigenaarscontrole.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create schema if not exists app;
create schema if not exists health;
create schema if not exists ai;

revoke all on schema app, health, ai from public;
revoke all on schema app, health, ai from anon, authenticated;

-- ---------------------------------------------------------------------
-- Eigenaar (enkel jij). De eerste gebruiker die zich registreert wordt
-- automatisch eigenaar; latere accounts zien niets.
-- ---------------------------------------------------------------------
create table app.owners (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table app.owners enable row level security;

create or replace function app.claim_first_owner()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(424242);
  if not exists (select 1 from app.owners) then
    insert into app.owners(user_id) values (new.id);
  end if;
  return new;
end $$;

create trigger on_auth_user_created_claim_owner
  after insert on auth.users
  for each row execute function app.claim_first_owner();

create or replace function app.is_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.owners where user_id = auth.uid());
$$;

create or replace function app.assert_owner()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_owner() then
    raise exception 'Geen toegang' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Instellingen, sync-status, logging, chat
-- ---------------------------------------------------------------------
create table app.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table app.settings enable row level security;

insert into app.settings(key, value) values
  ('goals', '{"steps":10000,"kcal_in":2500,"protein_g":150,"sleep_h":8,"active_kcal":600}'),
  ('ai_model', '"claude-sonnet-5-5"'),
  ('meal_slots', '[{"name":"Ontbijt","until":11},{"name":"Lunch","until":15},{"name":"Snack","until":18},{"name":"Avondeten","until":22},{"name":"Laat","until":24}]')
on conflict (key) do nothing;

create table app.sync_state (
  source       text primary key,
  last_run     timestamptz,
  last_success timestamptz,
  cursor       text,
  last_error   text,
  last_items   int
);
alter table app.sync_state enable row level security;

create table app.ingest_log (
  id          bigserial primary key,
  source      text not null,
  received_at timestamptz not null default now(),
  stats       jsonb,
  error       text
);
alter table app.ingest_log enable row level security;

create table app.chat_messages (
  id              bigserial primary key,
  conversation_id uuid not null,
  role            text not null check (role in ('user','assistant')),
  content         text not null,
  meta            jsonb,
  created_at      timestamptz not null default now()
);
create index on app.chat_messages (conversation_id, id);
alter table app.chat_messages enable row level security;

-- ---------------------------------------------------------------------
-- Secrets in Supabase Vault (versleuteld). Nooit in de frontend.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'ingest_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'ingest_token', 'Token voor Apple Health export');
  end if;
  if not exists (select 1 from vault.secrets where name = 'cron_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'cron_token', 'Token voor geplande sync');
  end if;
end $$;

create or replace function app.get_secret(p_name text)
returns text language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1;
$$;
revoke all on function app.get_secret(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Health: Apple Health
-- ---------------------------------------------------------------------
create table health.metric_catalog (
  metric   text primary key,
  label    text not null,
  category text not null,          -- activiteit | hart | lichaam | voeding | overig
  agg      text not null check (agg in ('sum','avg','max','min')),
  unit     text,
  sort     int not null default 100
);
alter table health.metric_catalog enable row level security;

-- Eén rij per metric per tijdstip (bij voorkeur per uur geaggregeerd door de export-app).
create table health.metric_samples (
  metric      text not null,
  ts          timestamptz not null,
  day         date not null,       -- lokale datum (Europe/Brussels)
  hour        smallint not null,   -- lokaal uur
  qty         double precision,
  min         double precision,
  avg         double precision,
  max         double precision,
  units       text,
  source      text,
  inserted_at timestamptz not null default now(),
  primary key (metric, ts)
);
create index on health.metric_samples (day, metric);
alter table health.metric_samples enable row level security;

create table health.sleep_summaries (
  day         date not null,
  source      text not null default '',
  total_h     double precision,
  asleep_h    double precision,
  core_h      double precision,
  deep_h      double precision,
  rem_h       double precision,
  awake_h     double precision,
  in_bed_h    double precision,
  sleep_start timestamptz,
  sleep_end   timestamptz,
  inserted_at timestamptz not null default now(),
  primary key (day, source)
);
alter table health.sleep_summaries enable row level security;

create table health.sleep_segments (
  start_ts timestamptz not null,
  end_ts   timestamptz not null,
  stage    text not null,
  night    date not null,
  source   text,
  primary key (start_ts, stage)
);
create index on health.sleep_segments (night);
alter table health.sleep_segments enable row level security;

create table health.workouts (
  id             text primary key,
  name           text,
  start_ts       timestamptz not null,
  end_ts         timestamptz,
  day            date not null,
  duration_s     double precision,
  distance_km    double precision,
  active_kcal    double precision,
  avg_hr         double precision,
  max_hr         double precision,
  elevation_up_m double precision,
  source         text,
  raw            jsonb,
  inserted_at    timestamptz not null default now()
);
create index on health.workouts (day);
alter table health.workouts enable row level security;

-- ---------------------------------------------------------------------
-- Health: Hevy
-- ---------------------------------------------------------------------
create table health.hevy_workouts (
  id          text primary key,
  title       text,
  description text,
  start_ts    timestamptz,
  end_ts      timestamptz,
  day         date,
  updated_at  timestamptz,
  created_at  timestamptz,
  raw         jsonb
);
create index on health.hevy_workouts (day);
alter table health.hevy_workouts enable row level security;

create table health.hevy_sets (
  workout_id           text not null references health.hevy_workouts(id) on delete cascade,
  exercise_index       int not null,
  set_index            int not null,
  exercise_title       text,
  exercise_template_id text,
  superset_id          text,
  exercise_notes       text,
  set_type             text,
  weight_kg            double precision,
  reps                 int,
  distance_m           double precision,
  duration_s           double precision,
  rpe                  double precision,
  primary key (workout_id, exercise_index, set_index)
);
create index on health.hevy_sets (exercise_template_id);
alter table health.hevy_sets enable row level security;

create table health.hevy_exercise_templates (
  id                      text primary key,
  title                   text,
  type                    text,
  primary_muscle_group    text,
  secondary_muscle_groups text[],
  is_custom               boolean,
  updated_at              timestamptz not null default now()
);
alter table health.hevy_exercise_templates enable row level security;
