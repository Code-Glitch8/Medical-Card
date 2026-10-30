-- =====================================================================
--  Emergency Medical Card — public, read-only profile lookup by 10-digit code
--  Additive and re-runnable. Does NOT alter public.patients, any existing
--  function, any RLS policy, any grant on existing objects.
--
--  Creates:
--    schema   emr_internal                      (private: not exposed through the API)
--    table    emr_internal.lookup_salt          (random salt used to hash caller IPs)
--    table    emr_internal.lookup_attempts      (rate-limit ledger; NEVER stores the code)
--    function public.public_lookup_patient_by_code(p_code text) -> jsonb
--
--  Run in: Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
--  Rollback: see the commented block at the bottom of this file.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Pre-flight: fail loudly (before changing anything) if the deployed
--    public.patients table does not have the columns this function reads.
--    The attached prompt describes the schema; the deployed one is the truth.
-- ---------------------------------------------------------------------
do $$
declare
  v_missing text;
begin
  if to_regclass('public.patients') is null then
    raise exception 'public.patients does not exist - aborting. Check the deployed schema.';
  end if;

  select string_agg(c, ', ' order by c) into v_missing
  from unnest(array[
    'code16','name','preferred','dob','sex','blood_group','blood_status','blood_date','blood_source',
    'emergency_name','emergency_phone','important_notes','allergy_status','allergies','conditions',
    'medications','records','vaccinations','contacts','updated_at'
  ]) as c
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'patients' and column_name = c
  );

  if v_missing is not null then
    raise exception 'public.patients is missing expected column(s): %. Adjust the function before running.', v_missing;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1. Private schema + rate-limit ledger (unreachable from the Data API)
-- ---------------------------------------------------------------------
create schema if not exists emr_internal;
revoke all on schema emr_internal from public, anon, authenticated;

create table if not exists emr_internal.lookup_salt (
  id   boolean primary key default true check (id),      -- exactly one row
  salt text    not null default gen_random_uuid()::text
);
insert into emr_internal.lookup_salt (id) values (true) on conflict (id) do nothing;

create table if not exists emr_internal.lookup_attempts (
  id           bigint generated always as identity primary key,
  attempted_at timestamptz not null default now(),
  ip_hash      text        not null,                      -- salted SHA-256 of the caller IP; never the IP itself
  outcome      text        not null check (outcome in ('found','not_found','invalid'))
);
create index if not exists lookup_attempts_ip_time_idx on emr_internal.lookup_attempts (ip_hash, attempted_at desc);
create index if not exists lookup_attempts_time_idx    on emr_internal.lookup_attempts (attempted_at desc);

