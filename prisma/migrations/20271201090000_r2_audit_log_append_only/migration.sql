-- Batch R2.1: the audit log is append-only at the database level.
--
-- Before this migration nothing stopped an UPDATE of an audit entry, and a DELETE was only
-- constrained inside a retention transaction (AuditLog_retention_delete, Phase 19). Now:
--   * UPDATE is always refused. This includes the ON DELETE SET NULL of AuditLog_actorUserId_fkey,
--     so deleting a user who appears in the audit log is refused too (the application never
--     deletes users), which keeps the actor of every entry.
--   * DELETE is refused unless the transaction is a retention transaction
--     (hrms.retention_purge = 'on', set locally by RetentionService). There, the existing
--     AuditLog_retention_delete trigger still allows only organization entries older than the
--     organization's retention period (at least 24 months; retention is off unless configured).
--   * TRUNCATE is refused.
--   * INSERT is unaffected.
--
-- Limits: these are triggers. A database role that owns the table (or a superuser) can disable
-- them, and any session can set hrms.retention_purge (which still only allows the retention
-- deletes above). See docs/security/r2-security-hardening.md for the recommended role split.
--
-- Both audit-log trigger functions, and the three Phase 19 retention helpers they and the
-- retention trigger's WHEN clause rely on (hrms_retention_active, hrms_retention_months,
-- hrms_retention_cutoff), run with a fixed search_path: pg_catalog, public, pg_temp (the session's
-- temporary schema explicitly last). A session therefore cannot, through its own search_path,
-- substitute a look-alike hrms_retention_active() or current_setting(), nor shadow
-- "OrganizationSetting" with a temporary table of the same name. Pinning the helpers changes no
-- result: every object they use is in pg_catalog or public. For the other Phase 19 retention
-- triggers this pins their WHEN (hrms_retention_active()) too; their own bodies stay unpinned (see
-- the Limits in docs/security/r2-security-hardening.md). Note for later migrations: a
-- CREATE OR REPLACE FUNCTION of any of these functions drops this setting unless it repeats it
-- (the R2 database tests would then fail).
--
-- Every statement here is idempotent, whether or not the statements are applied in one
-- transaction: if the migration fails, mark it rolled back
-- (`prisma migrate resolve --rolled-back 20271201090000_r2_audit_log_append_only`) and deploy
-- again; anything that already ran is simply repeated. No existing row is changed.
--
-- Creating a trigger locks "AuditLog" briefly (SHARE ROW EXCLUSIVE). The lock timeout makes the
-- migration fail (and be retried as above) rather than queue every audit insert behind a long
-- transaction that holds a lock on the table.

SET lock_timeout = '10s';

CREATE OR REPLACE FUNCTION guard_audit_log_append_only() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'Audit log entries are append-only and cannot be truncated.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Audit log entries are append-only and cannot be changed.' USING ERRCODE = 'restrict_violation';
  END IF;
  -- DELETE: only a retention transaction may delete; AuditLog_retention_delete then checks age.
  IF NOT public.hrms_retention_active() THEN
    RAISE EXCEPTION 'Audit log entries are append-only; only the retention job may delete them.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$;

-- The Phase 19 retention check on AuditLog gets the same fixed search_path (no other change).
ALTER FUNCTION public.retention_delete_audit_log() SET search_path = pg_catalog, public, pg_temp;

-- The Phase 19 helpers: AuditLog_retention_delete's WHEN (hrms_retention_active()) is evaluated in
-- the deleting session, so the helper itself must not resolve current_setting() or "=" through
-- that session's search_path (otherwise the age check could be skipped while the guard above,
-- which pins its own path, still sees an active retention transaction).
ALTER FUNCTION public.hrms_retention_active() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.hrms_retention_months(uuid, text) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.hrms_retention_cutoff(uuid, text, integer) SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE TRIGGER "AuditLog_append_only" BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION guard_audit_log_append_only();

CREATE OR REPLACE TRIGGER "AuditLog_no_truncate" BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION guard_audit_log_append_only();

-- The lock timeout above is for this migration only; later migrations in the same deploy run
-- get the server default again.
RESET lock_timeout;
