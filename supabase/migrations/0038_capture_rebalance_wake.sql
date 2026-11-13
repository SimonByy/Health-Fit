-- 1) Scherm-capture vanuit de iPhone (Action-knop) -> inbox voor Claude
-- 2) Menu herbalanceren als de macro's van een gepland recept veranderen
-- 3) Wekker gestopt -> signaal voor de ochtendbriefing

create table if not exists app.capture_inbox (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  text text,                 -- tekst die de iPhone uit de screenshot haalde (OCR)
  note text,                 -- wat Simon er eventueel bij typte of zei
  image_path text,           -- pad in storage-bucket recipe-inbox
  status text not null default 'nieuw' check (status in ('nieuw','bezig','klaar','fout')),
  kind text,                 -- door Claude ingevuld: recept, gewicht, voeding, etiket, training, agenda, overig
  result text,               -- korte uitleg wat Claude ermee deed
  processed_at timestamptz,
  error text
);
alter table app.capture_inbox enable row level security;

create table if not exists app.wake_events (
  id bigserial primary key,
  ts timestamptz not null default now(),
  day date not null default ((now() at time zone 'Europe/Brussels')::date),
  source text not null default 'wekker'
);
alter table app.wake_events enable row level security;

create table if not exists app.menu_rebalance (
  id bigserial primary key,
  recipe_id bigint not null,
  created_at timestamptz not null default now(),
  old_macros jsonb,
  new_macros jsonb,
  done_at timestamptz,
  note text
);
alter table app.menu_rebalance enable row level security;
create unique index if not exists menu_rebalance_open on app.menu_rebalance (recipe_id) where done_at is null;

create or replace function app.mp_recipe_macros_changed()
 returns trigger language plpgsql security definer set search_path to ''
as $$
begin
  if (old.kcal, old.protein, old.carbs, old.fat) is distinct from (new.kcal, new.protein, new.carbs, new.fat)
     and exists (select 1 from app.mp_week_items i
                 where i.recipe_id = new.id and i.day >= (now() at time zone 'Europe/Brussels')::date) then
    insert into app.menu_rebalance (recipe_id, old_macros, new_macros)
    values (new.id,
            jsonb_build_object('kcal', old.kcal, 'protein', old.protein, 'carbs', old.carbs, 'fat', old.fat),
            jsonb_build_object('kcal', new.kcal, 'protein', new.protein, 'carbs', new.carbs, 'fat', new.fat))
    on conflict (recipe_id) where done_at is null
    do update set new_macros = excluded.new_macros, created_at = now();
  end if;
  return new;
end $$;

drop trigger if exists mp_recipe_macros_changed on app.mp_recipes;
create trigger mp_recipe_macros_changed after update on app.mp_recipes
  for each row execute function app.mp_recipe_macros_changed();

-- Voor de app: staat er een herberekening klaar voor dit recept?
create or replace function public.menu_rebalance_pending(p_recipe_id bigint)
 returns boolean language plpgsql stable security definer set search_path to ''
as $$
begin
  perform app.assert_owner();
  return exists (select 1 from app.menu_rebalance where recipe_id = p_recipe_id and done_at is null);
end $$;
grant execute on function public.menu_rebalance_pending(bigint) to authenticated;

-- Voor de shortcut-edge-function (service_role)
create or replace function public.internal_capture_add(p_text text, p_note text, p_image_path text)
 returns bigint language sql security definer set search_path to ''
as $$
  insert into app.capture_inbox (text, note, image_path)
  values (nullif(left(p_text, 20000), ''), nullif(left(p_note, 2000), ''), nullif(p_image_path, ''))
  returning id;
$$;
revoke all on function public.internal_capture_add(text, text, text) from public, anon, authenticated;
grant execute on function public.internal_capture_add(text, text, text) to service_role;

create or replace function public.internal_wake(p_source text default 'wekker')
 returns jsonb language plpgsql security definer set search_path to ''
as $$
declare d date := (now() at time zone 'Europe/Brussels')::date; first boolean;
begin
  first := not exists (select 1 from app.wake_events where day = d);
  insert into app.wake_events (source) values (coalesce(nullif(p_source, ''), 'wekker'));
  return jsonb_build_object('first_today', first,
    'briefing_ready', exists (select 1 from app.briefings where day = d));
end $$;
revoke all on function public.internal_wake(text) from public, anon, authenticated;
grant execute on function public.internal_wake(text) to service_role;

-- Token om de afbeelding van een capture op te halen (shortcut?a=img&id=..&t=..)
alter table app.capture_inbox add column if not exists token text not null default encode(extensions.gen_random_bytes(18), 'hex');
create or replace function public.internal_capture_image(p_id bigint, p_token text)
 returns text language sql stable security definer set search_path to ''
as $$ select image_path from app.capture_inbox where id = p_id and token = p_token and image_path is not null $$;
revoke all on function public.internal_capture_image(bigint, text) from public, anon, authenticated;
grant execute on function public.internal_capture_image(bigint, text) to service_role;

-- Private bucket voor screenshots
insert into storage.buckets (id, name, public, file_size_limit) values ('captures', 'captures', false, 15728640) on conflict (id) do nothing;
