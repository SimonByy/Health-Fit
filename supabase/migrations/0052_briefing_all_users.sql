-- 0052: Gemini-ochtendbriefing voor elke gebruiker (de oorspronkelijke gebruiker houdt zijn Claude-taak).
create or replace function public.internal_briefing_users() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(p.user_id), '[]'::jsonb) from app.profiles p
  where p.consent_at is not null
    and p.user_id <> ((select value #>> '{}' from app.config where key = 'legacy_user'))::uuid
    and exists (select 1 from app.user_secrets s where s.user_id = p.user_id and s.name = 'gemini_api_key');
$$;
revoke all on function public.internal_briefing_users() from public, anon, authenticated;
grant execute on function public.internal_briefing_users() to service_role;

create or replace function app.briefing_kick() returns void
language sql security definer set search_path = '' as $$
  select net.http_post(
    url := 'https://jzqqriddjpcigmxmnaug.supabase.co/functions/v1/briefing',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_token')),
    body := '{}'::jsonb, timeout_milliseconds := 5000);
$$;

select cron.schedule('briefing-all', '*/15 5-10 * * *', $$ select app.briefing_kick() $$);
