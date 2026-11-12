-- Om 19:00 (Brussel) een melding als de gewoonte "creatine" vandaag nog niet is afgevinkt.
create or replace function app.creatine_nudge()
returns void language plpgsql security definer set search_path = '' as $$
declare v_now timestamp := now() at time zone 'Europe/Brussels'; v_day date := v_now::date; h record;
begin
  if extract(hour from v_now) <> 19 then return; end if;
  for h in select id, name from app.habits where not archived and name ilike '%creatine%' loop
    if exists (select 1 from app.habit_log l where l.habit_id = h.id and l.day = v_day and l.done) then continue; end if;
    if exists (select 1 from app.push_outbox o where o.title = 'Creatine 💊' and (o.created_at at time zone 'Europe/Brussels')::date = v_day) then continue; end if;
    insert into app.push_outbox (title, body, url) values ('Creatine 💊', 'Nog je ' || h.name || ' nemen? Vink het af op Vandaag.', '/#/vandaag');
  end loop;
end $$;
revoke all on function app.creatine_nudge() from public, anon, authenticated;
select cron.schedule('creatine-nudge', '1 17,18 * * *', $$select app.creatine_nudge()$$);
