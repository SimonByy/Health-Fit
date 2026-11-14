-- 0053: toegang op slot. access_mode 'closed' (alleen admin), 'invite' (admin + app.invites), 'open'.
-- accept_terms weigert anderen; beheer met public.admin_access(p_mode, p_add, p_remove) (alleen admin).

insert into app.config (key, value) values ('access_mode', '"closed"') on conflict (key) do nothing;

create table if not exists app.invites (
  email text primary key check (email = lower(btrim(email))),
  note text,
  created_at timestamptz not null default now()
);
alter table app.invites enable row level security;
revoke all on app.invites from public, anon, authenticated;

create or replace function public.accept_terms(p_name text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); m text; mail text; adm boolean;
begin
  if u is null then raise exception 'Niet ingelogd' using errcode = '42501'; end if;
  select coalesce(is_admin, false) into adm from app.profiles where user_id = u;
  if not coalesce(adm, false) then
    m := coalesce((select value #>> '{}' from app.config where key = 'access_mode'), 'closed');
    select lower(email) into mail from auth.users where id = u;
    if m = 'closed' or (m = 'invite' and not exists (select 1 from app.invites where email = mail)) then
      raise exception 'Health Hub is nog niet open. Je staat niet op de testerslijst.' using errcode = '42501';
    end if;
  end if;
  insert into app.profiles (user_id, display_name, consent_at) values (u, nullif(btrim(p_name), ''), now())
  on conflict (user_id) do update set consent_at = coalesce(app.profiles.consent_at, now()),
    display_name = coalesce(nullif(btrim(p_name), ''), app.profiles.display_name);
  return (select to_jsonb(p) from app.profiles p where p.user_id = u);
end $$;

create or replace function public.admin_access(p_mode text default null, p_add text default null, p_remove text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from app.profiles where user_id = auth.uid() and is_admin) then
    raise exception 'Alleen voor de beheerder' using errcode = '42501';
  end if;
  if p_mode is not null then
    if p_mode not in ('closed','invite','open') then raise exception 'Ongeldige modus'; end if;
    update app.config set value = to_jsonb(p_mode), updated_at = now() where key = 'access_mode';
  end if;
  if nullif(btrim(p_add), '') is not null then insert into app.invites (email) values (lower(btrim(p_add))) on conflict do nothing; end if;
  if nullif(btrim(p_remove), '') is not null then delete from app.invites where email = lower(btrim(p_remove)); end if;
  return jsonb_build_object('mode', (select value #>> '{}' from app.config where key = 'access_mode'),
    'invites', coalesce((select jsonb_agg(email order by created_at) from app.invites), '[]'::jsonb));
end $$;
revoke all on function public.admin_access(text, text, text) from public, anon;
grant execute on function public.admin_access(text, text, text) to authenticated;
