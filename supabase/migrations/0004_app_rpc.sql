-- =====================================================================
-- RPC-functies voor de app (alleen de eigenaar)
-- =====================================================================

create or replace function public.am_i_owner()
returns boolean language sql stable security definer set search_path = '' as $$
  select app.is_owner();
$$;

-- Dashboard voor één dag
create or replace function public.get_dashboard(p_day date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  d date := coalesce(p_day, (now() at time zone 'Europe/Brussels')::date);
  res jsonb;
begin
  perform app.assert_owner();
  select jsonb_build_object(
    'day', d,
    'today', (select to_jsonb(s) from ai.daily_summary s where s.day = d),
    'avg7', (select jsonb_build_object(
        'steps', round(avg(steps)), 'sleep_h', round(avg(sleep_h), 2),
        'resting_hr', round(avg(resting_hr)), 'hrv_ms', round(avg(hrv_ms)),
        'kcal_in', round(avg(kcal_in)), 'protein_g', round(avg(protein_g)),
        'active_kcal', round(avg(active_kcal)), 'weight_kg', round(avg(weight_kg), 1))
      from ai.daily_summary s where s.day between d - 7 and d - 1),
    'series', (select coalesce(jsonb_agg(jsonb_build_object(
        'day', s.day, 'steps', s.steps, 'sleep_h', s.sleep_h, 'resting_hr', s.resting_hr,
        'hrv_ms', s.hrv_ms, 'kcal_in', s.kcal_in, 'protein_g', s.protein_g,
        'weight_kg', s.weight_kg, 'active_kcal', s.active_kcal,
        'strength_volume_kg', s.strength_volume_kg, 'cardio_min', s.cardio_min) order by s.day), '[]'::jsonb)
      from ai.daily_summary s where s.day between d - 29 and d),
    'last_weight', (select jsonb_build_object('day', s.day, 'kg', s.weight_kg)
      from ai.daily_summary s where s.weight_kg is not null and s.day <= d order by s.day desc limit 1),
    'goals', (select value from app.settings where key = 'goals'),
    'recent', public.get_activities(6, 0),
    'sync', (select coalesce(jsonb_object_agg(source, jsonb_build_object(
        'last_success', last_success, 'last_run', last_run, 'last_error', last_error)), '{}'::jsonb)
      from app.sync_state)
  ) into res;
  return res;
end $$;

-- Dagoverzicht voor een periode
create or replace function public.get_range(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (select coalesce(jsonb_agg(to_jsonb(s) order by s.day), '[]'::jsonb)
          from ai.daily_summary s where s.day between p_from and p_to);
end $$;

-- Gecombineerde activiteitenlijst (Hevy + Apple Health/Garmin)
create or replace function public.get_activities(p_limit int default 30, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (
    select coalesce(jsonb_agg(x order by x->>'start_local' desc), '[]'::jsonb) from (
      select to_jsonb(a) as x from (
        select 'strength' as kind, id, day, start_local::text as start_local, title,
               duration_min, null::numeric as distance_km, null::numeric as active_kcal,
               null::numeric as avg_hr, working_sets as sets, volume_kg, exercises
        from ai.strength_workouts
        union all
        select 'cardio', id, day, start_local::text, name, duration_min, distance_km, active_kcal,
               avg_hr, null, null, null
        from ai.workouts where not duplicate_of_hevy
        order by start_local desc
        limit greatest(p_limit, 1) offset greatest(p_offset, 0)
      ) a
    ) y
  );
end $$;

-- Detail van één Hevy-training
create or replace function public.get_hevy_workout(p_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return jsonb_build_object(
    'workout', (select to_jsonb(w) from ai.strength_workouts w where w.id = p_id),
    'exercises', (
      select coalesce(jsonb_agg(e order by e->>'idx'), '[]'::jsonb) from (
        select jsonb_build_object(
          'idx', lpad(exercise_index::text, 3, '0'),
          'exercise', exercise, 'muscle', primary_muscle,
          'best_1rm', max(est_1rm_kg),
          'sets', jsonb_agg(jsonb_build_object(
             'type', set_type, 'kg', weight_kg, 'reps', reps, 'rpe', rpe,
             'distance_m', distance_m, 'duration_s', duration_s) order by set_index)) as e
        from ai.strength_sets where workout_id = p_id
        group by exercise_index, exercise, primary_muscle
      ) z)
  );
end $$;

-- Oefeningen en progressie
create or replace function public.get_exercises()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (select coalesce(jsonb_agg(to_jsonb(e) order by e.last_day desc), '[]'::jsonb) from (
    select exercise, max(primary_muscle) as muscle, count(distinct workout_id) as sessions,
           max(day) as last_day, max(est_1rm_kg) as best_1rm, max(weight_kg) as max_kg
    from ai.strength_sets where set_type <> 'warmup'
    group by exercise) e);
end $$;

create or replace function public.get_exercise_history(p_exercise text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (select coalesce(jsonb_agg(to_jsonb(h) order by h.day), '[]'::jsonb) from (
    select day, workout_id, max(est_1rm_kg) as best_1rm, max(weight_kg) as top_kg,
           sum(volume_kg) as volume_kg, count(*) as sets,
           (array_agg(reps order by weight_kg desc nulls last, reps desc))[1] as top_reps
    from ai.strength_sets where exercise = p_exercise and set_type <> 'warmup'
    group by day, workout_id) h);
end $$;

-- Voeding voor één dag: alle nutriënten + per maaltijd
create or replace function public.get_nutrition_day(p_day date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return jsonb_build_object(
    'day', p_day,
    'nutrients', (select coalesce(jsonb_agg(jsonb_build_object(
        'metric', m.metric, 'label', m.label, 'value', round(m.value::numeric, 1), 'unit', coalesce(c.unit, m.unit)
      ) order by c.sort nulls last, m.label), '[]'::jsonb)
      from ai.daily_metrics m left join health.metric_catalog c on c.metric = m.metric
      where m.day = p_day and m.category = 'voeding'),
    'meals', (select coalesce(jsonb_agg(to_jsonb(n) order by n.first_hour), '[]'::jsonb)
      from ai.nutrition_by_meal n where n.day = p_day),
    'goals', (select value from app.settings where key = 'goals')
  );
end $$;

-- Instellingen
create or replace function public.get_settings()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return jsonb_build_object(
    'settings', (select jsonb_object_agg(key, value) from app.settings),
    'secrets', jsonb_build_object(
      'hevy_api_key', coalesce(app.get_secret('hevy_api_key'), '') <> '',
      'anthropic_api_key', coalesce(app.get_secret('anthropic_api_key'), '') <> ''),
    'ingest_token', app.get_secret('ingest_token'),
    'sync', (select coalesce(jsonb_object_agg(source, to_jsonb(s) - 'cursor'), '{}'::jsonb) from app.sync_state s),
    'log', (select coalesce(jsonb_agg(to_jsonb(l) order by l.id desc), '[]'::jsonb)
            from (select * from app.ingest_log order by id desc limit 15) l),
    'counts', jsonb_build_object(
      'samples', (select count(*) from health.metric_samples),
      'workouts', (select count(*) from health.workouts),
      'hevy_workouts', (select count(*) from health.hevy_workouts where deleted_at is null),
      'sleep_nights', (select count(*) from ai.sleep),
      'first_day', (select min(day) from ai.daily_summary))
  );
end $$;

create or replace function public.set_setting(p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  if p_key not in ('goals', 'ai_model', 'meal_slots') then
    raise exception 'Onbekende instelling %', p_key;
  end if;
  insert into app.settings(key, value, updated_at) values (p_key, p_value, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;

create or replace function public.set_secret(p_name text, p_value text)
returns void language plpgsql security definer set search_path = '' as $$
declare sid uuid;
begin
  perform app.assert_owner();
  if p_name not in ('hevy_api_key', 'anthropic_api_key') then
    raise exception 'Onbekende sleutel %', p_name;
  end if;
  select id into sid from vault.secrets where name = p_name;
  -- lege waarde = sleutel wissen (wordt als 'niet ingesteld' behandeld)
  if sid is null then
    perform vault.create_secret(coalesce(btrim(p_value), ''), p_name);
  else
    perform vault.update_secret(sid, coalesce(btrim(p_value), ''));
  end if;
end $$;

create or replace function public.rotate_ingest_token()
returns text language plpgsql security definer set search_path = '' as $$
declare sid uuid; tok text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  perform app.assert_owner();
  select id into sid from vault.secrets where name = 'ingest_token';
  perform vault.update_secret(sid, tok);
  return tok;
end $$;

-- Chat
create or replace function public.get_chat(p_conversation uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare conv uuid := p_conversation;
begin
  perform app.assert_owner();
  if conv is null then
    select conversation_id into conv from app.chat_messages order by id desc limit 1;
  end if;
  return jsonb_build_object('conversation_id', conv,
    'messages', (select coalesce(jsonb_agg(jsonb_build_object('role', role, 'content', content, 'meta', meta, 'created_at', created_at) order by id), '[]'::jsonb)
                 from app.chat_messages where conversation_id = conv));
end $$;

-- interne chatfuncties voor de AI-edge-function
create or replace function public.internal_chat_history(p_conversation uuid, p_limit int)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('role', role, 'content', content) order by id), '[]'::jsonb)
  from (select * from app.chat_messages where conversation_id = p_conversation order by id desc limit p_limit) x;
$$;

create or replace function public.internal_chat_add(p_conversation uuid, p_role text, p_content text, p_meta jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into app.chat_messages(conversation_id, role, content, meta) values (p_conversation, p_role, p_content, p_meta);
$$;

-- Rechten
do $$
declare f text;
begin
  foreach f in array array[
    'public.am_i_owner()', 'public.get_dashboard(date)', 'public.get_range(date,date)',
    'public.get_activities(integer,integer)', 'public.get_hevy_workout(text)', 'public.get_exercises()',
    'public.get_exercise_history(text)', 'public.get_nutrition_day(date)', 'public.get_settings()',
    'public.set_setting(text,jsonb)', 'public.set_secret(text,text)', 'public.rotate_ingest_token()',
    'public.get_chat(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['public.internal_chat_history(uuid,integer)', 'public.internal_chat_add(uuid,text,text,jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- Interne helpers niet uitvoerbaar voor clients
revoke all on function app.claim_first_owner() from public, anon, authenticated;
