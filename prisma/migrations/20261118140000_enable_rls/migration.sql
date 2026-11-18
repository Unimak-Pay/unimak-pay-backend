-- Supabase exposes the public schema through its Data API (anon/authenticated
-- keys). Spec: Row Level Security on, no policies — only the backend (table
-- owner, which bypasses RLS) touches the data.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tablename);
  END LOOP;
END $$;

-- Tables created by later migrations get RLS automatically.
CREATE OR REPLACE FUNCTION public.enable_rls_on_new_tables() RETURNS event_trigger
LANGUAGE plpgsql AS $$
DECLARE obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_ddl_commands() WHERE command_tag = 'CREATE TABLE' AND schema_name = 'public' LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
  END LOOP;
END $$;

-- Event triggers need elevated rights; if the role can't create one, new tables
-- must enable RLS in their own migration (the loop above covers existing ones).
DO $$
BEGIN
  DROP EVENT TRIGGER IF EXISTS enable_rls_on_new_tables;
  CREATE EVENT TRIGGER enable_rls_on_new_tables ON ddl_command_end
    WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.enable_rls_on_new_tables();
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'Could not create event trigger enable_rls_on_new_tables (%); enable RLS in future migrations explicitly', SQLERRM;
END $$;
