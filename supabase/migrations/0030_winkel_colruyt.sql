-- Boodschappen: derde winkel "Colruyt / Lidl" (bv. filet americain als mager gehakt).
-- Ingrediënt met "winkel": "Colruyt" komt op een eigen lijst, tussen AH (zondag) en Okay (tussendag).
create or replace function public.mp_shopping_build(p_week_id bigint)
returns jsonb language sql stable security definer set search_path = '' as $$
  with cfg as (
    select w.week_start,
           case lower(coalesce((select s.value->>'tussendag' from app.settings s where s.key = 'mealprep'), 'woensdag'))
             when 'maandag' then 1 when 'dinsdag' then 2 when 'donderdag' then 4 else 3 end as tus_off,
           lower(coalesce((select s.value->>'tussendag' from app.settings s where s.key = 'mealprep'), 'woensdag')) as tus_naam
    from app.mp_weeks w where w.id = p_week_id
  ), first_day as (
    select i.recipe_id, min(i.day) as d from app.mp_week_items i where i.week_id = p_week_id group by i.recipe_id
  ), src as (
    select i.portions as mult, r.ingredients, i.slot, i.day, f.d as first_d
    from app.mp_week_items i join app.mp_recipes r on r.id = i.recipe_id
    join first_day f on f.recipe_id = i.recipe_id
    where i.week_id = p_week_id
    union all
    select l.portions, r.ingredients, 'extra', null::date, null::date
    from app.mp_list_recipes l join app.mp_recipes r on r.id = l.recipe_id where l.week_id = p_week_id
  ), ing as (
    select btrim(e->>'name') as name, nullif(btrim(e->>'unit'), '') as unit,
           coalesce(nullif(e->>'dept', ''), 'Overig') as dept,
           coalesce((e->>'pantry')::boolean, false) as pantry,
           case when jsonb_typeof(e->'amount') = 'number' then (e->>'amount')::numeric * s.mult end as amt,
           case
             when e->>'winkel' = 'AH' then 'zondag'
             when e->>'winkel' = 'Okay' then 'tussendag'
             when e->>'winkel' = 'Colruyt' then 'colruyt'
             when coalesce(nullif(e->>'dept', ''), 'Overig') not in ('Groenten & fruit', 'Vlees & vis', 'Zuivel & eieren') then 'zondag'
             when coalesce((e->>'pantry')::boolean, false) then 'zondag'
             when s.slot in ('ontbijt', 'snack', 'avondsnack') and s.day >= c.week_start + c.tus_off then 'tussendag'
             when s.slot in ('lunch', 'avond') and s.first_d >= c.week_start + c.tus_off then 'tussendag'
             else 'zondag'
           end as moment
    from src s cross join cfg c cross join lateral jsonb_array_elements(s.ingredients) e
    where coalesce(btrim(e->>'name'), '') <> ''
  ), agg as (
    select case moment when 'tussendag' then 'tus|' when 'colruyt' then 'col|' else '' end || lower(name) || '|' || coalesce(unit, '') as key,
           min(name) as name, unit, min(dept) as dept, moment,
           bool_and(pantry) as pantry, sum(amt) as amount, null::bigint as extra_id
    from ing group by moment, lower(name), unit
    union all
    select 'extra|' || x.id, x.name, null, x.dept, 'zondag', false, null, x.id from app.mp_list_extras x where x.week_id = p_week_id
  ), rows_ as (
    select a.*,
      exists (select 1 from app.mp_weeks w cross join lateral jsonb_array_elements(w.bonus) b
              where w.id = p_week_id and lower(btrim(coalesce(b->>'ingredient', ''))) = lower(a.name)) as bonus,
      coalesce((select c.checked from app.mp_list_checks c where c.week_id = p_week_id and c.key = a.key), false) as checked,
      coalesce(array_position(array['Groenten & fruit','Vlees & vis','Zuivel & eieren','Brood & wraps','Houdbaar','Ontbijt & sport','Diepvries','Overig'], a.dept), 99) as dept_ord
    from agg a
  ), groups as (
    select moment, dept, min(dept_ord) as dept_ord,
      jsonb_agg(jsonb_build_object('key', key, 'name', name, 'amount', round(amount, 1), 'unit', unit, 'pantry', pantry,
                                   'bonus', bonus, 'checked', checked, 'extra_id', extra_id, 'moment', moment)
                order by pantry, lower(name)) as items
    from rows_ group by moment, dept
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'moment', g.moment,
           'moment_label', ml.label,
           'afdeling', g.dept,
           'dept', ml.label || ' · ' || g.dept,
           'items', g.items)
         order by case g.moment when 'zondag' then 0 when 'colruyt' then 1 else 2 end, g.dept_ord, g.dept), '[]'::jsonb)
  from groups g
  cross join lateral (
    select case when g.moment = 'zondag' then 'Zondag (AH)'
                when g.moment = 'colruyt' then 'Colruyt / Lidl'
                else initcap(coalesce((select tus_naam from cfg), 'woensdag')) || ' (Okay)' end as label
  ) ml;
$$;
revoke all on function public.mp_shopping_build(bigint) from public, anon, authenticated;

-- Nieuwe week maken (volgende zondag na de laatste week), eventueel als kopie van een week.
create or replace function public.mp_week_new(p_copy_from bigint default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_last date; v_start date; v_id bigint; v_from date;
begin
  perform app.assert_owner();
  select max(week_start) into v_last from app.mp_weeks;
  v_start := coalesce(v_last + 7, (now() at time zone 'Europe/Brussels')::date + ((7 - extract(dow from (now() at time zone 'Europe/Brussels')::date)::int) % 7));
  insert into app.mp_weeks (week_start, notes, prep)
  values (v_start, case when p_copy_from is not null then 'Kopie van een vorige week. Pas aan wat je anders wilt.' end,
          coalesce((select prep from app.mp_weeks where id = p_copy_from), '[]'::jsonb))
  on conflict (week_start) do update set week_start = excluded.week_start returning id into v_id;
  if p_copy_from is not null and not exists (select 1 from app.mp_week_items where week_id = v_id) then
    select week_start into v_from from app.mp_weeks where id = p_copy_from;
    insert into app.mp_week_items (week_id, day, slot, recipe_id, portions)
    select v_id, v_start + (i.day - v_from), i.slot, i.recipe_id, i.portions
    from app.mp_week_items i join app.mp_recipes r on r.id = i.recipe_id and not r.hidden
    where i.week_id = p_copy_from and i.day - v_from between 0 and 6;
  end if;
  return v_id;
end $$;
revoke all on function public.mp_week_new(bigint) from public, anon;
grant execute on function public.mp_week_new(bigint) to authenticated;
