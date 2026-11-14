-- Menuwens weer weghalen; geplande training meteen op 'gedaan' zodra ze binnenkomt.
create or replace function public.menu_wish_remove(p_id bigint)
 returns void language plpgsql security definer set search_path to ''
as $$
begin
  perform app.assert_owner();
  delete from app.menu_wishes where id = p_id;
end $$;
revoke all on function public.menu_wish_remove(bigint) from public, anon;
grant execute on function public.menu_wish_remove(bigint) to authenticated;

create or replace function app.feedback_enqueue()
 returns trigger language plpgsql security definer set search_path to ''
as $$
declare d date;
begin
  if tg_table_name = 'workouts' then
    if new.source = 'Garmin' and new.day >= (now() at time zone 'Europe/Brussels')::date - 1
       and coalesce(new.name, '') !~* 'strength|kracht|functional'
       and not exists (select 1 from app.coach_feedback f where f.kind = 'training' and f.ref = new.id) then
      insert into app.feedback_queue (ref, sport) values (new.id, 'cardio') on conflict (ref) do nothing;
      update app.coach_sessions set status = 'gedaan'
       where day = new.day and status = 'gepland' and kind ~* 'z2|run|loop|chill|interval|tempo|long|cardio';
    end if;
  else
    if new.deleted_at is null and new.start_ts > now() - interval '2 days'
       and not exists (select 1 from app.coach_feedback f where f.kind = 'training' and f.ref = new.id::text) then
      insert into app.feedback_queue (ref, sport) values (new.id::text, 'kracht') on conflict (ref) do nothing;
      d := (new.start_ts at time zone 'Europe/Brussels')::date;
      update app.coach_sessions set status = 'gedaan'
       where day = d and status = 'gepland' and kind !~* 'z2|run|loop|chill|interval|tempo|long|cardio';
    end if;
  end if;
  return new;
exception when others then return new;
end $$;

