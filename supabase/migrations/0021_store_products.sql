-- Welke producten Simon echt kan kopen: zondag Albert Heijn (België), door de week Okay.
-- De mealprep- en AH-taak lezen en vullen dit, zodat recepten alleen beschikbare producten gebruiken.

create table if not exists app.store_products (
  id bigserial primary key,
  name text not null,                       -- ingrediëntnaam zoals in de recepten
  store text not null check (store in ('AH', 'Okay')),
  status text not null default 'ok' check (status in ('ok', 'niet_beschikbaar')),
  product text,                              -- exacte productnaam in de winkel
  replacement text,                          -- wat in de plaats te gebruiken
  per100 jsonb,                              -- {kcal, protein, carbs, fat}
  note text,
  updated_at timestamptz not null default now(),
  unique (name, store)
);
alter table app.store_products enable row level security;

insert into app.store_products (name, store, status, replacement, note) values
  ('Mager rundergehakt', 'AH', 'niet_beschikbaar', 'AH Runder-kipgehakt of AH Kipgehakt minder vet', 'Simon: zijn AH heeft geen mager rundergehakt (12/11/2026)'),
  ('Extra mager rundergehakt', 'AH', 'niet_beschikbaar', 'AH Runder-kipgehakt of AH Kipgehakt minder vet', 'Simon: zijn AH heeft geen mager rundergehakt (12/11/2026)')
on conflict (name, store) do update set status = excluded.status, replacement = excluded.replacement, note = excluded.note, updated_at = now();

update app.settings
set value = value || jsonb_build_object(
  'winkels', 'Zondag de grote boodschappen bij Albert Heijn (België): alles voor zondag t/m dinsdag en wat lang houdbaar is. Door de week (woensdag) aanvullen bij Okay (Colruyt Group): vers vlees, groenten en zuivel voor woensdag t/m vrijdag.',
  'beschikbaarheid', 'Gebruik alleen producten die bij AH België of Okay te koop zijn; zie app.store_products voor wat er niet is en wat in de plaats komt.',
  'nieuwe_recepten', 'Stel geregeld zelf een nieuw recept voor (minstens elke twee weken), eiwitrijk en mealprep-baar.')
where key = 'mealprep';
