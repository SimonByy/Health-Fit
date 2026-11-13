-- 1) Porties: sommige gerechten kan je niet in stukken eten (pudding, eiwitreep, Upfront-portie)
alter table app.mp_recipes add column if not exists portion_step numeric not null default 0.25;
do $$ begin
  alter table app.mp_recipes add constraint mp_recipes_portion_step_chk check (portion_step in (0.25, 0.5, 1));
exception when duplicate_object then null; end $$;
update app.mp_recipes set portion_step = 1
 where portion_step = 0.25 and (name ~* 'fitpudding|eiwitreep|proteïnereep|baked|upfront|rijstpudding' or meal_type = 'ontbijt');
update app.mp_recipes set portion_step = 0.5 where portion_step = 0.25 and name ~* 'wrap';

create or replace function public.mp_set_portion_step(p_recipe_id bigint, p_step numeric)
 returns void language plpgsql security definer set search_path to ''
as $$
begin
  perform app.assert_owner();
  if p_step not in (0.25, 0.5, 1) then raise exception 'Stap moet 0,25, 0,5 of 1 zijn'; end if;
  update app.mp_recipes set portion_step = p_step where id = p_recipe_id;
  -- geplande porties die niet meer passen: afronden op de nieuwe stap (minstens 1 stap)
  update app.mp_week_items set portions = greatest(p_step, round(portions / p_step) * p_step)
   where recipe_id = p_recipe_id and day >= (now() at time zone 'Europe/Brussels')::date
     and portions <> round(portions / p_step) * p_step;
end $$;
revoke all on function public.mp_set_portion_step(bigint, numeric) from public, anon;
grant execute on function public.mp_set_portion_step(bigint, numeric) to authenticated;

-- 2) Wensen voor het menu (getypt of ingesproken in de tab Menu)
create table if not exists app.menu_wishes (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  text text not null,
  status text not null default 'nieuw' check (status in ('nieuw', 'bezig', 'klaar', 'fout')),
  answer text,
  processed_at timestamptz
);
alter table app.menu_wishes enable row level security;

create or replace function public.menu_wish_add(p_text text)
 returns jsonb language plpgsql security definer set search_path to ''
as $$
declare r app.menu_wishes;
begin
  perform app.assert_owner();
  if coalesce(btrim(p_text), '') = '' then raise exception 'Typ of zeg wat je wil eten'; end if;
  insert into app.menu_wishes (text) values (left(btrim(p_text), 2000)) returning * into r;
  return to_jsonb(r);
end $$;
create or replace function public.menu_wishes_get(p_limit int default 6)
 returns jsonb language plpgsql stable security definer set search_path to ''
as $$
begin
  perform app.assert_owner();
  return coalesce((select jsonb_agg(to_jsonb(w) order by w.id desc) from (select * from app.menu_wishes order by id desc limit p_limit) w), '[]'::jsonb);
end $$;
revoke all on function public.menu_wish_add(text) from public, anon;
revoke all on function public.menu_wishes_get(int) from public, anon;
grant execute on function public.menu_wish_add(text) to authenticated;
grant execute on function public.menu_wishes_get(int) to authenticated;

-- 3) AH-mandje: wat Claude er zelf in legde, om later te kunnen bijsturen als het menu verandert
create table if not exists app.ah_basket_sync (
  week_id bigint primary key,
  synced_at timestamptz not null default now(),
  list_hash text,            -- md5 van de boodschappenlijst bij de laatste sync
  items jsonb not null default '[]'::jsonb,   -- [{key, product, qty}] wat Claude toevoegde
  note text
);
alter table app.ah_basket_sync enable row level security;

-- Hash van de huidige lijst (alleen wat in het AH-mandje hoort), om te zien of er iets veranderde
create or replace function public.internal_shopping_hash(p_week_id bigint)
 returns text language sql stable security definer set search_path to ''
as $$
  select md5(coalesce((
    select string_agg((i->>'key') || ':' || coalesce(i->>'amount', '') || ':' || coalesce(i->>'checked', ''), '|' order by i->>'key')
    from jsonb_array_elements(public.mp_shopping_build(p_week_id)) d, jsonb_array_elements(d->'items') i
    where not coalesce((i->>'pantry')::boolean, false) and coalesce(i->>'moment', 'zondag') = 'zondag'), ''));
$$;
revoke all on function public.internal_shopping_hash(bigint) from public, anon, authenticated;
