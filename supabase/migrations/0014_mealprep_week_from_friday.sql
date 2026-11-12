-- Vanaf vrijdag toont de app de week van de komende zondag (nakijken en boodschappen).
create or replace function app.mp_current_week_id() returns bigint language sql stable security definer set search_path to '' as $f$
  select id from (
    (select id, 0 as o, week_start from app.mp_weeks
      where week_start <= (now() at time zone 'Europe/Brussels')::date + 2 order by week_start desc limit 1)
    union all
    (select id, 1, week_start from app.mp_weeks
      where week_start > (now() at time zone 'Europe/Brussels')::date + 2 order by week_start limit 1)
  ) w order by o limit 1;
$f$;
update app.routines set url = '/#/briefing/autoplay', body = 'Tik om je briefing te laten voorlezen' where title = 'Ochtendbriefing';
