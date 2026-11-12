-- Avondsnack als eigen moment in het weekmenu, XXL Fitpudding als vast product,
-- en een paar nieuwe recepten zodat het menu minder eentonig is.

alter table app.mp_week_items drop constraint if exists mp_week_items_slot_check;
alter table app.mp_week_items add constraint mp_week_items_slot_check check (slot in ('ontbijt','lunch','snack','avond','avondsnack'));
alter table app.mp_recipes drop constraint if exists mp_recipes_meal_type_check;
alter table app.mp_recipes add constraint mp_recipes_meal_type_check check (meal_type in ('ontbijt','lunch','snack','avond','avondsnack'));

create or replace function public.mp_save_recipe(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $function$
declare v_id bigint := nullif(p->>'id', '')::bigint; v_name text := left(btrim(coalesce(p->>'name', '')), 120);
  v_type text := coalesce(p->>'meal_type', 'avond'); r app.mp_recipes;
begin
  perform app.assert_owner();
  if v_name = '' then raise exception 'Geef het recept een naam'; end if;
  if v_type not in ('ontbijt','lunch','snack','avond','avondsnack') then raise exception 'Kies ontbijt, lunch, snack, avond of avondsnack'; end if;
  if jsonb_typeof(coalesce(p->'ingredients', '[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(p->'steps', '[]'::jsonb)) <> 'array' then
    raise exception 'Ongeldige ingrediënten of stappen';
  end if;
  if exists (select 1 from app.mp_recipes where lower(name) = lower(v_name) and id is distinct from v_id and not hidden) then
    raise exception 'Er bestaat al een recept met die naam';
  end if;
  if v_id is null then
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
end $function$;

-- XXL Nutrition Fitpudding (te koop bij AH België, 200 g): per 100 g 86 kcal, 10 g eiwit, 8,5 g koolhydraten, 0,9 g vet
insert into app.foods (name, brand, per100, serving_g, serving_label, source, quick)
select v.name, 'XXL Nutrition', '{"kcal":86,"protein":10,"carbs":8.5,"fat":0.9}'::jsonb, 200, '1 cup (200 g)', 'manual', true
from (values ('Fitpudding vanille chocolade'), ('Fitpudding vanille karamel')) v(name)
where not exists (select 1 from app.foods f where lower(f.name) = lower(v.name) and not f.archived);

insert into app.mp_recipes (name, meal_type, servings, kcal, protein, carbs, fat, macros_checked, ingredients, steps, storage, description, note, status, favorite)
values
 ('XXL Fitpudding', 'avondsnack', 1, 172, 20, 17, 1.8, true,
  '[{"name":"XXL Nutrition Fitpudding vanille chocolade","amount":1,"unit":"stuk","dept":"Zuivel & eieren","pantry":false}]',
  '["Koud uit de koelkast eten.","Extra lekker met een handje blauwe bessen of een verkruimelde speculoos erover (tel die dan apart)."]',
  'Koelkast, gesloten tot de houdbaarheidsdatum.', 'Romige eiwitpudding voor ''s avonds: 20 g eiwit per cup.', 'Voorgesteld door Claude', 'klaar', false),
 ('Eiwitreep salted caramel', 'snack', 1, 171, 15.3, 14, 7.7, true,
  '[{"name":"AH Proteïnereep melk choco salted karamel","amount":1,"unit":"stuk","dept":"Ontbijt & sport","pantry":false}]',
  '["Gewoon uit de verpakking. Handig voor onderweg of na de gym."]',
  'Kast, tot de houdbaarheidsdatum.', 'Snelle snack voor dagen zonder kwark.', 'Voorgesteld door Claude', 'klaar', false),
 ('Speculoos-cheesecake kwark', 'snack', 1, 235, 23.7, 28.4, 3.2, true,
  '[{"name":"Magere kwark","amount":250,"unit":"g","dept":"Zuivel & eieren","pantry":false},{"name":"Lotus speculoos","amount":2,"unit":"stuk","dept":"Houdbaar","pantry":false},{"name":"Monin siroop caramel sugar free","amount":10,"unit":"ml","dept":"Houdbaar","pantry":true},{"name":"Blauwe bessen","amount":50,"unit":"g","dept":"Groenten & fruit","pantry":false}]',
  '["Roer de siroop door de kwark.","Verkruimel 1 speculoos door de kwark en de andere erover als crunch.","Bessen erop. Maak het pas vlak voor het eten, anders wordt de speculoos zacht."]',
  'Kwark los in de koelkast; speculoos pas op het moment zelf erbij.', 'Smaakt als cheesecake, maar met 24 g eiwit.', 'Voorgesteld door Claude', 'klaar', false),
 ('Wrap kip-shoarma met knoflookkwark', 'lunch', 4, 620, 52, 63, 16, false,
  '[{"name":"Volkoren wraps","amount":2,"unit":"stuk","dept":"Brood & wraps","pantry":false},{"name":"Kipfilet","amount":150,"unit":"g","dept":"Vlees & vis","pantry":false},{"name":"Shoarmakruiden","amount":5,"unit":"g","dept":"Houdbaar","pantry":true},{"name":"IJsbergsla","amount":40,"unit":"g","dept":"Groenten & fruit","pantry":false},{"name":"Paprika","amount":0.5,"unit":"stuk","dept":"Groenten & fruit","pantry":false},{"name":"Magere kwark","amount":50,"unit":"g","dept":"Zuivel & eieren","pantry":false},{"name":"Knoflook","amount":0.5,"unit":"teen","dept":"Groenten & fruit","pantry":false},{"name":"Olijfolie","amount":5,"unit":"ml","dept":"Houdbaar","pantry":true}]',
  '["Snijd de kip in reepjes, meng met de shoarmakruiden en bak 6 à 8 minuten in de olie tot ze gaar is.","Snijd de paprika in reepjes en bak de laatste 3 minuten mee.","Meng de kwark met de geraspte knoflook en wat zout: dat is je knoflooksaus.","Verdeel de kip over potjes; saus en sla apart.","Op de dag zelf: wraps kort opwarmen, sla, kip en knoflookkwark erin en oprollen."]',
  'Kip 3 à 4 dagen in de koelkast; sla en saus apart bewaren.', 'Variatie op de gehaktwrap: kip-shoarma met een frisse knoflooksaus.', 'Voorgesteld door Claude · macro''s berekend met standaardwaarden', 'klaar', false),
 ('Kip curry met rijst', 'avond', 3, 620, 50, 67, 15, false,
  '[{"name":"Kipfilet","amount":175,"unit":"g","dept":"Vlees & vis","pantry":false},{"name":"Basmatirijst (droog)","amount":75,"unit":"g","dept":"Houdbaar","pantry":false},{"name":"Kokosmelk light","amount":100,"unit":"ml","dept":"Houdbaar","pantry":false},{"name":"Rode currypasta","amount":15,"unit":"g","dept":"Houdbaar","pantry":false},{"name":"Wokgroenten","amount":150,"unit":"g","dept":"Groenten & fruit","pantry":false},{"name":"Olijfolie","amount":5,"unit":"ml","dept":"Houdbaar","pantry":true}]',
  '["Kook de rijst volgens de verpakking, spoel kort af met koud water en laat snel afkoelen.","Snijd de kip in blokjes en bak ze 5 minuten in de olie.","Roer de currypasta erdoor en bak 1 minuut mee.","Voeg de wokgroenten toe en roerbak 3 minuten.","Giet de kokosmelk erbij en laat 5 minuten zachtjes pruttelen tot de kip gaar is.","Verdeel rijst en curry over 3 potjes."]',
  'Koelkast 3 dagen (rijst hoogstens 2 à 3 dagen). Curry kan ook in de diepvries.', 'Romige curry die smaakt naar afhaal, maar past in je macro''s.', 'Voorgesteld door Claude · macro''s berekend met standaardwaarden', 'klaar', false)
on conflict do nothing;

update app.settings
set value = value || jsonb_build_object(
  'snack', 'Wissel af: magere kwark in verschillende smaken (bv. speculoos-cheesecake), soms een eiwitreep (AH Proteïnereep), niet elke dag hetzelfde.',
  'avondsnack', 'Plan 2 à 4 keer per week een avondsnack, bv. XXL Fitpudding (vanille chocolade of karamel, te koop bij AH), binnen het dagdoel.',
  'variatie', 'Niet eentonig: elke week minstens één ander lunch- of avondgerecht dan vorige week, en elke week één ''lekker'' gerecht of traktatie die past in zijn macro''s (bv. curry, smashburger-bowl, eiwitpannenkoeken, kip-shoarma).')
where key = 'mealprep';
