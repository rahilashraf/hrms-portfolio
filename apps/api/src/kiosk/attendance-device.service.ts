import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  Optional,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import {
  advisoryLock,
  domainError,
  jsonValue,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  featureGateFor,
  FeatureGateService,
} from '../features/feature-gate.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { AttendanceDevice } from '../generated/prisma/client.js';
import { canSeeOrganization } from '../time/organization-visibility.js';
import type { TimeRequestContext } from '../time/time.service.js';
import {
  ENROLLMENT_CODE_TTL_MS,
  enrollmentCode,
  normalizeEnrollmentCode,
  randomSecret,
  sha256,
} from './kiosk-secrets.js';

const PERMISSION = 'time.device.manage';

export function unauthorized(code: string, message: string) {
  return new UnauthorizedException({
    statusCode: 401,
    error: 'Unauthorized',
    code,
    message,
  });
}
const SEEN_THROTTLE_MS = 60_000;

/**
 * Phase 9.5 — trusted attendance devices (kiosks). An administrator with time.device.manage on
 * the organization registers a device at a physical site and gets a one-time enrollment code;
 * entering it at the physical device issues the device secret (an httpOnly cookie; only its hash
 * is stored). Rotating re-issues a code and invalidates the current secret; disabling suspends
 * the device; revoking is final. Only an ACTIVE device accepts attendance.
 */
