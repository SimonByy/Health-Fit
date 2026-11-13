-- Gewichtstrend: afvlakking houdt rekening met de tijd tussen twee wegingen.
-- Vroeger schoof de trend bij elke weging 10% op, ongeacht hoe lang de vorige geleden was.
-- Bij weinig wegingen liep de trend daardoor maanden achter (bv. 86 kg trend bij 72,5 kg op de weegschaal).
-- Nu: per verstreken dag 10% (dagelijks wegen geeft exact hetzelfde resultaat als voorheen),
-- dus na een week zonder weging telt de nieuwe waarde voor ~52% mee, na een maand voor ~96%.
create or replace function health.weight_trend(p_from date, p_to date)
returns table(day date, weight_kg numeric, trend_kg numeric)
language plpgsql stable security definer set search_path to ''
as $function$
declare
  r record;
  tr numeric := null;
  last_w date := null;
  v_start date;
begin
  select min(s.day) into v_start from ai.daily_summary s where s.weight_kg is not null and s.day >= p_from - 90 and s.day <= p_to;
  if v_start is null then return; end if;
  for r in select g::date as d, s.weight_kg as w
           from generate_series(v_start, p_to, interval '1 day') g
           left join ai.daily_summary s on s.day = g::date loop
    if r.w is not null then
      tr := case when tr is null then r.w
                 else tr + (1 - power(0.9, greatest(1, r.d - last_w))) * (r.w - tr) end;
      last_w := r.d;
    end if;
    if r.d >= p_from then
      day := r.d; weight_kg := r.w; trend_kg := round(tr, 2);
      return next;
    end if;
  end loop;
end $function$;
