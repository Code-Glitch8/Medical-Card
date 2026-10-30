-- READ-ONLY audit. Run in the Supabase SQL Editor before AND after the migration.
-- It changes nothing. It shows what the anonymous (not-logged-in) API role can reach.

-- 1. Every function in public that the anon role may EXECUTE.
--    EXPECTED: only public_lookup_patient_by_code (plus any harmless function you
--    intentionally made public). Any write RPC listed here (create_patient, save_patient,
--    admin_*, record_card_programmed, log_patient_access, open_patient_by_card, ...) is a
--    PRE-EXISTING exposure that should be fixed with: revoke execute on function ... from anon, public;
select p.oid::regprocedure as function_signature, p.prosecdef as security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prokind = 'f'
  and has_function_privilege('anon', p.oid, 'EXECUTE')
order by 1;

-- 2. Table privileges held by anon. Supabase normally grants these on public tables and relies on
--    RLS to block access, so rows for public.* are NOT by themselves a problem; what matters is
--    check 3 (RLS enabled) and check 4 (no policy lets anon read). EXPECTED for emr_internal: no rows.
select table_schema, table_name, privilege_type
from information_schema.role_table_grants
where grantee = 'anon' and table_schema in ('public','emr_internal')
order by 1,2,3;

-- 3. Row Level Security status of the patient tables.
select schemaname, tablename, rowsecurity
from pg_tables
where schemaname in ('public','emr_internal')
order by 1,2;

-- 3b. Any RLS policy that applies to anon or PUBLIC. EXPECTED: none on public.patients
--     (a policy 'to public' or 'to anon' with a permissive USING clause would expose patient rows).
select schemaname, tablename, policyname, roles, cmd, qual
from pg_policies
where schemaname in ('public','emr_internal')
  and (roles::text like '%anon%' or roles::text like '%public%');

-- 4. The type of patients.code16 (must be text so legacy zero-padded codes compare exactly).
select data_type from information_schema.columns
where table_schema='public' and table_name='patients' and column_name='code16';
