-- 0013: Mealprep (weekmenu, recepten, boodschappenlijst) en ochtendbriefing in Health Hub.
-- Data in schema app, RPC-functies in public met eigenaarscontrole (zoals de rest van de app).
-- Vervangt de losse mealprep-app (tabellen public.meal_*, met toegangssleutel).

-- ---------------------------------------------------------------- tabellen
create table if not exists app.mp_recipes (
  id bigint generated always as identity primary key,
  name text not null check (length(btrim(name)) between 1 and 120),
  meal_type text not null check (meal_type in ('ontbijt','lunch','snack','avond')),
  servings int not null default 1 check (servings between 1 and 20),
  kcal numeric, protein numeric, carbs numeric, fat numeric,      -- per portie
  macros_checked boolean not null default false,
  ingredients jsonb not null default '[]'::jsonb,                 -- per portie: [{name, amount, unit, dept, pantry}]
  steps jsonb not null default '[]'::jsonb,                       -- ["stap", ...]
  storage text, source_url text, image_url text,
  description text,                                               -- vrije tekst bij een concept
  note text,                                                      -- Simons opmerking voor de planner
  status text not null default 'klaar' check (status in ('concept','klaar')),
  favorite boolean not null default false,
  disliked boolean not null default false,
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists mp_recipes_name_uq on app.mp_recipes (lower(name));

create table if not exists app.mp_weeks (
  id bigint generated always as identity primary key,
  week_start date not null unique,                                -- zondag waarop hij winkelt en kookt
  bonus jsonb not null default '[]'::jsonb,                       -- [{product, deal, valid, ingredient}]
  prep jsonb not null default '[]'::jsonb,                        -- ["stap", ...] voor zondag
  notes text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists app.mp_week_items (
  id bigint generated always as identity primary key,
  week_id bigint not null references app.mp_weeks(id) on delete cascade,
  day date not null,
  slot text not null check (slot in ('ontbijt','lunch','snack','avond')),
  recipe_id bigint not null references app.mp_recipes(id),
  portions numeric not null default 1 check (portions > 0 and portions <= 6),
  unique (week_id, day, slot)
);

create table if not exists app.mp_list_recipes (
  id bigint generated always as identity primary key,
  week_id bigint not null references app.mp_weeks(id) on delete cascade,
  recipe_id bigint not null references app.mp_recipes(id),
  portions numeric not null default 1 check (portions > 0 and portions <= 20),
  created_at timestamptz not null default now()
);

create table if not exists app.mp_list_extras (
  id bigint generated always as identity primary key,
  week_id bigint not null references app.mp_weeks(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  dept text not null default 'Overig',
  created_at timestamptz not null default now()
);

create table if not exists app.mp_list_checks (
  week_id bigint not null references app.mp_weeks(id) on delete cascade,
  key text not null,
  checked boolean not null default true,
  primary key (week_id, key)
);

create table if not exists app.briefings (
  day date primary key,
  text text not null,
  conversation_id uuid not null,
  created_at timestamptz not null default now()
);

alter table app.mp_recipes enable row level security;
alter table app.mp_weeks enable row level security;
alter table app.mp_week_items enable row level security;
alter table app.mp_list_recipes enable row level security;
alter table app.mp_list_extras enable row level security;
alter table app.mp_list_checks enable row level security;
alter table app.briefings enable row level security;

-- ---------------------------------------------------------------- helpers
-- Huidige mealprepweek: de laatste week die al begonnen is, anders de eerstvolgende.
create or replace function app.mp_current_week_id()
returns bigint language sql stable security definer set search_path = '' as $$
  select id from (
    (select id, 0 as o, week_start from app.mp_weeks
      where week_start <= (now() at time zone 'Europe/Brussels')::date order by week_start desc limit 1)
    union all
    (select id, 1, week_start from app.mp_weeks
      where week_start > (now() at time zone 'Europe/Brussels')::date order by week_start limit 1)
  ) w order by o limit 1;
$$;

-- Boodschappenlijst: weekmenu + toegevoegde recepten + extra's, per afdeling.
create or replace function public.mp_shopping_build(p_week_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  with src as (
    select i.portions as mult, r.ingredients from app.mp_week_items i join app.mp_recipes r on r.id = i.recipe_id where i.week_id = p_week_id
    union all
    select l.portions, r.ingredients from app.mp_list_recipes l join app.mp_recipes r on r.id = l.recipe_id where l.week_id = p_week_id
  ), ing as (
    select btrim(e->>'name') as name, nullif(btrim(e->>'unit'), '') as unit,
           coalesce(nullif(e->>'dept', ''), 'Overig') as dept,
           coalesce((e->>'pantry')::boolean, false) as pantry,
           case when jsonb_typeof(e->'amount') = 'number' then (e->>'amount')::numeric * s.mult end as amt
    from src s cross join lateral jsonb_array_elements(s.ingredients) e
    where coalesce(btrim(e->>'name'), '') <> ''
  ), agg as (
    select lower(name) || '|' || coalesce(unit, '') as key, min(name) as name, unit, min(dept) as dept,
           bool_and(pantry) as pantry, sum(amt) as amount, null::bigint as extra_id
    from ing group by lower(name), unit
    union all
    select 'extra|' || x.id, x.name, null, x.dept, false, null, x.id from app.mp_list_extras x where x.week_id = p_week_id
  ), rows_ as (
    select a.*,
      exists (select 1 from app.mp_weeks w cross join lateral jsonb_array_elements(w.bonus) b
              where w.id = p_week_id and lower(btrim(coalesce(b->>'ingredient', ''))) = lower(a.name)) as bonus,
      coalesce((select c.checked from app.mp_list_checks c where c.week_id = p_week_id and c.key = a.key), false) as checked,
      coalesce(array_position(array['Groenten & fruit','Vlees & vis','Zuivel & eieren','Brood & wraps','Houdbaar','Ontbijt & sport','Diepvries','Overig'], a.dept), 99) as dept_ord
    from agg a
  )
  select coalesce(jsonb_agg(jsonb_build_object('dept', d.dept, 'items', d.items) order by d.dept_ord, d.dept), '[]'::jsonb)
  from (
    select dept, min(dept_ord) as dept_ord,
      jsonb_agg(jsonb_build_object('key', key, 'name', name, 'amount', round(amount, 1), 'unit', unit, 'pantry', pantry,
                                   'bonus', bonus, 'checked', checked, 'extra_id', extra_id) order by pantry, lower(name)) as items
    from rows_ group by dept
  ) d;
$$;

-- Week aanmaken als die nog niet bestaat (voor extra's op de lijst zonder weekmenu)
create or replace function app.mp_ensure_week()
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint; v_today date := (now() at time zone 'Europe/Brussels')::date; v_sun date;
begin
  v_id := app.mp_current_week_id();
  if v_id is not null then return v_id; end if;
  v_sun := v_today + ((7 - extract(dow from v_today)::int) % 7);   -- eerstvolgende zondag (vandaag als het zondag is)
  insert into app.mp_weeks(week_start) values (v_sun) on conflict (week_start) do update set week_start = excluded.week_start returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------- RPC's voor de app (eigenaar)
create or replace function public.mp_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'Europe/Brussels')::date;
begin
  perform app.assert_owner();
  return jsonb_build_object(
    'today', v_today,
    'current_week_id', app.mp_current_week_id(),
    'goals', (select value from app.settings where key = 'goals'),
    'rules', (select value from app.settings where key = 'mealprep'),
    'briefing', (select jsonb_build_object('day', b.day, 'text', b.text, 'conversation_id', b.conversation_id) from app.briefings b where b.day = v_today),
    'recipes', (select coalesce(jsonb_agg(to_jsonb(r) - 'hidden' order by r.favorite desc, r.disliked, lower(r.name)), '[]'::jsonb) from app.mp_recipes r where not r.hidden),
    'weeks', (select coalesce(jsonb_agg(w.j order by w.week_start desc), '[]'::jsonb) from (
        select mw.week_start, jsonb_build_object('id', mw.id, 'week_start', mw.week_start, 'bonus', mw.bonus, 'prep', mw.prep,
          'notes', mw.notes, 'reviewed_at', mw.reviewed_at,
          'items', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'day', i.day, 'slot', i.slot, 'recipe_id', i.recipe_id, 'portions', i.portions) order by i.day, i.slot), '[]'::jsonb)
                    from app.mp_week_items i where i.week_id = mw.id),
          'list_recipes', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'recipe_id', l.recipe_id, 'portions', l.portions) order by l.id), '[]'::jsonb)
                    from app.mp_list_recipes l where l.week_id = mw.id),
          'shopping', public.mp_shopping_build(mw.id)) as j
        from app.mp_weeks mw order by mw.week_start desc limit 4) w)
  );
