-- Remove all test data created on 19 Oct 2026 (cil-test-* tools, test org, 259999xxx accounts). Real data untouched.
begin;
delete from public.tools where slug like 'cil-test-%';                       -- cascades versions, records, record_private
delete from public.audit_log where actor in (select id from auth.users where email like 'cil.%.2599990%@iimmumbai.ac.in' or email = 'x@cil-test.invalid');
delete from public.refusals where actor in (select id from auth.users where email like 'cil.%.2599990%@iimmumbai.ac.in' or email = 'x@cil-test.invalid') or actor is null;
delete from public.memberships where email like 'cil.%.2599990%@iimmumbai.ac.in';
delete from auth.users where email like 'cil.%.2599990%@iimmumbai.ac.in' or email = 'x@cil-test.invalid';  -- cascades profiles, identities
delete from public.organizations where slug = 'cil-test-other';             -- cascades its domain
select (select count(*) from public.tools) tools, (select count(*) from auth.users) users, (select count(*) from public.memberships) memberships;
commit;
