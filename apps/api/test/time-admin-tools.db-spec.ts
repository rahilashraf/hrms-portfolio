import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { TimeDomainService } from '../src/time/time-domain.service.js';
import {
  createSchedulingFixtures,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';
import {
  FixedClock,
  seedTimePolicy,
  TIME_PERMISSIONS,
  timeServices,
  toronto,
} from './support/time-fixtures.js';
import { withTimeHttp, type TimeHttp } from './support/time-http.js';
import { addOrganizationBAssignment } from './support/time-world.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const ADMIN = [...TIME_PERMISSIONS, 'time.manage_policy'];

const USERS = {
  self1: [
    { permissions: ['time.clock'], scope: 'org' as const },
    { permissions: ['time.clock'], scope: 'orgB' as const },
  ],
  adminA: [{ permissions: ADMIN, scope: 'org' as const }],
  adminAB: [
    { permissions: ADMIN, scope: 'org' as const },
    { permissions: ADMIN, scope: 'orgB' as const },
  ],
  adminB: [{ permissions: ADMIN, scope: 'orgB' as const }],
  /** Team A only: views attendance. */
  teamViewer: [{ permissions: ['time.view'], scope: 'teamA' as const }],
  /** Manages Team A's policy layers only. */
  teamPolicyAdmin: [
    { permissions: ['time.manage_policy'], scope: 'teamA' as const },
  ],
  outsider: [{ permissions: ['schedule.read'], scope: 'org' as const }],
};

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  http: TimeHttp;
  orgBAssignment: string;
}

const layer = (
  tx: Tx,
  data: Record<string, unknown>,
  configValue: Record<string, unknown>,
  from = '2026-01-01',
  to: string | null = null,
) =>
  tx.timeAttendancePolicy.create({
    data: {
      effectiveFrom: new Date(`${from}T00:00:00.000Z`),
      effectiveTo: to ? new Date(`${to}T00:00:00.000Z`) : null,
      config: configValue as object,
      ...data,
    } as never,
  });

/**
 * Batch 4E-2 — attendance administration contracts (B1–B4) over HTTP against the real database:
 * the effective policy explained (by the runtime's own resolution), scope names on policy layers,
 * effective-dated replacement, and the cross-organization assignment attendance lookup, each
 * within the caller's organizations and positions.
 */
