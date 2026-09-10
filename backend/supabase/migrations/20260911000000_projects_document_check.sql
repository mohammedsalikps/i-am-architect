-- 20260911000000: tighten projects_document_check so that a document MISSING
-- "version", "objects" or "assemblies" is refused.
--
-- Why: the first version of the constraint (20260910000000) compared
-- jsonb_typeof(document -> 'version') = 'number'. For a missing key that is
-- NULL, and PostgreSQL treats a CHECK that evaluates to NULL as satisfied -
-- the real Supabase integration test inserted {"objects":[],"assemblies":[]}
-- directly through PostgREST and it was accepted. coalesce(..., '') turns
-- "missing" into a plain mismatch, so every clause is true or false, never
-- NULL.
--
-- The invariant it enforces (the app's project document contract):
--   the document is a JSON object, version is a number, objects is an
--   array, assemblies is an array - and the document is at most 5 MB.
--
-- Safe to run more than once, from the SQL editor or `supabase db push`:
-- - It is ONE statement (a DO block): it applies completely or not at all,
--   so the table is never left without a document constraint.
-- - If the constraint already has this definition, it changes nothing.
-- - It gives up after 10 s instead of waiting behind another session's lock
--   on the table (retry when nothing else is using it).
-- - It never deletes or edits data. If a stored row already breaks the
--   invariant, it stops, changes nothing, and names up to 20 such rows. See
--   DEPLOYMENT.md "Rows that break the document envelope";
--   supabase/verify_projects.sql (check 7) lists them too.

do $migration$
declare
  current_definition text;
  violating integer;
  examples text;
begin
  perform set_config('lock_timeout', '10s', true);

  select pg_get_constraintdef(c.oid)
    into current_definition
    from pg_constraint c
   where c.conrelid = 'public.projects'::regclass
     and c.conname = 'projects_document_check';

  if current_definition is not null and position('COALESCE' in upper(current_definition)) > 0 then
    raise notice 'projects_document_check already refuses missing keys - nothing to do.';
    return;
  end if;

  select count(*)
    into violating
    from public.projects p
   where not (
     jsonb_typeof(p.document) = 'object'
     and coalesce(jsonb_typeof(p.document -> 'version'), '') = 'number'
     and coalesce(jsonb_typeof(p.document -> 'objects'), '') = 'array'
     and coalesce(jsonb_typeof(p.document -> 'assemblies'), '') = 'array'
     and octet_length(p.document::text) <= 5000000
   );

  if violating > 0 then
    select string_agg(format('%s (owner %s, name %L, created %s)', v.id, v.user_id, v.name, v.created_at), '; ' order by v.created_at)
      into examples
      from (
        select p.id, p.user_id, p.name, p.created_at
          from public.projects p
         where not (
           jsonb_typeof(p.document) = 'object'
           and coalesce(jsonb_typeof(p.document -> 'version'), '') = 'number'
           and coalesce(jsonb_typeof(p.document -> 'objects'), '') = 'array'
           and coalesce(jsonb_typeof(p.document -> 'assemblies'), '') = 'array'
           and octet_length(p.document::text) <= 5000000
         )
         order by p.created_at
         limit 20
      ) v;
    raise exception 'projects_document_check was NOT changed: % stored project(s) break the document envelope. First up to 20: %', violating, examples
      using hint = 'Nothing was changed or deleted. Handle those rows as described in DEPLOYMENT.md (Rows that break the document envelope), then run this migration again.';
  end if;

  alter table public.projects drop constraint if exists projects_document_check;
  alter table public.projects add constraint projects_document_check check (
    jsonb_typeof(document) = 'object'
    and coalesce(jsonb_typeof(document -> 'version'), '') = 'number'
    and coalesce(jsonb_typeof(document -> 'objects'), '') = 'array'
    and coalesce(jsonb_typeof(document -> 'assemblies'), '') = 'array'
    and octet_length(document::text) <= 5000000
  );

  raise notice 'projects_document_check now refuses a document missing version, objects or assemblies.';
end
$migration$;
