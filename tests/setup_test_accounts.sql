-- Run with psql -v test_pw=... (never commit the password). Adds 259999xxx test accounts incl. an office account; tests/cleanup.sql removes them.
with o as (insert into public.organizations(slug,name,member_id_pattern,roles,staff_roles,default_role)
  values ('cil-test-other','CIL test org (temporary)',null,'{admin,student}','{admin}','student') returning id)
insert into public.org_domains(domain, org_id) select 'cil-test.invalid', id from o;
insert into public.memberships(org_id,email,role) select id, e, r from public.organizations,
  (values ('cil.admin.259999000@iimmumbai.ac.in','admin'),('cil.invig.259999003@iimmumbai.ac.in','invigilator'),('cil.office.259999004@iimmumbai.ac.in','office')) v(e,r)
  where slug='iim-mumbai';
insert into auth.users (instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at,confirmation_token,recovery_token,email_change_token_new,email_change)
select '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated','authenticated', e, extensions.crypt(:'test_pw', extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''
from unnest(array['cil.admin.259999000@iimmumbai.ac.in','cil.alpha.259999001@iimmumbai.ac.in','cil.beta.259999002@iimmumbai.ac.in','cil.invig.259999003@iimmumbai.ac.in','cil.office.259999004@iimmumbai.ac.in','x@cil-test.invalid']) e;
insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select gen_random_uuid(), u.id, u.id::text, jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true), 'email', now(), now(), now()
from auth.users u where u.email like 'cil.%.2599990%@iimmumbai.ac.in' or u.email = 'x@cil-test.invalid';
select u.email, p.member_id, p.org_id is not null as has_org from auth.users u left join public.profiles p on p.id = u.id order by email;

