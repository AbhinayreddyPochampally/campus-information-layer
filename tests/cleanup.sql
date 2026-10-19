-- Remove all test data: everything created by the 259999xxx test accounts (including AI-drafted test tools,
-- whose names the AI chose), the cil-test-other org, and the test accounts themselves. Real data untouched.
-- Run in the Supabase dashboard SQL editor (the connector holds deletes for approval).
begin;
create temp table t_users on commit drop as
  select id from auth.users where email like 'cil.%.2599990%@iimmumbai.ac.in' or email = 'x@cil-test.invalid';
delete from public.tools where created_by in (select id from t_users) or slug like 'cil-test-%';  -- cascades versions, records, record_private
delete from public.audit_log where actor in (select id from t_users);
delete from public.refusals where actor in (select id from t_users) or actor is null;
delete from public.memberships where email like 'cil.%.2599990%@iimmumbai.ac.in';
delete from auth.users where id in (select id from t_users);                                     -- cascades profiles, identities
delete from public.organizations where slug = 'cil-test-other';                                  -- cascades its domain
select (select count(*) from public.tools) tools, (select count(*) from public.records) records,
       (select count(*) from auth.users) users, (select count(*) from public.memberships) memberships;
commit;