@Injectable()
export class AttendanceDeviceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
    @Optional() features?: FeatureGateService,
  ) {
    this.features = featureGateFor(prisma, features);
  }

  /** Phase 18: kiosks work only while Time & attendance is enabled for their organization. */
  readonly features: FeatureGateService;

  async list(userId: string, organizationId: string) {
    await this.assertManage(userId, organizationId);
    const devices = await this.prisma.attendanceDevice.findMany({
      where: { organizationId },
      include: {
        physicalSite: {
          select: { id: true, name: true },
        },
      },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
    return { items: devices.map((device) => this.shape(device)) };
  }

  async register(
    userId: string,
    input: { organizationId: string; physicalSiteId: string; name: string },
    context: TimeRequestContext,
  ) {
    const name = input.name.trim();
    if (!name) throw new BadRequestException('name is required.');
    await this.assertManage(userId, input.organizationId);
    const code = enrollmentCode();
    const expiresAt = new Date(Date.now() + ENROLLMENT_CODE_TTL_MS);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Batch 5B: serialized with physical-site archive (same lock), then validated.
        await this.lockStructure(tx, input.organizationId);
        await this.assertUsableSite(
          tx,
          input.organizationId,
          input.physicalSiteId,
        );
        const device = await tx.attendanceDevice.create({
          data: {
            organizationId: input.organizationId,
            physicalSiteId: input.physicalSiteId,
            name,
            enrollmentCodeHash: sha256(normalizeEnrollmentCode(code)),
            enrollmentExpiresAt: expiresAt,
            createdByUserId: userId,
          },
          include: { physicalSite: true },
        });
        await this.writeAudit(
          tx,
          'ATTENDANCE_DEVICE_REGISTERED',
          device.id,
          context,
          {
            organizationId: device.organizationId,
            physicalSiteId: device.physicalSiteId,
            name: device.name,
          },
        );
        return {
          device: this.shape(device),
          enrollment: { code, expiresAt: expiresAt.toISOString() },
        };
      });
    } catch (error) {
      throw this.uniqueName(error);
    }
  }

  async update(
    userId: string,
    deviceId: string,
    input: { name?: string; physicalSiteId?: string },
    context: TimeRequestContext,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const device = await this.locked(tx, userId, deviceId, {
          structure: input.physicalSiteId !== undefined,
        });
        this.assertNotRevoked(device);
        const data: Prisma.AttendanceDeviceUncheckedUpdateInput = {};
        if (input.name !== undefined) {
          if (!input.name.trim())
            throw new BadRequestException('name is required.');
          data.name = input.name.trim();
        }
        if (
          input.physicalSiteId !== undefined &&
          input.physicalSiteId !== device.physicalSiteId
        ) {
          await this.assertUsableSite(
            tx,
            device.organizationId,
            input.physicalSiteId,
          );
          data.physicalSiteId = input.physicalSiteId;
        }
        const updated = await tx.attendanceDevice.update({
          where: { id: device.id },
          data,
          include: { physicalSite: true },
        });
        await this.writeAudit(
          tx,
          'ATTENDANCE_DEVICE_UPDATED',
          device.id,
          context,
          {
            before: {
              name: device.name,
              physicalSiteId: device.physicalSiteId,
            },
            after: {
              name: updated.name,
              physicalSiteId: updated.physicalSiteId,
            },
          },
        );
        return this.shape(updated);
      });
    } catch (error) {
      throw this.uniqueName(error);
    }
  }

  /** A new one-time enrollment code; the current secret stops working until re-enrolled. */
  async rotate(userId: string, deviceId: string, context: TimeRequestContext) {
    return this.prisma.$transaction(async (tx) => {
      const device = await this.locked(tx, userId, deviceId);
      this.assertNotRevoked(device);
      const code = enrollmentCode();
      const expiresAt = new Date(Date.now() + ENROLLMENT_CODE_TTL_MS);
      const updated = await tx.attendanceDevice.update({
        where: { id: device.id },
        data: {
          credentialHash: null,
          credentialIssuedAt: null,
          enrollmentCodeHash: sha256(normalizeEnrollmentCode(code)),
          enrollmentExpiresAt: expiresAt,
        },
        include: { physicalSite: true },
      });
      await this.writeAudit(
        tx,
        'ATTENDANCE_DEVICE_ROTATED',
        device.id,
        context,
        {
          hadCredential: device.credentialHash !== null,
        },
      );
      return {
        device: this.shape(updated),
        enrollment: { code, expiresAt: expiresAt.toISOString() },
      };
    });
  }

  async setEnabled(
    userId: string,
    deviceId: string,
    enabled: boolean,
    context: TimeRequestContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const device = await this.locked(tx, userId, deviceId, {
        structure: enabled,
      });
      this.assertNotRevoked(device);
      const status = enabled ? 'ACTIVE' : 'DISABLED';
      // Batch 5B: a device is never re-enabled on an archived (or foreign) physical site.
      if (enabled && device.status !== 'ACTIVE')
        await this.assertUsableSite(
          tx,
          device.organizationId,
          device.physicalSiteId,
        );
      if (device.status === status) {
        return this.shape({
          ...device,
          physicalSite: await this.siteOf(tx, device),
        });
      }
      const updated = await tx.attendanceDevice.update({
        where: { id: device.id },
        data: { status },
        include: { physicalSite: true },
      });
      await this.writeAudit(
        tx,
        enabled ? 'ATTENDANCE_DEVICE_ENABLED' : 'ATTENDANCE_DEVICE_DISABLED',
        device.id,
        context,
        {},
      );
      return this.shape(updated);
    });
  }

  /** Permanent: the device can never record attendance again and holds no secret. */
  async revoke(
    userId: string,
    deviceId: string,
    reason: string,
    context: TimeRequestContext,
  ) {
    const trimmed = reason.trim();
    if (!trimmed) throw new BadRequestException('reason is required.');
    return this.prisma.$transaction(async (tx) => {
      const device = await this.locked(tx, userId, deviceId);
      if (device.status === 'REVOKED') {
        return this.shape({
          ...device,
          physicalSite: await this.siteOf(tx, device),
        });
      }
      const updated = await tx.attendanceDevice.update({
        where: { id: device.id },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
          revokedByUserId: userId,
          revokedReason: trimmed,
          credentialHash: null,
          credentialIssuedAt: null,
          enrollmentCodeHash: null,
          enrollmentExpiresAt: null,
        },
        include: { physicalSite: true },
      });
      await this.writeAudit(
        tx,
        'ATTENDANCE_DEVICE_REVOKED',
        device.id,
        context,
        { reason: trimmed },
      );
      return this.shape(updated);
    });
  }

  /**
   * Enrollment at the physical device: exchanges a valid one-time code for the device secret.
   * The caller sets the secret as the kiosk cookie; it is never stored or shown again.
   */
  async enroll(code: string, context: TimeRequestContext) {
    const normalized = normalizeEnrollmentCode(code);
    return this.prisma.$transaction(async (tx) => {
      const device = await tx.attendanceDevice.findUnique({
        where: { enrollmentCodeHash: sha256(normalized) },
      });
      // Batch 4B: only an ACTIVE device enrolls. A disabled one is re-enabled first (its code
      // stays valid until it expires), so disabling a kiosk can't be undone at the device.
      if (
        !device ||
        device.status !== 'ACTIVE' ||
        !device.enrollmentExpiresAt ||
        device.enrollmentExpiresAt.getTime() < Date.now()
      ) {
        throw unauthorized(
          'KIOSK_ENROLLMENT_INVALID',
          'The enrollment code is invalid or has expired.',
        );
      }
      const secret = randomSecret();
      const now = new Date();
      // Compare-and-swap on the code hash: a code is consumed exactly once.
      const consumed = await tx.attendanceDevice.updateMany({
        where: {
          id: device.id,
          status: 'ACTIVE',
          enrollmentCodeHash: device.enrollmentCodeHash,
        },
        data: {
          credentialHash: sha256(secret),
          credentialIssuedAt: now,
          enrollmentCodeHash: null,
          enrollmentExpiresAt: null,
          lastSeenAt: now,
          lastSeenIp: context.ipAddress ?? null,
          lastSeenUserAgent: context.userAgent?.slice(0, 500) ?? null,
        },
      });
      if (consumed.count !== 1) {
        throw unauthorized(
          'KIOSK_ENROLLMENT_INVALID',
          'The enrollment code is invalid or has expired.',
        );
      }
      await this.features.require(device.organizationId, 'ATTENDANCE', tx);
      await this.writeAudit(
        tx,
        'ATTENDANCE_DEVICE_ENROLLED',
        device.id,
        context,
        {},
      );
      return { secret, deviceId: device.id };
    });
  }

  /**
   * The device behind a kiosk secret. Unknown secrets (never issued, rotated or revoked) are
   * unauthenticated; a known but disabled device is reported as inactive. Records last-seen
   * (throttled to once a minute).
   */
  async authenticate(secret: string | undefined, context: TimeRequestContext) {
    if (!secret) throw this.unauthenticated();
    const device = await this.prisma.attendanceDevice.findUnique({
      where: { credentialHash: sha256(secret) },
      include: {
        physicalSite: { select: { id: true, name: true } },
        organization: { select: { id: true, name: true, timezone: true } },
      },
    });
    if (!device || device.status === 'REVOKED') throw this.unauthenticated();
    if (device.status !== 'ACTIVE') {
      throw new ForbiddenException(
        domainError(403, 'KIOSK_DEVICE_INACTIVE', 'This kiosk is not active.'),
      );
    }
    // Phase 18: every kiosk route authenticates here.
    await this.features.require(device.organizationId, 'ATTENDANCE');
    if (
      !device.lastSeenAt ||
      Date.now() - device.lastSeenAt.getTime() > SEEN_THROTTLE_MS
    ) {
      await this.prisma.attendanceDevice.updateMany({
        where: { id: device.id, status: 'ACTIVE' },
        data: {
          lastSeenAt: new Date(),
          lastSeenIp: context.ipAddress ?? null,
          lastSeenUserAgent: context.userAgent?.slice(0, 500) ?? null,
        },
      });
    }
    return device;
  }

  shape(
    device: AttendanceDevice & {
      physicalSite?: {
        id: string;
        name: string;
      } | null;
    },
  ) {
    return {
      id: device.id,
      organizationId: device.organizationId,
      physicalSite: device.physicalSite
        ? {
            id: device.physicalSite.id,
            name: device.physicalSite.name,
          }
        : { id: device.physicalSiteId, name: null },
      name: device.name,
      status: device.status,
      enrolled: device.credentialHash !== null,
      credentialIssuedAt: device.credentialIssuedAt?.toISOString() ?? null,
      enrollmentPending:
        device.enrollmentExpiresAt !== null &&
        device.enrollmentExpiresAt.getTime() > Date.now(),
      enrollmentExpiresAt: device.enrollmentExpiresAt?.toISOString() ?? null,
      lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      lastSeenIp: device.lastSeenIp,
      revokedAt: device.revokedAt?.toISOString() ?? null,
      revokedReason: device.revokedReason,
      createdAt: device.createdAt.toISOString(),
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private unauthenticated() {
    return unauthorized(
      'KIOSK_DEVICE_UNAUTHENTICATED',
      'This device is not an enrolled kiosk.',
    );
  }

  private async assertManage(
    userId: string,
    organizationId: string,
    client?: Prisma.TransactionClient,
  ) {
    if (
      !(await this.authorization.canAccess(
        userId,
        PERMISSION,
        { type: 'ORGANIZATION', id: organizationId },
        client ?? this.prisma,
      ))
    ) {
      throw new ForbiddenException(
        'Missing permission time.device.manage for the organization.',
      );
    }
    await this.features.require(
      organizationId,
      'ATTENDANCE',
      client ?? this.prisma,
    );
  }

  private async locked(
    tx: Prisma.TransactionClient,
    userId: string,
    deviceId: string,
    options: { structure?: boolean } = {},
  ) {
    // Batch 4F: authorize before taking the row lock (D9), and answer a device of an
    // organization the caller cannot see at all exactly like a missing one (D4). A device
    // never moves between organizations, so the unlocked read is safe to authorize on.
    const unlocked = await tx.attendanceDevice.findUnique({
      where: { id: deviceId },
      select: { organizationId: true },
    });
    if (
      !unlocked ||
      !(await canSeeOrganization(
        this.authorization,
        userId,
        [unlocked.organizationId],
        [PERMISSION],
        tx,
      ))
    ) {
      throw new NotFoundException('Attendance device not found.');
    }
    await this.assertManage(userId, unlocked.organizationId, tx);
    // Batch 5B: a change that puts an active device on a site takes the organization's
    // structure lock first (the one physical-site archive takes), then the device row.
    if (options.structure)
      await this.lockStructure(tx, unlocked.organizationId);
    await tx.$queryRaw`SELECT "id" FROM "AttendanceDevice" WHERE "id" = ${deviceId}::uuid FOR UPDATE`;
    const device = await tx.attendanceDevice.findUnique({
      where: { id: deviceId },
    });
    if (!device) throw new NotFoundException('Attendance device not found.');
    return device;
  }

  private assertNotRevoked(device: AttendanceDevice) {
    if (device.status === 'REVOKED') {
      throw new ConflictException(
        domainError(
          409,
          'KIOSK_DEVICE_REVOKED',
          'A revoked device cannot be changed.',
        ),
      );
    }
  }

  private lockStructure(tx: Prisma.TransactionClient, organizationId: string) {
    return advisoryLock(tx, `organization-structure:${organizationId}`);
  }

  private async assertUsableSite(
    tx: Prisma.TransactionClient,
    organizationId: string,
    physicalSiteId: string,
  ) {
    const site = await tx.physicalSite.findUnique({
      where: { id: physicalSiteId },
    });
    if (!site || site.organizationId !== organizationId) {
      throw new NotFoundException(
        'Physical site not found in the organization.',
      );
    }
    if (site.archivedAt) {
      throw new ConflictException(
        domainError(
          409,
          'KIOSK_LOCATION_UNUSABLE',
          'A kiosk needs an active physical site.',
        ),
      );
    }
  }

  private siteOf(tx: Prisma.TransactionClient, device: AttendanceDevice) {
    return tx.physicalSite.findUnique({ where: { id: device.physicalSiteId } });
  }

  private uniqueName(error: unknown) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new ConflictException(
        domainError(
          409,
          'KIOSK_DEVICE_NAME_TAKEN',
          'Another kiosk of the organization has this name.',
        ),
      );
    }
    return error;
  }

  private writeAudit(
    client: Prisma.TransactionClient,
    action: string,
    entityId: string,
    context: TimeRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.write(
      {
        action,
        actorUserId: context.actorUserId,
        entityType: 'AttendanceDevice',
        entityId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: jsonValue(metadata),
      },
      client,
    );
  }
}
