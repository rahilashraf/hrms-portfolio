-- Attendance device immutability now validates the device's PhysicalSite instead of WorkLocation.
-- Timezone remains resolved at capture time from the assignment WorkLocation/Organization.

CREATE OR REPLACE FUNCTION "guard_attendance_device"() RETURNS trigger AS $$
DECLARE
  site RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Attendance devices are never deleted; revoke them.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'REVOKED' THEN
    RAISE EXCEPTION 'A revoked attendance device is final.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."physicalSiteId" IS DISTINCT FROM OLD."physicalSiteId" THEN
    SELECT "archivedAt" INTO site FROM "PhysicalSite" WHERE "id" = NEW."physicalSiteId";
    IF site."archivedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'An attendance device needs an active physical site.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
