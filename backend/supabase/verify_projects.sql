-- Read-only checks to run in the Supabase SQL editor AFTER the migrations
-- (every file in supabase/migrations/, in filename order). Changes nothing.
-- In check 4, projects_document_check should use coalesce(...) on each key -
-- that is the 20260911000000 fix.
-- Expected results are in DEPLOYMENT.md "Verify the database".

-- 1. The table exists and Row Level Security is ON (rls_enabled = true).
select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'projects';

-- 2. Columns (object_count and assembly_count are generated).
select column_name, data_type, is_nullable, column_default, is_generated
from information_schema.columns
where table_schema = 'public' and table_name = 'projects'
order by ordinal_position;

-- 3. The four ownership policies - all for "authenticated", all on auth.uid() = user_id.
select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'projects'
order by policyname;

-- 4. Constraints: primary key, the auth.users foreign key, the name and document checks.
select conname, pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.projects'::regclass
order by conname;

-- 5. The timestamp/owner trigger.
select tgname
from pg_trigger
where tgrelid = 'public.projects'::regclass and not tgisinternal;

-- 6. Grants: authenticated has SELECT/INSERT/UPDATE/DELETE; anon has nothing.
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and table_name = 'projects' and grantee in ('anon', 'authenticated')
order by grantee, privilege_type;

-- 7. Stored projects that break the document envelope - should return NO rows.
--    (The SQL editor runs as the postgres role, so this sees every user's rows.)
select id, user_id, name, created_at,
       jsonb_typeof(document) as document_type,
       jsonb_typeof(document -> 'version') as version_type,
       jsonb_typeof(document -> 'objects') as objects_type,
       jsonb_typeof(document -> 'assemblies') as assemblies_type
from public.projects
where not (
  jsonb_typeof(document) = 'object'
  and coalesce(jsonb_typeof(document -> 'version'), '') = 'number'
  and coalesce(jsonb_typeof(document -> 'objects'), '') = 'array'
  and coalesce(jsonb_typeof(document -> 'assemblies'), '') = 'array'
)
order by created_at;

-- 8. Is the tightened constraint (20260911000000) live? Expect tightened = true.
select conname, position('COALESCE' in upper(pg_get_constraintdef(oid))) > 0 as tightened
from pg_constraint
where conrelid = 'public.projects'::regclass and conname = 'projects_document_check';
