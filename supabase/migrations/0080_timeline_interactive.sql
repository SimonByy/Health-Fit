-- 0080_timeline_interactive: tijdlijn op Vandaag wordt interactief.
-- 1. log_food(p) aanvaardt p.at (tijdstip): eten dat je achteraf op een uur toevoegt, staat op dat uur in de tijdlijn.
-- 2. coach_set_time(id, uur): een geplande training een tijdstip geven (verschijnt dan in de tijdlijn).
-- 3. get_day_timeline toont ook water, cafeïne en gewicht die je zelf logde, en geplande maaltijden uit je weekmenu
--    die nog niet gegeten zijn (met item_id, zodat je ze vanuit de tijdlijn kan afvinken, aanpassen of weghalen).
do $do$
declare f text := pg_get_functiondef('public.log_food(jsonb)'::regprocedure);
begin
  if position('p->>''at''' in f) = 0 then
    f := replace(f, 'v_ts timestamptz := clock_timestamp();',
      'v_ts timestamptz := coalesce(nullif(p->>''at'', '''')::timestamptz, clock_timestamp());');
    f := replace(f, 'carbs, fat, fiber, sugar, sodium_mg)
  values (v_id,', 'carbs, fat, fiber, sugar, sodium_mg, created_at)
  values (v_id,');
    f := replace(f, '(vals->>''sugar'')::numeric, (vals->>''sodium_mg'')::numeric);', '(vals->>''sugar'')::numeric, (vals->>''sodium_mg'')::numeric, v_ts);');
    if position('created_at)' in f) = 0 or position('v_ts);' in f) = 0 then raise exception 'log_food: patch paste niet'; end if;
    execute f;
  end if;
end $do$;

create or replace function public.coach_set_time(p_id bigint, p_time time)
 returns void language plpgsql security definer set search_path to ''
as $function$
begin
  perform app.assert_owner();
  update app.coach_sessions set start_local = p_time where id = p_id and user_id = app.uid();
  if not found then raise exception 'Sessie niet gevonden'; end if;
end $function$;
grant execute on function public.coach_set_time(bigint, time) to authenticated;

do $do$
declare f text := pg_get_functiondef('public.get_day_timeline(date)'::regprocedure);
  anchor text := '  select * into s from ai.sleep where day = d + 1';
  extra text := $x$  -- zelf gelogd: water, cafeïne, gewicht
  ev := ev || coalesce((select jsonb_agg(jsonb_build_object('kind', 'entry', 'metric', m.metric, 'at', (m.ts at time zone tz), 'ts', m.ts,
      'title', case m.metric when 'dietary_water' then 'Water' when 'dietary_caffeine' then 'Cafeïne' else 'Gewicht' end,
      'sub', case m.metric when 'dietary_water' then round(m.qty) || ' ml' when 'dietary_caffeine' then round(m.qty) || ' mg' else round(m.qty::numeric, 1) || ' kg' end))
    from health.metric_samples m where m.day = d and m.user_id = app.uid() and m.source = 'Health Hub' and not coalesce(m.voided, false)
      and m.metric in ('dietary_water', 'dietary_caffeine', 'weight_body_mass')), '[]'::jsonb);
  -- gepland in je weekmenu, nog niet gegeten
  ev := ev || coalesce((select jsonb_agg(jsonb_build_object('kind', 'mplan', 'planned', true, 'item_id', i.id, 'slot', i.slot, 'recipe_id', i.recipe_id,
      'portions', i.portions, 'at', d + case i.slot when 'ontbijt' then time '08:45' when 'lunch' then time '12:30' when 'snack' then time '16:00'
        when 'avond' then time '18:45' else time '21:30' end,
      'title', r.name, 'kcal', round(coalesce(r.kcal, 0) * coalesce(i.portions, 1)), 'protein', round(coalesce(r.protein, 0) * coalesce(i.portions, 1)),
      'sub', 'gepland in je weekmenu'))
    from app.mp_week_items i join app.mp_recipes r on r.id = i.recipe_id
    where i.day = d and i.user_id = app.uid() and i.food_log_id is null), '[]'::jsonb);
  -- geplande trainingen: ook met id (om een tijdstip te kiezen)
$x$;
begin
  if position('''mplan''' in f) = 0 then
    if position(anchor in f) = 0 then raise exception 'get_day_timeline: anker niet gevonden'; end if;
    f := replace(f, anchor, extra || anchor);
    f := replace(f, '''kind'', ''plan'', ''at'', (d + c.start_local), ''title'', c.title,', '''kind'', ''plan'', ''id'', c.id, ''at'', (d + c.start_local), ''title'', c.title,');
    execute f;
  end if;
end $do$;