alter table emr_internal.lookup_salt     enable row level security;   -- no policies = no access for API roles
alter table emr_internal.lookup_attempts enable row level security;
revoke all on table emr_internal.lookup_salt, emr_internal.lookup_attempts from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. The lookup function
--
--  * Takes ONLY a 10-digit code. There is no UUID / id / wildcard parameter.
--  * SECURITY DEFINER (runs as the function owner, which bypasses RLS on
--    public.patients) but returns a fixed whitelist of fields for one row.
--  * search_path is empty, every object is schema-qualified.
--  * It writes only to emr_internal.lookup_attempts. It never touches
--    public.patients, patient_access_grants, audit logs, last_access, or any
--    other record state.
--  * Failures are RETURNED as data ({"status": ...}), not raised. A raised
--    exception would roll the transaction back and erase the attempt that the
--    rate limiter has to remember.
--
--  Fields deliberately NOT returned (internal / administrative metadata):
--    id, code16, version, created_by_hospital_id, created_by_hospital_name,
--    created_at, last_modified_hospital_id, last_modified_hospital_name,
--    last_modified_at, last_access, prev_access, card_programmed_at,
--    card_programmed_by, timeline.
--  (timeline is withheld because the existing app never renders it and its
--   contents are not defined; add it to the object below if you confirm it
--   holds only patient-appropriate information.)
--
--  Tunable limits (edit the constants and re-run this file):
--    per caller IP : 8 failed lookups OR 40 lookups in any 15 minutes
--    whole service : 150 failed lookups in any 10 minutes
-- ---------------------------------------------------------------------
create or replace function public.public_lookup_patient_by_code(p_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  c_ip_window        constant interval := interval '15 minutes';
  c_global_window    constant interval := interval '10 minutes';
  c_ip_fail_max      constant integer  := 8;
  c_ip_total_max     constant integer  := 40;
  c_global_fail_max  constant integer  := 150;

  v_code      text;
  v_hdr       jsonb;
  v_ip        text;
  v_parts     text[];
  v_salt      text;
  v_hash      text;
  v_ip_fail   integer;
  v_ip_total  integer;
  v_glob_fail integer;
  v_oldest    timestamptz;
  v_retry     integer;
  v_row       record;
begin
  -- Ask PostgREST not to let browsers or proxies cache this response.
  perform pg_catalog.set_config(
    'response.headers',
    '[{"Cache-Control":"no-store, max-age=0"},{"Pragma":"no-cache"}]',
    true);

  -- Who is calling? Cloudflare's header is set by the edge and cannot be forged by the client;
  -- otherwise use the LAST x-forwarded-for entry (appended by the nearest trusted proxy).
  begin
    v_hdr := nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb;
  exception when invalid_text_representation then
    v_hdr := null;
  end;

  v_ip := nullif(pg_catalog.btrim(coalesce(v_hdr ->> 'cf-connecting-ip', '')), '');
  if v_ip is null and v_hdr ? 'x-forwarded-for' then
    v_parts := pg_catalog.string_to_array(v_hdr ->> 'x-forwarded-for', ',');
    v_ip := nullif(pg_catalog.btrim(v_parts[pg_catalog.cardinality(v_parts)]), '');
  end if;
  v_ip := pg_catalog.left(coalesce(v_ip, 'unknown'), 64);

  select s.salt into v_salt from emr_internal.lookup_salt s limit 1;
  v_hash := pg_catalog.encode(
              pg_catalog.sha256(pg_catalog.convert_to(coalesce(v_salt, '') || '|' || v_ip, 'UTF8')),
              'hex');

  -- Rate limit BEFORE touching patient data.
  select pg_catalog.count(*) filter (where a.outcome <> 'found'),
         pg_catalog.count(*),
         pg_catalog.min(a.attempted_at)
    into v_ip_fail, v_ip_total, v_oldest
    from emr_internal.lookup_attempts a
   where a.ip_hash = v_hash
     and a.attempted_at > pg_catalog.now() - c_ip_window;

  if v_ip_fail >= c_ip_fail_max or v_ip_total >= c_ip_total_max then
    v_retry := greatest(1, pg_catalog.ceil(extract(epoch from (v_oldest + c_ip_window - pg_catalog.now())))::integer);
    return pg_catalog.jsonb_build_object('status', 'rate_limited', 'retry_after_seconds', v_retry);
  end if;

  select pg_catalog.count(*), pg_catalog.min(a.attempted_at)
    into v_glob_fail, v_oldest
    from emr_internal.lookup_attempts a
   where a.outcome <> 'found'
     and a.attempted_at > pg_catalog.now() - c_global_window;

  if v_glob_fail >= c_global_fail_max then
    v_retry := greatest(1, pg_catalog.ceil(extract(epoch from (v_oldest + c_global_window - pg_catalog.now())))::integer);
    return pg_catalog.jsonb_build_object('status', 'rate_limited', 'retry_after_seconds', v_retry);
  end if;

  -- Opportunistic housekeeping (keeps the ledger small).
  if pg_catalog.random() < 0.02 then
    delete from emr_internal.lookup_attempts where attempted_at < pg_catalog.now() - interval '2 days';
  end if;

  -- Validate: exactly ten ASCII digits.
  v_code := pg_catalog.btrim(coalesce(p_code, ''));
  if v_code !~ '^[0-9]{10}$' then
    insert into emr_internal.lookup_attempts (ip_hash, outcome) values (v_hash, 'invalid');
    return pg_catalog.jsonb_build_object('status', 'invalid');
  end if;

  select p.name, p.preferred, p.dob, p.sex,
         p.blood_group, p.blood_status, p.blood_date, p.blood_source,
         p.emergency_name, p.emergency_phone, p.important_notes, p.allergy_status,
         p.allergies, p.conditions, p.medications, p.records, p.vaccinations, p.contacts,
         p.updated_at
    into v_row
    from public.patients p
   where p.code16::text = v_code
   limit 1;

  if not found then
    insert into emr_internal.lookup_attempts (ip_hash, outcome) values (v_hash, 'not_found');
    return pg_catalog.jsonb_build_object('status', 'not_found');
  end if;

  insert into emr_internal.lookup_attempts (ip_hash, outcome) values (v_hash, 'found');

  return pg_catalog.jsonb_build_object(
    'status', 'ok',
    'patient', pg_catalog.jsonb_build_object(
      'name',            v_row.name,
      'preferred',       v_row.preferred,
      'dob',             v_row.dob,
      'sex',             v_row.sex,
      'blood_group',     v_row.blood_group,
      'blood_status',    v_row.blood_status,
      'blood_date',      v_row.blood_date,
      'blood_source',    v_row.blood_source,
      'emergency_name',  v_row.emergency_name,
      'emergency_phone', v_row.emergency_phone,
      'important_notes', v_row.important_notes,
      'allergy_status',  v_row.allergy_status,
      'allergies',       coalesce(v_row.allergies,    '[]'::jsonb),
      'conditions',      coalesce(v_row.conditions,   '[]'::jsonb),
      'medications',     coalesce(v_row.medications,  '[]'::jsonb),
      'records',         coalesce(v_row.records,      '[]'::jsonb),
      'vaccinations',    coalesce(v_row.vaccinations, '[]'::jsonb),
      'contacts',        coalesce(v_row.contacts,     '[]'::jsonb),
      'updated_at',      v_row.updated_at
    )
  );
end;
$fn$;

comment on function public.public_lookup_patient_by_code(text) is
  'Public read-only profile lookup by 10-digit code. Whitelisted fields only; rate limited per caller and globally; writes only to emr_internal.lookup_attempts.';

-- ---------------------------------------------------------------------
-- 3. Permissions. Supabase grants EXECUTE on new public functions to anon,
--    authenticated and service_role by default, so revoking from PUBLIC alone
--    is not enough: revoke everything, then grant back exactly what is needed.
--    (authenticated is included only so a hospital user whose browser still holds
--    a session can use the public form; it receives the same whitelisted output.)
-- ---------------------------------------------------------------------
revoke all     on function public.public_lookup_patient_by_code(text) from public, anon, authenticated;
grant  execute on function public.public_lookup_patient_by_code(text) to anon, authenticated;

-- =====================================================================
--  ROLLBACK (run only if you want to remove the feature; no patient data is touched)
-- =====================================================================
--  drop function if exists public.public_lookup_patient_by_code(text);
--  drop table    if exists emr_internal.lookup_attempts;
--  drop table    if exists emr_internal.lookup_salt;
--  drop schema   if exists emr_internal;