end $$;

create or replace function public.mp_set_opinion(p_id bigint, p_opinion text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  if p_opinion not in ('lekker','neutraal','niet') then raise exception 'Onbekende mening'; end if;
  update app.mp_recipes set favorite = (p_opinion = 'lekker'), disliked = (p_opinion = 'niet'), updated_at = now() where id = p_id;
  if not found then raise exception 'Recept niet gevonden'; end if;
end $$;

create or replace function public.mp_set_note(p_id bigint, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  update app.mp_recipes set note = nullif(left(btrim(coalesce(p_note, '')), 500), ''), updated_at = now() where id = p_id;
  if not found then raise exception 'Recept niet gevonden'; end if;
end $$;

create or replace function public.mp_hide_recipe(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  if exists (select 1 from app.mp_week_items i join app.mp_weeks w on w.id = i.week_id
             where i.recipe_id = p_id and w.week_start >= (now() at time zone 'Europe/Brussels')::date - 6) then
    raise exception 'Dit recept staat in je weekmenu. Wissel het daar eerst.';
  end if;
  update app.mp_recipes set hidden = true, updated_at = now() where id = p_id;
end $$;

-- Recept opslaan (nieuw of bewerken): uit het +formulier, een foto of een link.
create or replace function public.mp_save_recipe(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id bigint := nullif(p->>'id', '')::bigint; v_name text := left(btrim(coalesce(p->>'name', '')), 120);
  v_type text := coalesce(p->>'meal_type', 'avond'); r app.mp_recipes;
begin
  perform app.assert_owner();
  if v_name = '' then raise exception 'Geef het recept een naam'; end if;
  if v_type not in ('ontbijt','lunch','snack','avond') then raise exception 'Kies ontbijt, lunch, snack of avond'; end if;
  if jsonb_typeof(coalesce(p->'ingredients', '[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(p->'steps', '[]'::jsonb)) <> 'array' then
    raise exception 'Ongeldige ingrediënten of stappen';
  end if;
  if exists (select 1 from app.mp_recipes where lower(name) = lower(v_name) and id is distinct from v_id and not hidden) then
    raise exception 'Er bestaat al een recept met die naam';
  end if;
  if v_id is null then
    -- een verborgen recept met dezelfde naam opnieuw gebruiken
    select id into v_id from app.mp_recipes where lower(name) = lower(v_name) and hidden;
  end if;
  if v_id is null then
    insert into app.mp_recipes(name, meal_type) values (v_name, v_type) returning id into v_id;
  end if;
  update app.mp_recipes set
    name = v_name, meal_type = v_type,
    servings = greatest(1, least(20, coalesce(nullif(p->>'servings', '')::int, servings))),
    kcal = nullif(p->>'kcal', '')::numeric, protein = nullif(p->>'protein', '')::numeric,
    carbs = nullif(p->>'carbs', '')::numeric, fat = nullif(p->>'fat', '')::numeric,
    macros_checked = coalesce((p->>'macros_checked')::boolean, false),
    ingredients = coalesce(p->'ingredients', '[]'::jsonb), steps = coalesce(p->'steps', '[]'::jsonb),
    storage = nullif(btrim(coalesce(p->>'storage', '')), ''), source_url = nullif(btrim(coalesce(p->>'source_url', '')), ''),
    description = nullif(left(coalesce(p->>'description', ''), 4000), ''),
    status = case when p->>'status' in ('concept','klaar') then p->>'status'
                  when jsonb_array_length(coalesce(p->'ingredients', '[]'::jsonb)) > 0 and nullif(p->>'kcal', '') is not null then 'klaar'
                  else 'concept' end,
    favorite = coalesce((p->>'favorite')::boolean, favorite),
    hidden = false, updated_at = now()
  where id = v_id returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.mp_item_set(p_item_id bigint, p_recipe_id bigint, p_portions numeric)
returns void language plpgsql security definer set search_path = '' as $$
declare v_slot text; v_type text;
begin
  perform app.assert_owner();
  if p_portions is null or p_portions <= 0 or p_portions > 6 then raise exception 'Kies tussen 0,25 en 6 porties'; end if;
  select slot into v_slot from app.mp_week_items where id = p_item_id;
  if v_slot is null then raise exception 'Maaltijd niet gevonden'; end if;
  select meal_type into v_type from app.mp_recipes where id = p_recipe_id and status = 'klaar' and not hidden;
  if v_type is null then raise exception 'Dit recept is nog niet klaar om te koken'; end if;
  update app.mp_week_items set recipe_id = p_recipe_id, portions = p_portions where id = p_item_id;
end $$;

create or replace function public.mp_week_review(p_week_id bigint, p_reviewed boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  update app.mp_weeks set reviewed_at = case when p_reviewed then now() end where id = p_week_id;
end $$;

create or replace function public.mp_list_add_recipe(p_week_id bigint, p_recipe_id bigint, p_portions numeric)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint; v_week bigint := coalesce(p_week_id, app.mp_ensure_week());
begin
  perform app.assert_owner();
  insert into app.mp_list_recipes(week_id, recipe_id, portions) values (v_week, p_recipe_id, p_portions) returning id into v_id;
  return v_id;
end $$;

create or replace function public.mp_list_remove_recipe(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  delete from app.mp_list_recipes where id = p_id;
end $$;

create or replace function public.mp_extra_add(p_week_id bigint, p_name text, p_dept text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_id bigint; v_week bigint := coalesce(p_week_id, app.mp_ensure_week());
begin
  perform app.assert_owner();
  insert into app.mp_list_extras(week_id, name, dept)
  values (v_week, left(btrim(p_name), 120), coalesce(nullif(btrim(p_dept), ''), 'Overig')) returning id into v_id;
  return v_id;
end $$;

create or replace function public.mp_extra_remove(p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare v_week bigint;
begin
  perform app.assert_owner();
  delete from app.mp_list_extras where id = p_id returning week_id into v_week;
  if v_week is not null then delete from app.mp_list_checks where week_id = v_week and key = 'extra|' || p_id; end if;
end $$;

create or replace function public.mp_check(p_week_id bigint, p_key text, p_checked boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  insert into app.mp_list_checks(week_id, key, checked) values (p_week_id, left(p_key, 200), p_checked)
  on conflict (week_id, key) do update set checked = excluded.checked;
end $$;

create or replace function public.get_briefing(p_day date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (select jsonb_build_object('day', b.day, 'text', b.text, 'conversation_id', b.conversation_id)
          from app.briefings b where b.day = coalesce(p_day, (now() at time zone 'Europe/Brussels')::date));
end $$;

-- Briefing wegschrijven (geplande Claude-taak) en het gesprek starten waarop Simon kan antwoorden.
create or replace function public.internal_save_briefing(p_day date, p_text text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_conv uuid := md5('briefing-' || p_day::text)::uuid;
begin
  insert into app.briefings(day, text, conversation_id) values (p_day, p_text, v_conv)
  on conflict (day) do update set text = excluded.text, created_at = now();
  -- opnieuw gemaakt en nog niet beantwoord: het gesprek vervangen
  if (select count(*) from app.chat_messages where conversation_id = v_conv) <= 2 then
    delete from app.chat_messages where conversation_id = v_conv;
    insert into app.chat_messages(conversation_id, role, content, meta)
    values (v_conv, 'user', 'Geef me mijn ochtendbriefing van ' || to_char(p_day, 'DD/MM/YYYY') || '.', jsonb_build_object('briefing', true)),
           (v_conv, 'assistant', p_text, jsonb_build_object('briefing', true));
  end if;
  return v_conv;
end $$;

-- ---------------------------------------------------------------- rechten
do $$
declare fn text;
begin
  foreach fn in array array['mp_get()', 'mp_set_opinion(bigint,text)', 'mp_set_note(bigint,text)', 'mp_hide_recipe(bigint)',
    'mp_save_recipe(jsonb)', 'mp_item_set(bigint,bigint,numeric)', 'mp_week_review(bigint,boolean)',
    'mp_list_add_recipe(bigint,bigint,numeric)', 'mp_list_remove_recipe(bigint)', 'mp_extra_add(bigint,text,text)',
    'mp_extra_remove(bigint)', 'mp_check(bigint,text,boolean)', 'get_briefing(date)'] loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
  foreach fn in array array['mp_shopping_build(bigint)', 'internal_save_briefing(date,text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', fn);
    execute format('grant execute on function public.%s to service_role', fn);
  end loop;
end $$;
revoke all on function app.mp_current_week_id() from public, anon, authenticated;
revoke all on function app.mp_ensure_week() from public, anon, authenticated;

-- ---------------------------------------------------------------- instellingen
insert into app.settings(key, value) values ('mealprep', jsonb_build_object(
  'shopping_day', 'zondag', 'period', 'zondagavond tot vrijdagmiddag',
  'ontbijt', 'Vast pre-workout ontbijt (Upfront eiwit oats), ongeveer 80 g koolhydraten',
  'lunch', 'Elke dag een wrap; één vulling per week, hoogstens twee',
  'snack', 'Elke dag magere kwark',
  'avond', 'Hoogstens 2 verschillende gerechten per week, elk gekookt voor 2 of 3 dagen'))
on conflict (key) do nothing;

-- ---------------------------------------------------------------- startrecepten
insert into app.mp_recipes(name, meal_type, servings, kcal, protein, carbs, fat, macros_checked, ingredients, steps, storage, note) values
('Upfront eiwit oats banaan caramel', 'ontbijt', 1, 416, 24, 65, 7, false,
 '[{"name":"Upfront eiwit oats banaan caramel","amount":60,"unit":"g","dept":"Ontbijt & sport"},
   {"name":"Magere melk","amount":150,"unit":"ml","dept":"Zuivel & eieren"},
   {"name":"Banaan","amount":1,"unit":"stuk","dept":"Groenten & fruit"},
   {"name":"Monin siroop caramel sugar free","amount":15,"unit":"ml","dept":"Houdbaar","pantry":true},
   {"name":"Lotus speculoos","amount":1,"unit":"stuk","dept":"Houdbaar"}]',
 '["Meng de oats met de melk en warm 2 minuten op, of laat een nacht weken in de koelkast.","Snijd de banaan erover, sprenkel de siroop erover en verkruimel het koekje erboven."]',
 'Elke ochtend vers, of de avond ervoor als overnight oats.',
 'Je mikt op ongeveer 80 g koolhydraten: pas de portie aan als je meer eet.'),
('Wrap met extra mager rundergehakt', 'lunch', 4, 535, 43, 42, 20, false,
 '[{"name":"Volkoren wraps","amount":1,"unit":"stuk","dept":"Brood & wraps"},
   {"name":"Extra mager rundergehakt","amount":150,"unit":"g","dept":"Vlees & vis"},
   {"name":"Paprika","amount":0.5,"unit":"stuk","dept":"Groenten & fruit"},
   {"name":"Ui","amount":0.5,"unit":"stuk","dept":"Groenten & fruit"},
   {"name":"IJsbergsla","amount":30,"unit":"g","dept":"Groenten & fruit"},
   {"name":"Maïs (blik)","amount":30,"unit":"g","dept":"Houdbaar"},
   {"name":"Geraspte kaas 30+","amount":20,"unit":"g","dept":"Zuivel & eieren"},
   {"name":"Salsa","amount":20,"unit":"g","dept":"Houdbaar"},
   {"name":"Tacokruiden","amount":3,"unit":"g","dept":"Houdbaar","pantry":true}]',
 '["Bak het gehakt rul met de tacokruiden.","Voeg ui en paprika toe en bak 5 minuten mee.","Laat snel afkoelen in een platte bak en verdeel in porties.","Bewaar vulling, sla en kaas apart.","Op de dag zelf: warm de vulling op, beleg de wrap met sla, maïs, kaas en salsa en rol op."]',
 'Vulling 3 à 4 dagen in de koelkast (op 3 °C); porties voor na woensdag invriezen. Rol de wrap pas op de dag zelf.', null),
('Magere kwark met blauwe bessen', 'snack', 1, 354, 49, 33, 2, false,
 '[{"name":"Magere kwark","amount":500,"unit":"g","dept":"Zuivel & eieren"},
   {"name":"Flavour powder","amount":5,"unit":"g","dept":"Ontbijt & sport","pantry":true},
   {"name":"Blauwe bessen","amount":100,"unit":"g","dept":"Groenten & fruit"}]',
 '["Roer de flavour powder door de kwark.","Werk af met de bessen. Granola alleen als er ruimte is: 20 g is ongeveer 90 kcal extra."]',
 'Niet voorbereiden: in 1 minuut klaar.', null),
('Hete bliksem', 'avond', 2, 495, 36, 61, 12, false,
 '[{"name":"Kruimige aardappelen","amount":250,"unit":"g","dept":"Groenten & fruit"},
   {"name":"Magere melk","amount":50,"unit":"ml","dept":"Zuivel & eieren"},
   {"name":"Appelmoes","amount":100,"unit":"g","dept":"Houdbaar"},
   {"name":"Extra mager rundergehakt","amount":150,"unit":"g","dept":"Vlees & vis"},
   {"name":"Peper en zout","dept":"Houdbaar","pantry":true}]',
 '["Schil de aardappelen, snij ze in stukken en kook ze 20 minuten gaar in gezouten water.","Bak intussen het gehakt rul en kruid met peper en zout.","Giet de aardappelen af en stamp ze fijn met de melk.","Roer de appelmoes door de puree en serveer met het gehakt."]',
 '3 dagen in de koelkast; per portie in één bakje.', null),
('Kip-noedelwok', 'avond', 2, 620, 35, 89, 14, true,
 '[{"name":"Mie (droog)","amount":70,"unit":"g","dept":"Houdbaar"},
   {"name":"Kipfilet soja-honing gemarineerd","amount":175,"unit":"g","dept":"Vlees & vis"},
   {"name":"Wokgroenten","amount":200,"unit":"g","dept":"Groenten & fruit"},
   {"name":"Sojasaus","amount":12,"unit":"ml","dept":"Houdbaar","pantry":true}]',
 '["Kook de mie volgens de verpakking en giet af.","Bak de kip gaar in een hete wok.","Voeg de groenten toe en wok 3 à 4 minuten.","Roer de mie en de sojasaus erdoor."]',
 '3 dagen in de koelkast.',
 'Veel zout door marinade en sojasaus. Meer eiwit: 100 à 150 g gewone kipfilet erbij.'),
('Balletjes in tomatensaus met puree', 'avond', 4, 535, 65, 66, 22, false,
 '[{"name":"Mager rundergehakt","amount":250,"unit":"g","dept":"Vlees & vis"},
   {"name":"Kruimige aardappelen","amount":250,"unit":"g","dept":"Groenten & fruit"},
   {"name":"Italiaanse roerbakgroenten","amount":100,"unit":"g","dept":"Groenten & fruit"},
   {"name":"Passata","amount":175,"unit":"g","dept":"Houdbaar"},
   {"name":"Eieren","amount":0.25,"unit":"stuk","dept":"Zuivel & eieren"},
   {"name":"Paneermeel","amount":15,"unit":"g","dept":"Houdbaar"},
   {"name":"Magere melk","amount":40,"unit":"ml","dept":"Zuivel & eieren"},
   {"name":"Boter","amount":8,"unit":"g","dept":"Zuivel & eieren"},
   {"name":"Italiaanse kruiden","dept":"Houdbaar","pantry":true}]',
 '["Meng het gehakt met ei, paneermeel, peper, zout en Italiaanse kruiden en draai er balletjes van.","Zet de aardappelen op en kook ze 20 minuten gaar.","Bak de balletjes rondom bruin, voeg de groenten toe en bak 4 minuten mee.","Giet de passata erbij en laat 20 minuten zacht sudderen met het deksel erop.","Stamp de aardappelen met boter en warme melk."]',
 '3 dagen in de koelkast; balletjes in saus kunnen tot 3 maanden in de diepvries.', null),
('Kip-rijstbowl teriyaki', 'avond', 2, 535, 44, 66, 8, false,
 '[{"name":"Kipfilet","amount":150,"unit":"g","dept":"Vlees & vis"},
   {"name":"Basmatirijst (droog)","amount":70,"unit":"g","dept":"Houdbaar"},
   {"name":"Wokgroenten","amount":200,"unit":"g","dept":"Groenten & fruit"},
   {"name":"Teriyakisaus light","amount":20,"unit":"ml","dept":"Houdbaar"},
   {"name":"Olijfolie","amount":5,"unit":"ml","dept":"Houdbaar","pantry":true}]',
 '["Kook de rijst volgens de verpakking.","Snij de kip in blokjes en bak gaar in de olie.","Voeg de groenten toe en wok 3 à 4 minuten.","Roer de teriyakisaus erdoor en serveer op de rijst."]',
 'Rijst snel afkoelen: 2 à 3 dagen in de koelkast, anders invriezen.', null),
('Pasta bolognese (volkoren)', 'avond', 2, 557, 41, 60, 14, false,
 '[{"name":"Volkoren penne (droog)","amount":70,"unit":"g","dept":"Houdbaar"},
   {"name":"Extra mager rundergehakt","amount":150,"unit":"g","dept":"Vlees & vis"},
   {"name":"Passata met groenten","amount":200,"unit":"g","dept":"Houdbaar"},
   {"name":"Ui","amount":0.5,"unit":"stuk","dept":"Groenten & fruit"},
   {"name":"Knoflook","amount":1,"unit":"teen","dept":"Groenten & fruit"},
   {"name":"Italiaanse kruiden","dept":"Houdbaar","pantry":true}]',
 '["Kook de pasta beetgaar.","Fruit ui en knoflook en bak het gehakt rul.","Voeg passata en kruiden toe en laat 10 à 15 minuten sudderen.","Meng de saus met de pasta."]',
 '3 dagen in de koelkast; de saus apart invriezen kan tot 3 maanden.', null)
on conflict do nothing;

-- ---------------------------------------------------------------- dagdoel (2000 kcal, 150 g eiwit, 50 g vet, rest koolhydraten)
update app.settings set value = value || jsonb_build_object('kcal_in', 2000, 'protein_g', 150, 'fat_g', 50, 'carbs_g', 238), updated_at = now()
where key = 'goals';

-- ---------------------------------------------------------------- pushmelding ochtendbriefing om 09:00
select app.do_save_routine(jsonb_build_object('title', 'Ochtendbriefing', 'body', 'Tik om je briefing te horen',
  'kind', 'notify', 'days', jsonb_build_array(1,2,3,4,5,6,7), 'time', '09:00', 'url', '/#/briefing'), 'migration')
where not exists (select 1 from app.routines where title = 'Ochtendbriefing' and not archived);

-- De tabellen public.meal_* van de vroegere losse mealprep-app worden niet meer gebruikt.
-- Opruimen kan later met: drop table public.meal_week_items, public.meal_weeks, public.meal_recipes, public.meal_config;
