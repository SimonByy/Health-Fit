-- Hevy elke 30 minuten synchroniseren via de edge function sync-hevy
select cron.schedule(
  'hevy-sync',
  '*/30 * * * *',
  $$ select net.http_post(
       url := 'https://jzqqriddjpcigmxmnaug.supabase.co/functions/v1/sync-hevy',
       headers := jsonb_build_object('Content-Type', 'application/json',
                                     'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_token')),
       body := '{}'::jsonb,
       timeout_milliseconds := 150000) $$
);
