-- i am Architect: saved projects, one owner each.
--
-- Run once per Supabase project - with the Supabase CLI (`supabase db push`
-- from backend/), or by pasting this file into the dashboard's SQL editor.
-- It is idempotent: running it again changes nothing.
--
-- Ownership is enforced HERE, by Row Level Security, not only by the app:
-- the backend queries this table with the anon key plus the signed-in
-- user's own access token, so every statement runs as that user and
-- auth.uid() is who they are. They can only see, create, change and delete
-- rows whose user_id is their own id. The anon role gets no access at all.

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null
    constraint projects_name_check check (char_length(btrim(name)) between 1 and 120),
  -- The construction document (src/engine/project/projectDocument.ts):
  -- { version, objects: [...], assemblies: [...] }. The app validates it in
  -- full on every save and every open; the database checks its envelope.
  document jsonb not null
    constraint projects_document_check check (
      jsonb_typeof(document) = 'object'
      and jsonb_typeof(document -> 'version') = 'number'
      and jsonb_typeof(document -> 'objects') = 'array'
      and jsonb_typeof(document -> 'assemblies') = 'array'
      and octet_length(document::text) <= 5000000
    ),
  -- For the project list, which never loads documents.
  object_count integer generated always as (
    case when jsonb_typeof(document -> 'objects') = 'array' then jsonb_array_length(document -> 'objects') else 0 end
  ) stored,
  assembly_count integer generated always as (
    case when jsonb_typeof(document -> 'assemblies') = 'array' then jsonb_array_length(document -> 'assemblies') else 0 end
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists projects_user_id_updated_at_idx on public.projects (user_id, updated_at desc);

-- Timestamps are the database's, not the client's: a new row is stamped
-- now; an update moves updated_at to now and can never change created_at
-- or hand the project to another user.
create or replace function public.projects_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := new.created_at;
  else
    new.id := old.id;
    new.user_id := old.user_id;
    new.created_at := old.created_at;
    new.updated_at := greatest(now(), old.updated_at);
  end if;
  return new;
end;
$$;

drop trigger if exists projects_stamp on public.projects;
create trigger projects_stamp
  before insert or update on public.projects
  for each row execute function public.projects_stamp();

-- Row Level Security: each user reaches only their own projects.
alter table public.projects enable row level security;

drop policy if exists "Users read their own projects" on public.projects;
create policy "Users read their own projects" on public.projects
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users create their own projects" on public.projects;
create policy "Users create their own projects" on public.projects
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users update their own projects" on public.projects;
create policy "Users update their own projects" on public.projects
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users delete their own projects" on public.projects;
create policy "Users delete their own projects" on public.projects
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Signed-out requests get nothing; signed-in users get exactly the four
-- operations the app uses, still filtered row by row by the policies above.
revoke all on public.projects from anon;
revoke all on public.projects from authenticated;
grant select, insert, update, delete on public.projects to authenticated;
