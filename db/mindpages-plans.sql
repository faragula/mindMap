-- MindPages — plány v Supabase.
--
-- Používá stejný Supabase projekt jako MindMap, ale vlastní tabulku, takže
-- MindMap zůstává nedotčený a nic se mu nerozbije.
--
-- Přístup hlídá RLS přes auth.uid(): každý řádek patří jednomu uživateli.
-- Aplikace má jeden účet, takže všechny plány patří jemu.
--
-- Nasazení: Supabase Dashboard → SQL Editor → New Query → vložit a spustit.
-- Je bezpečné spustit opakovaně.

create table if not exists public.mindpages_plans (
  id text primary key,
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null
    check (char_length(name) between 1 and 120),
  payload jsonb not null
    check (
      jsonb_typeof(payload) = 'object'
      and jsonb_typeof(payload -> 'nodes') = 'array'
      and jsonb_typeof(payload -> 'links') = 'array'
      and jsonb_typeof(payload -> 'viewport') = 'object'
    )
    check (octet_length(payload::text) <= 262144),
  payload_version integer not null default 1
    check (payload_version between 1 and 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.mindpages_plans is
  'Plany myslenek MindPages. Pristup jen pro vlastnika pres auth.uid().';

-- 2) Časová razítka spravuje trigger, klient je neposílá.
create or replace function public.mindpages_touch_plan()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists mindpages_plans_touch on public.mindpages_plans;
create trigger mindpages_plans_touch
  before insert or update on public.mindpages_plans
  for each row execute function public.mindpages_touch_plan();

-- 3) Row Level Security: řádek vidí a mění jen jeho vlastník.
alter table public.mindpages_plans enable row level security;

drop policy if exists "own plans" on public.mindpages_plans;
create policy "own plans"
  on public.mindpages_plans
  for all
  to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Anonymní klíč nesmí vidět nic. Authenticated smí jen to, co povolí politika.
revoke all on table public.mindpages_plans from public, anon;
grant select, insert, update, delete on table public.mindpages_plans to authenticated;
