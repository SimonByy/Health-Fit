-- Voorlezen met een Gemini-stem: audio wordt bewaard (bucket tts) en vooraf klaargezet
-- zodra er een briefing is.

insert into storage.buckets (id, name, public, file_size_limit)
values ('tts', 'tts', false, 20971520) on conflict (id) do nothing;

insert into app.settings (key, value) values ('tts_voice', '{"voice": "Sulafat"}'::jsonb)
on conflict (key) do nothing;

-- Tekst om voor te lezen (alleen voor de edge function, service role)
create or replace function public.internal_tts_text(p_day date default null, p_reply bigint default null)
returns text language sql stable security definer set search_path to ''
as $$
  select case when p_reply is not null
    then (select answer from app.briefing_replies where id = p_reply)
    else (select text from app.briefings where day = p_day) end;
$$;

create or replace function public.internal_tts_voice_save(p_voice text)
returns void language sql security definer set search_path to ''
as $$
  insert into app.settings (key, value) values ('tts_voice', jsonb_build_object('voice', p_voice))
  on conflict (key) do update set value = excluded.value;
$$;

revoke all on function public.internal_tts_text(date, bigint) from public, anon, authenticated;
revoke all on function public.internal_tts_voice_save(text) from public, anon, authenticated;
grant execute on function public.internal_tts_text(date, bigint) to service_role;
grant execute on function public.internal_tts_voice_save(text) to service_role;

create or replace function app.tts_kick()
returns trigger language plpgsql security definer set search_path to ''
as $$
begin
  perform net.http_post(
    url := 'https://jzqqriddjpcigmxmnaug.supabase.co/functions/v1/tts',
    body := case when tg_table_name = 'briefings' then jsonb_build_object('briefing_day', new.day)
                 else jsonb_build_object('reply_id', new.id) end,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 2000);
  return new;
exception when others then
  return new; -- nooit het opslaan zelf laten mislukken
end $$;

create trigger tts_kick after insert or update of text on app.briefings
  for each row when (new.text is not null) execute function app.tts_kick();
-- (antwoorden op de briefing zet de app zelf om, anders dubbele oproepen)
