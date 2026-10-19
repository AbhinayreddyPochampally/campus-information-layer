-- Step 4 (applied as 04a + 04b + 04c on 19 Oct 2026): security + sanity layer
-- 04b: tool versions are staff-only (students never needed them; records already filter to live versions)
alter policy "versions visible" on public.tool_versions
  using (private.tool_org(tool_id) = private.my_org() and private.is_staff());
-- 04a: staff-only table for check results/import source; health_checks + hourly private.run_sanity() via pg_cron
--      (see the live function with: select pg_get_functiondef('private.run_sanity'::regproc))
-- PENDING (needs approval in the Supabase connector — statement removes privileges):
-- revoke insert, update, delete, truncate, references, trigger on all tables in schema public from anon, authenticated;
-- alter default privileges in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon, authenticated;
-- revoke all on all tables in schema public from anon;
-- revoke select (checks, source) on public.tool_versions from authenticated;
