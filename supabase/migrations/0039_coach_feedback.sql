-- Feedback van de coach (Claude): per training en per week, getoond in de tab Feedback
create table if not exists app.coach_feedback (
  id bigserial primary key,
  kind text not null check (kind in ('training', 'week')),
  day date not null,
  ref text not null default '',          -- training: id uit ai.workouts / ai.strength_workouts; week: ''
  sport text,                            -- run, loopband, kracht, cardio
  title text,
  summary text,                          -- 1–3 zinnen
  good text,                             -- wat goed ging (punten met " · ")
  improve text,                          -- wat beter kan
  focus text,                            -- één focus / tip voor de volgende keer
  stats jsonb not null default '{}'::jsonb,  -- extra cijfers (bv. tijd in zone, km-splits, beste sets)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, day, ref)
);
alter table app.coach_feedback enable row level security;

-- Alles voor de tab: recente trainingen (Garmin + Hevy) met hun feedback, en de weekfeedback
create or replace function public.get_feedback_feed(p_days int default 28)
 returns jsonb language plpgsql stable security definer set search_path to ''
as $$
declare d0 date := (now() at time zone 'Europe/Brussels')::date - greatest(1, least(p_days, 120));
begin
  perform app.assert_owner();
  return jsonb_build_object(
    'trainings', coalesce((
      select jsonb_agg(t order by t.start_local desc nulls last) from (
        select w.id as ref, w.day, w.start_local,
               case when lower(coalesce(w.name, '')) ~ 'loopband|treadmill|incline' then 'loopband'
                    when lower(coalesce(w.name, '')) ~ 'hardlopen|run|loop' then 'run' else 'cardio' end as sport,
               w.name as title, round(w.duration_min, 1) as duration_min, round(w.distance_km, 2) as distance_km,
               w.avg_hr, w.max_hr, round(w.pace_min_per_km, 2) as pace_min_per_km, w.active_kcal,
               null::numeric as volume_kg, null::bigint as working_sets, null::bigint as exercises,
               (select to_jsonb(f) - 'id' - 'kind' - 'created_at' from app.coach_feedback f where f.kind = 'training' and f.ref = w.id) as feedback
        from ai.workouts w
        where w.day >= d0 and not coalesce(w.duplicate_of_hevy, false)
        union all
        select s.id, s.day, s.start_local, 'kracht', s.title, round(s.duration_min, 1), null, null, null, null, null,
               round(s.volume_kg), s.working_sets, s.exercises,
               (select to_jsonb(f) - 'id' - 'kind' - 'created_at' from app.coach_feedback f where f.kind = 'training' and f.ref = s.id)
        from ai.strength_workouts s
        where s.day >= d0
      ) t), '[]'::jsonb),
    'weeks', coalesce((
      select jsonb_agg(to_jsonb(f) - 'id' - 'kind' order by f.day desc)
      from (select * from app.coach_feedback where kind = 'week' order by day desc limit 8) f), '[]'::jsonb),
    'goal', 'Halve marathon, zomer 2027'
  );
end $$;
grant execute on function public.get_feedback_feed(int) to authenticated;