describe(
  'Attendance admin tools (Batch 4E-2, database, HTTP)',
  { timeout: 120_000 },
  () => {
    let prisma: PrismaService;

    beforeAll(async () => {
      prisma = new PrismaService(process.env.DATABASE_URL!);
      await prisma.$connect();
    });

    afterAll(async () => {
      await prisma?.$disconnect();
    });

    async function scenario(run: (h: Harness) => Promise<void>) {
      await expect(
        prisma.$transaction(
          async (tx) => {
            const fx = await createSchedulingFixtures(tx, USERS, ADMIN);
            await tx.organization.update({
              where: { id: fx.orgA },
              data: { timezone: 'America/Toronto', name: `Org A ${fx.suffix}` },
            });
            const orgB = await addOrganizationBAssignment(tx, fx);
            const clock = new FixedClock();
            await withTimeHttp(tx, clock, (http) =>
              run({ tx, fx, clock, http, orgBAssignment: orgB.assignmentId }),
            ).catch((error: unknown) => {
              console.error('SCENARIO FAILURE', error);
              throw error;
            });
            throw new RollbackFixtures();
          },
          { timeout: 110_000 },
        ),
      ).rejects.toBeInstanceOf(RollbackFixtures);
    }

    /** Organization → root unit → child unit → Dept A → Team A (OVERRIDE) → assignment. */
    async function chainForTeamA(h: Harness) {
      const { tx, fx } = h;
      const org = await seedTimePolicy(tx, fx.orgA, {
        clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
        breaks: {
          mode: 'AUTO_DEDUCT',
          autoDeductMinutes: 30,
          autoDeductAfterMinutes: 360,
        },
        missedPunch: { enabled: true, maxOpenDurationMinutes: 600 },
      });
      const root = await layer(
        tx,
        {
          scopeType: 'ORGANIZATIONAL_UNIT',
          organizationId: fx.orgA,
          organizationalUnitId: fx.unitRoot,
        },
        {
          attendanceInterpretation: {
            lateArrivalEnabled: true,
            lateGraceMinutes: 5,
          },
        },
      );
      const child = await layer(
        tx,
        {
          scopeType: 'ORGANIZATIONAL_UNIT',
          organizationId: fx.orgA,
          organizationalUnitId: fx.unitChild,
        },
        { attendanceInterpretation: { lateGraceMinutes: 10 } },
      );
      const dept = await layer(
        tx,
        {
          scopeType: 'DEPARTMENT',
          organizationId: fx.orgA,
          departmentId: fx.deptA,
        },
        { correction: { employeeRequestsEnabled: true } },
      );
      const team = await layer(
        tx,
        {
          scopeType: 'TEAM',
          organizationId: fx.orgA,
          teamId: fx.teamA,
          inheritanceMode: 'OVERRIDE',
        },
        {
          clock: { mode: 'LIVE_CLOCK' },
          attendanceInterpretation: { lateArrivalEnabled: true },
        },
      );
      const assignment = await layer(
        tx,
        {
          scopeType: 'EMPLOYMENT_ASSIGNMENT',
          employmentAssignmentId: fx.assignmentTeamA,
        },
        { attendance: { captureMode: 'KIOSK_ONLY', signOutEnabled: true } },
      );
      // A later assignment layer (not in effect on the dates asked below).
      await layer(
        tx,
        {
          scopeType: 'EMPLOYMENT_ASSIGNMENT',
          employmentAssignmentId: fx.assignmentDeptB,
        },
        { attendance: { trackingMode: 'SIGN_IN_ONLY' } },
        '2028-01-01',
      );
      return { org, root, child, dept, team, assignment };
    }

    it('explains an assignment’s effective policy exactly as the attendance runtime resolves it', async () => {
      await scenario(async (h) => {
        const { fx, http, tx, clock } = h;
        const layers = await chainForTeamA(h);
        const admin = await http.as(fx.users.adminA!);
        const response = await admin
          .get(
            `/time/policies/effective?employmentAssignmentId=${fx.assignmentTeamA}&date=2027-03-02`,
          )
          .expect(200);
        const view = response.body as {
          date: string;
          config: Record<string, Record<string, unknown>>;
          settings: Record<
            string,
            Record<
              string,
              {
                value: unknown;
                source: string;
                layerId?: string;
                resetByLayerId?: string;
              }
            >
          >;
          chain: Array<{
            id: string;
            scopeType: string;
            scopeName: string;
            inheritanceMode: string;
            effectiveFrom: string;
            effectiveTo: string | null;
          }>;
          attendance: Record<string, unknown>;
          assignment: { organization: { id: string } };
        };

        // The very resolution the runtime uses (same layers, same function).
        const services = timeServices(rollbackClient(tx), clock);
        const assignment = await (
          services.time as unknown as {
            assignmentById(id: string, client: unknown): Promise<unknown>;
          }
        ).assignmentById(fx.assignmentTeamA, rollbackClient(tx));
        const runtime = await (
          services.time as unknown as {
            effectivePolicyForAssignmentOnWorkDate(
              a: unknown,
              d: Date,
              c: unknown,
            ): Promise<unknown>;
          }
        ).effectivePolicyForAssignmentOnWorkDate(
          assignment,
          new Date('2027-03-02T00:00:00.000Z'),
          rollbackClient(tx),
        );
        expect(view.config).toEqual(runtime);

        // The chain, broadest first, with scope names and dates.
        expect(
          view.chain.map((item) => [
            item.id,
            item.scopeType,
            item.inheritanceMode,
          ]),
        ).toEqual([
          [layers.org.id, 'ORGANIZATION', 'INHERIT'],
          [layers.root.id, 'ORGANIZATIONAL_UNIT', 'INHERIT'],
          [layers.child.id, 'ORGANIZATIONAL_UNIT', 'INHERIT'],
          [layers.dept.id, 'DEPARTMENT', 'INHERIT'],
          [layers.team.id, 'TEAM', 'OVERRIDE'],
          [layers.assignment.id, 'EMPLOYMENT_ASSIGNMENT', 'INHERIT'],
        ]);
        expect(view.chain.map((item) => item.scopeName)).toEqual([
          `Org A ${fx.suffix}`,
          'Root unit',
          'Child unit',
          'Dept A',
          'Team A',
          `Employee1 ${fx.suffix} · Team A Associate`,
        ]);
        expect(view.chain[0]).toMatchObject({
          effectiveFrom: '2026-01-01',
          effectiveTo: null,
        });

        // Sources: set by a layer, reset to the default by Team A's OVERRIDE, or plain defaults.
        expect(view.settings.clock!.mode).toEqual({
          value: 'LIVE_CLOCK',
          source: 'LAYER',
          layerId: layers.team.id,
        });
        expect(view.settings.breaks!.mode).toEqual({
          value: 'NONE',
          source: 'DEFAULT',
          resetByLayerId: layers.team.id,
        });
        expect(view.settings.attendance!.captureMode).toMatchObject({
          value: 'KIOSK_ONLY',
          source: 'LAYER',
          layerId: layers.assignment.id,
        });
        expect(
          view.settings.correction!.employeeRequestsEnabled,
        ).toBeUndefined(); // reset away
        expect(view.attendance).toMatchObject({
          trackingMode: 'TIME_CLOCK',
          captureMode: 'KIOSK_ONLY',
          signOutEnabled: true,
        });

        // Dates matter: before the assignment layer started, it isn't in the chain.
        await tx.timeAttendancePolicy.update({
          where: { id: layers.assignment.id },
          data: { effectiveFrom: new Date('2027-06-01T00:00:00.000Z') },
        });
        const earlier = (
          await admin
            .get(
              `/time/policies/effective?employmentAssignmentId=${fx.assignmentTeamA}&date=2027-03-02`,
            )
            .expect(200)
        ).body as typeof view;
        expect(earlier.chain.map((item) => item.id)).not.toContain(
          layers.assignment.id,
        );
        expect(earlier.attendance).toMatchObject({
          captureMode: 'SELF_SERVICE',
        });
        await admin
          .get('/time/policies/effective?employmentAssignmentId=not-a-uuid')
          .expect(400);
        await admin
          .get(
            `/time/policies/effective?employmentAssignmentId=${fx.assignmentTeamA}&date=03/02/2027`,
          )
          .expect(400);
      });
    });

    it('shows what a layer at a scope inherits on a date, by the runtime’s resolution, and says when it can’t', async () => {
      await scenario(async (h) => {
        const { fx, http, tx } = h;
        const layers = await chainForTeamA(h);
        const admin = await http.as(fx.users.adminA!);
        type Inherited = {
          date: string;
          determinable: boolean;
          reason?: string;
          varyingScopes?: string[];
          config?: Record<string, Record<string, unknown>>;
          settings?: Record<
            string,
            Record<string, { value: unknown; source: string; layerId?: string }>
          >;
          chain?: Array<{
            id: string;
            scopeType: string;
            config: Record<string, unknown>;
            inheritanceMode: 'INHERIT' | 'OVERRIDE';
          }>;
        };
        const inherited = async (query: string, status = 200) =>
          (
            await admin
              .get(`/time/policies/inherited?${query}&date=2027-03-02`)
              .expect(status)
          ).body as Inherited;
        const ids = (view: Inherited) =>
          view
            .chain!.filter((item) => item.scopeType !== 'SYSTEM')
            .map((item) => item.id);

        // An assignment inherits its runtime chain without its own layer: the same resolution.
        const effective = (
          await admin
            .get(
              `/time/policies/effective?employmentAssignmentId=${fx.assignmentTeamA}&date=2027-03-02`,
            )
            .expect(200)
        ).body as Inherited;
        const forAssignment = await inherited(
          `scopeType=EMPLOYMENT_ASSIGNMENT&employmentAssignmentId=${fx.assignmentTeamA}`,
        );
        expect(forAssignment).toMatchObject({
          date: '2027-03-02',
          determinable: true,
        });
        expect(forAssignment.chain!.map((item) => item.id)).toEqual(
          effective.chain!.slice(0, -1).map((item) => item.id),
        );
        expect(forAssignment.config).toEqual(
          new TimeDomainService().resolvePolicyConfig(
            effective.chain!.slice(0, -1),
          ),
        );
        // Team A's OVERRIDE is what an assignment layer inherits from (breaks reset to default).
        expect(forAssignment.settings!.clock!.mode).toEqual({
          value: 'LIVE_CLOCK',
          source: 'LAYER',
          layerId: layers.team.id,
        });
        expect(forAssignment.settings!.breaks!.mode).toMatchObject({
          value: 'NONE',
          source: 'DEFAULT',
        });

        // An organization inherits only the system layer; a unit, its ancestors.
        const forOrganization = await inherited(
          `scopeType=ORGANIZATION&organizationId=${fx.orgA}`,
        );
        expect(ids(forOrganization)).toEqual([]);
        const forChild = await inherited(
          `scopeType=ORGANIZATIONAL_UNIT&organizationalUnitId=${fx.unitChild}`,
        );
        expect(ids(forChild)).toEqual([layers.org.id, layers.root.id]);
        expect(
          forChild.settings!.attendanceInterpretation!.lateGraceMinutes,
        ).toEqual({ value: 5, source: 'LAYER', layerId: layers.root.id });

        // A department or team: its broader layers depend on each position's unit (and
        // department), so with unit or department layers in effect nothing is guessed.
        expect(
          await inherited(`scopeType=DEPARTMENT&departmentId=${fx.deptA}`),
        ).toEqual({
          date: '2027-03-02',
          determinable: false,
          reason: 'VARIES_BY_POSITION',
          varyingScopes: ['ORGANIZATIONAL_UNIT'],
        });
        expect(
          (
            await inherited(`scopeType=TEAM&teamId=${fx.teamA}`)
          ).varyingScopes!.sort(),
        ).toEqual(['DEPARTMENT', 'ORGANIZATIONAL_UNIT']);
        // Once no unit layer applies on the date, a department's inheritance is exact.
        await tx.timeAttendancePolicy.updateMany({
          where: { id: { in: [layers.root.id, layers.child.id] } },
          data: { effectiveTo: new Date('2027-03-01T00:00:00.000Z') },
        });
        const forDepartment = await inherited(
          `scopeType=DEPARTMENT&departmentId=${fx.deptA}`,
        );
        expect(forDepartment.determinable).toBe(true);
        expect(ids(forDepartment)).toEqual([layers.org.id]);
        expect(
          (await inherited(`scopeType=TEAM&teamId=${fx.teamA}`)).varyingScopes,
        ).toEqual(['DEPARTMENT']);

        // Authorized as adding a layer there; anything else looks missing.
        const teamAdmin = await http.as(fx.users.teamPolicyAdmin!);
        await teamAdmin
          .get(
            `/time/policies/inherited?scopeType=TEAM&teamId=${fx.teamA}&date=2027-03-02`,
          )
          .expect(200);
        const missing = `/time/policies/inherited?scopeType=ORGANIZATIONAL_UNIT&organizationalUnitId=${randomUUID()}&date=2027-03-02`;
        expect(
          (
            await teamAdmin
              .get(
                `/time/policies/inherited?scopeType=ORGANIZATION&organizationId=${fx.orgA}&date=2027-03-02`,
              )
              .expect(404)
          ).body,
        ).toEqual((await teamAdmin.get(missing).expect(404)).body);
        const adminB = await http.as(fx.users.adminB!);
        await adminB
          .get(
            `/time/policies/inherited?scopeType=ORGANIZATIONAL_UNIT&organizationalUnitId=${fx.unitChild}&date=2027-03-02`,
          )
          .expect(404);
        await adminB
          .get(
            `/time/policies/inherited?scopeType=EMPLOYMENT_ASSIGNMENT&employmentAssignmentId=${fx.assignmentTeamA}&date=2027-03-02`,
          )
          .expect(404);
        const outsider = await http.as(fx.users.outsider!);
        await outsider
          .get(
            `/time/policies/inherited?scopeType=ORGANIZATION&organizationId=${fx.orgA}&date=2027-03-02`,
          )
          .expect(404);
        // Validation: a date is required; there is no SYSTEM editing (D4).
        await admin
          .get(
            `/time/policies/inherited?scopeType=ORGANIZATION&organizationId=${fx.orgA}`,
          )
          .expect(400);
        await admin
          .get('/time/policies/inherited?scopeType=SYSTEM&date=2027-03-02')
          .expect(400);
      });
    });

    it('shows an effective policy only within the caller’s organizations and positions', async () => {
      await scenario(async (h) => {
        const { fx, http } = h;
        await chainForTeamA(h);
        const path = (id: string) =>
          `/time/policies/effective?employmentAssignmentId=${id}`;
        // Another organization, no permission, or a position outside the team: 404, nothing told.
        for (const user of [
          fx.users.adminB!,
          fx.users.outsider!,
          fx.selfUser1,
        ]) {
          const response = await (
            await http.as(user)
          )
            .get(path(fx.assignmentTeamA))
            .expect(404);
          expect(JSON.stringify(response.body)).not.toMatch(
            /Team A|Org A|ORGANIZATION/,
          );
        }
        const team = await http.as(fx.users.teamViewer!);
        await team.get(path(fx.assignmentTeamA)).expect(200);
        await team.get(path(fx.assignmentDeptB)).expect(404);
        // Organization B's admin reads Organization B's assignment of the same employee.
        await (
          await http.as(fx.users.adminB!)
        )
          .get(path(h.orgBAssignment))
          .expect(200);
      });
    });

    it('names every policy layer’s scope in the list and keeps the ids', async () => {
      await scenario(async (h) => {
        const { fx, http } = h;
        const layers = await chainForTeamA(h);
        const items = (
          await (
            await http.as(fx.users.adminA!)
          )
            .get(`/time/policies?organizationId=${fx.orgA}`)
            .expect(200)
        ).body.items as Array<{
          id: string;
          scopeName: string;
          teamId: string | null;
          organizationId: string | null;
          updatedAt: string;
        }>;
        const byId = new Map(items.map((item) => [item.id, item]));
        expect(byId.get(layers.org.id)).toMatchObject({
          scopeName: `Org A ${fx.suffix}`,
          organizationId: fx.orgA,
        });
        expect(byId.get(layers.team.id)).toMatchObject({
          scopeName: 'Team A',
          teamId: fx.teamA,
        });
        expect(byId.get(layers.dept.id)?.scopeName).toBe('Dept A');
        expect(byId.get(layers.assignment.id)?.scopeName).toBe(
          `Employee1 ${fx.suffix} · Team A Associate`,
        );
        expect(items.every((item) => typeof item.updatedAt === 'string')).toBe(
          true,
        );
        // Organization B's layers never appear in Organization A's list.
        expect(items.some((item) => item.organizationId === fx.orgB)).toBe(
          false,
        );

        // Review fix: a caller scoped below the organization (Team A) still lists the
        // organization's layers, but an assignment layer outside its positions is not named:
        // no employee or position from beyond its scope.
        const teamItems = (
          await (
            await http.as(fx.users.teamPolicyAdmin!)
          )
            .get(`/time/policies?organizationId=${fx.orgA}`)
            .expect(200)
        ).body.items as typeof items;
        const outside = teamItems.find(
          (item) =>
            (item as unknown as { employmentAssignmentId: string | null })
              .employmentAssignmentId === fx.assignmentDeptB,
        );
        expect(outside?.scopeName).toBe('Employment assignment');
        expect(JSON.stringify(outside)).not.toContain('Dept B Associate');
        expect(
          teamItems.find((item) => item.id === layers.assignment.id)?.scopeName,
        ).toBe(`Employee1 ${fx.suffix} · Team A Associate`);
      });
    });

    it('replaces a layer from a date: old period kept, replacement in effect, audited; refuses stale, past, early and invalid requests', async () => {
      await scenario(async (h) => {
        const { fx, http, tx } = h;
        const org = await seedTimePolicy(tx, fx.orgA, {
          clock: { mode: 'LIVE_CLOCK' },
          breaks: { mode: 'NONE' },
        });
        const admin = await http.as(fx.users.adminA!);
        const current = (
          (
            await admin
              .get(`/time/policies?organizationId=${fx.orgA}`)
              .expect(200)
          ).body.items as Array<{
            id: string;
            updatedAt: string;
          }>
        ).find((item) => item.id === org.id)!;
        const supersede = (body: Record<string, unknown>, user = admin) =>
          user.post(`/time/policies/${org.id}/supersede`, {
            effectiveFrom: '2027-01-01',
            expectedUpdatedAt: current.updatedAt,
            config: {
              clock: { mode: 'LIVE_CLOCK' },
              breaks: { mode: 'AUTO_DEDUCT', autoDeductMinutes: 30 },
            },
            ...body,
          });
        const code = async (
          request: ReturnType<typeof supersede>,
          status: number,
        ) => ((await request.expect(status)).body as { code?: string }).code;

        // Refused before anything changes.
        expect(
          await code(
            supersede({ config: { breaks: { mode: 'SOMETIMES' } } }),
            400,
          ),
        ).toBe('TIME_POLICY_CONFIG_INVALID');
        expect(
          await code(supersede({ effectiveFrom: '2020-01-01' }), 409),
        ).toBe('TIME_POLICY_RETROACTIVE');
        expect(
          await code(
            supersede({ expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }),
            409,
          ),
        ).toBe('TIME_POLICY_CHANGED');
        await supersede({}, await http.as(fx.users.adminB!)).expect(
          (response) => expect([403, 404]).toContain(response.status),
        );
        await supersede({}, await http.as(fx.users.teamPolicyAdmin!)).expect(
          403,
        );
        expect(
          await tx.timeAttendancePolicy.findUniqueOrThrow({
            where: { id: org.id },
          }),
        ).toMatchObject({ effectiveTo: null, archivedAt: null });

        const result = (await supersede({}).expect(201)).body as {
          ended: { id: string; effectiveFrom: string; effectiveTo: string };
          created: {
            id: string;
            effectiveFrom: string;
            effectiveTo: string | null;
            config: { breaks: Record<string, unknown> };
          };
        };
        expect(result.ended).toMatchObject({
          id: org.id,
          effectiveFrom: '2026-01-01',
          effectiveTo: '2026-12-31',
        });
        expect(result.created).toMatchObject({
          effectiveFrom: '2027-01-01',
          effectiveTo: null,
        });
        // The 4D default threshold applies to a replacement too.
        expect(result.created.config.breaks).toMatchObject({
          mode: 'AUTO_DEDUCT',
          autoDeductAfterMinutes: 360,
        });
        const audits = await tx.auditLog.findMany({
          where: { entityId: { in: [org.id, result.created.id] } },
          orderBy: { occurredAt: 'asc' },
        });
        expect(
          audits.map((audit) => [
            audit.entityId,
            audit.action,
            audit.actorUserId,
          ]),
        ).toEqual(
          expect.arrayContaining([
            [org.id, 'TIME_POLICY_SUPERSEDED', fx.users.adminA],
            [result.created.id, 'TIME_POLICY_CREATED', fx.users.adminA],
          ]),
        );
        expect(
          audits.find((audit) => audit.action === 'TIME_POLICY_SUPERSEDED')!
            .metadata,
        ).toMatchObject({
          supersededBy: result.created.id,
          effectiveFrom: '2027-01-01',
        });

        // The effective policy before and after the date.
        const at = async (date: string) =>
          (
            (
              await admin
                .get(
                  `/time/policies/effective?employmentAssignmentId=${fx.assignmentTeamA}&date=${date}`,
                )
                .expect(200)
            ).body as { config: { breaks: { mode: string } } }
          ).config.breaks.mode;
        expect(await at('2026-12-31')).toBe('NONE');
        expect(await at('2027-01-01')).toBe('AUTO_DEDUCT');

        // Replaying the same request: the layer changed meanwhile.
        expect(await code(supersede({}), 409)).toBe('TIME_POLICY_CHANGED');
        // A date not after the layer's own start, or after it ends.
        const replacement = (
          (
            await admin
              .get(`/time/policies?organizationId=${fx.orgA}`)
              .expect(200)
          ).body.items as Array<{
            id: string;
            updatedAt: string;
          }>
        ).find((item) => item.id === result.created.id)!;
        const again = (effectiveFrom: string) =>
          admin.post(`/time/policies/${replacement.id}/supersede`, {
            effectiveFrom,
            expectedUpdatedAt: replacement.updatedAt,
            config: { clock: { mode: 'LIVE_CLOCK' } },
          });
        expect(await code(again('2027-01-01'), 409)).toBe(
          'TIME_POLICY_SUPERSEDE_DATE',
        );
        expect(
          await code(
            admin.post(`/time/policies/${org.id}/supersede`, {
              effectiveFrom: '2027-02-01',
              expectedUpdatedAt:
                result.ended &&
                (
                  (
                    await admin
                      .get(`/time/policies?organizationId=${fx.orgA}`)
                      .expect(200)
                  ).body.items as Array<{ id: string; updatedAt: string }>
                ).find((item) => item.id === org.id)!.updatedAt,
              config: { clock: { mode: 'LIVE_CLOCK' } },
            }),
            409,
          ),
        ).toBe('TIME_POLICY_SUPERSEDE_DATE');
        // History: both layers are kept.
        expect(
          await tx.timeAttendancePolicy.count({
            where: { organizationId: fx.orgA, scopeType: 'ORGANIZATION' },
          }),
        ).toBe(2);
      });
    });

    it('lists how each assignment captures attendance across the caller’s organizations, and nothing else', async () => {
      await scenario(async (h) => {
        const { fx, http, tx } = h;
        await chainForTeamA(h);
        // Organization B: Employee 1 signs in only there.
        await tx.timeAttendancePolicy.updateMany({
          where: { organizationId: fx.orgB, scopeType: 'ORGANIZATION' },
          data: { archivedAt: new Date() },
        });
        await seedTimePolicy(tx, fx.orgB, {
          attendance: {
            trackingMode: 'SIGN_IN_ONLY',
            captureMode: 'KIOSK_ONLY',
          },
        });
        type Row = {
          id: string;
          employee: { id: string; name: string };
          assignment: {
            organization: { id: string };
            position: { name: string };
          };
          attendance: { trackingMode: string; captureMode: string };
          clock: { mode: string };
          breaks: { mode: string };
          chain: Array<{ scopeName: string }>;
        };
        const list = async (userId: string, query: string) => {
          const items: Row[] = [];
          let afterId: string | null = null;
          do {
            const page = (
              await (
                await http.as(userId)
              )
                .get(
                  `/time/manage/assignment-attendance?${query}&limit=1${afterId ? `&afterId=${afterId}` : ''}`,
                )
                .expect(200)
            ).body as { items: Row[]; nextAfterId: string | null };
            items.push(...page.items);
            afterId = page.nextAfterId;
          } while (afterId);
          return items;
        };
        const both = await list(
          fx.users.adminAB!,
          `employeeId=${fx.employee1}&date=2027-03-02`,
        );
        expect(new Set(both.map((row) => row.id))).toEqual(
          new Set([fx.assignmentTeamA, fx.assignmentDeptB, h.orgBAssignment]),
        );
        const byId = new Map(both.map((row) => [row.id, row]));
        expect(byId.get(h.orgBAssignment)).toMatchObject({
          assignment: { organization: { id: fx.orgB } },
          attendance: {
            trackingMode: 'SIGN_IN_ONLY',
            captureMode: 'KIOSK_ONLY',
          },
        });
        expect(byId.get(fx.assignmentTeamA)).toMatchObject({
          attendance: { trackingMode: 'TIME_CLOCK', captureMode: 'KIOSK_ONLY' },
          clock: { mode: 'LIVE_CLOCK' },
        });
        expect(
          byId.get(fx.assignmentTeamA)!.chain.map((item) => item.scopeName),
        ).toContain('Team A');

        // Organization A's admin: Organization A's assignments only, no trace of B.
        const onlyA = await list(
          fx.users.adminA!,
          `employeeId=${fx.employee1}`,
        );
        expect(new Set(onlyA.map((row) => row.id))).toEqual(
          new Set([fx.assignmentTeamA, fx.assignmentDeptB]),
        );
        expect(JSON.stringify(onlyA)).not.toContain(fx.orgB);
        // A Team A viewer: Team A positions only. Search finds by employee number.
        const team = await list(
          fx.users.teamViewer!,
          `search=${encodeURIComponent(`E1-${fx.suffix}`)}`,
        );
        expect(team.map((row) => row.id)).toEqual([fx.assignmentTeamA]);
        expect(
          await list(fx.users.outsider!, `employeeId=${fx.employee1}`),
        ).toEqual([]);
        expect(await list(fx.selfUser1, `employeeId=${fx.employee1}`)).toEqual(
          [],
        );
        await (
          await http.as(fx.users.adminA!)
        )
          .get('/time/manage/assignment-attendance?limit=500')
          .expect(400);
      });
    });

    it('reads the clock at the API’s own today when no date is given', async () => {
      await scenario(async (h) => {
        const { fx, http, clock } = h;
        await chainForTeamA(h);
        clock.value = toronto('2027-03-02T09:00');
        const view = (
          await (
            await http.as(fx.users.adminA!)
          )
            .get(
              `/time/policies/effective?employmentAssignmentId=${fx.assignmentTeamA}`,
            )
            .expect(200)
        ).body as { date: string; timezone: string };
        expect(view).toMatchObject({
          date: '2027-03-02',
          timezone: 'America/Toronto',
        });
      });
    });
  },
);
