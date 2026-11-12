-- Antwoorden op de ochtendbriefing: Simon spreekt of typt een antwoord in de app,
-- een geplande Claude-taak beantwoordt het (gratis, zonder API-tegoed) en stuurt een melding.

create table if not exists app.briefing_replies (
  id bigserial primary key,
  day date not null default (now() at time zone 'Europe/Brussels')::date,
  text text not null check (length(text) between 1 and 4000),
  status text not null default 'nieuw' check (status in ('nieuw', 'bezig', 'klaar', 'fout')),
  answer text,
  created_at timestamptz not null default now(),
  answered_at timestamptz
);
alter table app.briefing_replies enable row level security;

create or replace function public.briefing_reply_add(p_text text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r app.briefing_replies;
begin
  perform app.assert_owner();
  insert into app.briefing_replies (text) values (trim(p_text)) returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.briefing_replies_get(p_day date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.assert_owner();
  return (select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]'::jsonb) from app.briefing_replies r where r.day = p_day);
end $$;

revoke all on function public.briefing_reply_add(text) from public, anon;
revoke all on function public.briefing_replies_get(date) from public, anon;
grant execute on function public.briefing_reply_add(text) to authenticated;
grant execute on function public.briefing_replies_get(date) to authenticated;
