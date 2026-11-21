import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BenefitsClock } from '../src/benefits/benefits-common.js';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  BENEFIT_USERS,
  FixedBenefitsClock,
} from './support/benefits-fixtures.js';
import { FixedClock } from './support/leave-fixtures.js';
import { createSchedulingFixtures } from './support/scheduling-fixtures.js';
import { withTimeHttp } from './support/time-http.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

type Election = {
  id: string;
  status: string;
  endReason?: string | null;
  eligibilityOverrideReason?: string | null;
  actions: Record<string, boolean>;
};

/**
 * Batch 7C — Benefits over HTTP: the whole application (guards, validation pipe, controllers,
 * the Benefits constraint filter, services) on the scenario's rollback transaction. A plan's
 * lifecycle from configuration to elections, dependents and corrections, with the
 * authorization and confidentiality matrix, organization isolation, domain error codes and the
 * picker options.
 */
describe('Benefits API (HTTP, database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('configuration, elections, dependents and the access matrix over HTTP', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, BENEFIT_USERS);
          await tx.organization.update({
            where: { id: fx.orgA },
            data: { timezone: 'America/Toronto' },
          });
          const clock = new FixedBenefitsClock();
          await withTimeHttp(
            tx,
            new FixedClock(),
            async (http) => {
              const planAdmin = await http.as(fx.users.planAdmin!);
              const hr = await http.as(fx.users.benefitsAdmin!);
              const reader = await http.as(fx.users.reader!);
              const outsider = await http.as(fx.users.orgBAdmin!);
              const teamManager = await http.as(fx.users.teamManager!);
              const coreHr = await http.as(fx.users.hr!);
              const self = await http.as(fx.selfUser1);

              await http.anonymous().get('/benefits/organizations').expect(401);

              // ── Configuration ────────────────────────────────────────────────
              const plan = (
                await planAdmin
                  .post('/benefits/plans', {
                    organizationId: fx.orgA,
                    code: 'HEALTH',
                    name: 'Health',
                    benefitType: 'HEALTH',
                    currency: 'CAD',
                    effectiveFrom: '2026-01-01',
                    description: 'Extended health',
                    providerName: 'Carrier',
                    providerReference: 'GRP-1',
                    showEmployerCostToEmployee: true,
                    employerContributionTaxable: false,
                    dependentChildMaxAge: 21,
                  })
                  .expect(201)
              ).body as { id: string };
              // Unknown fields are refused (the API never takes the code on edit).
              await planAdmin
                .patch(`/benefits/plans/${plan.id}`, { code: 'X' })
                .expect(400);
              await planAdmin
                .patch(`/benefits/plans/${plan.id}`, {
                  name: 'Health (extended)',
                })
                .expect(200);
              const options: Record<string, string> = {};
              for (const [code, level] of [
                ['SINGLE', 'EMPLOYEE_ONLY'],
                ['FAMILY', 'FAMILY'],
              ]) {
                options[code] = (
                  (
                    await planAdmin
                      .post(`/benefits/plans/${plan.id}/options`, {
                        code,
                        name: code,
                        coverageLevel: level,
                      })
                      .expect(201)
                  ).body as { id: string }
                ).id;
                await planAdmin
                  .post(`/benefits/options/${options[code]}/rates`, {
                    effectiveFrom: '2026-01-01',
                    frequency: 'MONTHLY',
                    employeeAmount: '25',
                    employerAmount: '75',
                  })
                  .expect(201);
              }
              await planAdmin
                .patch(`/benefits/options/${options.SINGLE}`, {
                  name: 'Employee only',
                })
                .expect(200);
              await planAdmin
                .post(`/benefits/plans/${plan.id}/activate`, {})
                .expect(201);
              await planAdmin
                .post(`/benefits/plans/${plan.id}/eligibility-rules`, {
                  effectiveFrom: '2026-01-01',
                  departmentId: fx.deptA,
                })
                .expect(201);
              const detail = (
                await planAdmin.get(`/benefits/plans/${plan.id}`).expect(200)
              ).body as {
                actions: Record<string, boolean>;
                rates: Array<{ id: string; actions: { canCorrect: boolean } }>;
                eligibilityRules: Array<{ departmentName: string | null }>;
              };
              expect(detail.eligibilityRules[0]!.departmentName).toBe('Dept A');
              expect(detail.actions).toMatchObject({
                canActivate: false,
                canClose: true,
                canEditStart: false,
              });
              const rateId = detail.rates[0]!.id;
              await planAdmin
                .post(`/benefits/rates/${rateId}/correct`, {
                  employeeAmount: '26',
                })
                .expect(400);
              await planAdmin
                .post(`/benefits/rates/${rateId}/correct`, {
                  employeeAmount: '26',
                  reason: 'Carrier invoice',
                })
                .expect(201);

              // ── Organization isolation and permissions ───────────────────────
              await outsider.get(`/benefits/plans/${plan.id}`).expect(404);
              await outsider
                .patch(`/benefits/plans/${plan.id}`, { name: 'X' })
                .expect(404);
              await outsider
                .get(`/benefits/employees/${fx.employee1}/elections`)
                .expect(404);
              const refused = await reader
                .patch(`/benefits/plans/${plan.id}`, { name: 'X' })
                .expect(403);
              expect(refused.body).toMatchObject({
                code: 'BENEFIT_PERMISSION_REQUIRED',
              });
              // Core HR access never implies benefits.
              await coreHr
                .get(`/benefits/employees/${fx.employee1}/elections`)
                .expect(403);

              // ── Pickers ──────────────────────────────────────────────────────
              const picked = (
                await hr
                  .get(
                    `/benefits/options?organizationId=${fx.orgA}&kind=assignment&employeeId=${fx.employee1}`,
                  )
                  .expect(200)
              ).body as { items: Array<{ id: string; label: string }> };
              expect(picked.items.map((o) => o.id).sort()).toEqual(
                [fx.assignmentTeamA, fx.assignmentDeptB].sort(),
              );
              await reader
                .get(`/benefits/options?organizationId=${fx.orgA}&kind=unit`)
                .expect(403);
              await planAdmin
                .get(
                  `/benefits/options?organizationId=${fx.orgA}&kind=everyone`,
                )
                .expect(400);

              // ── Dependents ───────────────────────────────────────────────────
              const spouse = (
                await hr
                  .post(`/benefits/employees/${fx.employee1}/dependents`, {
                    firstName: 'Sam',
                    lastName: 'Spouse',
                    relationship: 'SPOUSE',
                    dateOfBirth: '1990-05-01',
                    relationshipStartDate: '2015-06-01',
                  })
                  .expect(201)
              ).body as { id: string };
              const asReader = (
                await reader
                  .get(`/benefits/employees/${fx.employee1}/dependents`)
                  .expect(200)
              ).body as { items: Array<{ dateOfBirth: string | null }> };
              expect(asReader.items[0]!.dateOfBirth).toBeNull();
              const mine = (
                await self.get('/benefits/me/dependents').expect(200)
              ).body as { items: Array<{ dateOfBirth: string | null }> };
              expect(mine.items[0]!.dateOfBirth).toBe('1990-05-01');
              await self
                .post(`/benefits/employees/${fx.employee1}/dependents`, {
                  firstName: 'Me',
                  lastName: 'Self',
                  relationship: 'OTHER',
                })
                .expect(403);

              // ── Elections ────────────────────────────────────────────────────
              const election = (
                await hr
                  .post('/benefits/elections/enroll', {
                    employmentAssignmentId: fx.assignmentTeamA,
                    planId: plan.id,
                    optionId: options.FAMILY,
                    coverageStart: '2026-02-01',
                    dependentIds: [spouse.id],
                  })
                  .expect(201)
              ).body as Election;
              // Department B is not eligible: a transfer needs a fresh override reason.
              const transfer = await hr
                .post(`/benefits/elections/${election.id}/transfer`, {
                  employmentAssignmentId: fx.assignmentDeptB,
                  effectiveDate: '2026-03-01',
                })
                .expect(409);
              expect(transfer.body).toMatchObject({
                code: 'BENEFIT_NOT_ELIGIBLE',
              });
              // A covered dependent's history is never invalidated.
              const history = await hr
                .patch(`/benefits/dependents/${spouse.id}`, {
                  relationshipStartDate: '2026-06-01',
                })
                .expect(409);
              expect(history.body).toMatchObject({
                code: 'BENEFIT_DEPENDENT_HISTORY_CONFLICT',
              });
              // A Team A manager reaches the Team A election, never a scope they lack.
              await teamManager
                .get(`/benefits/employees/${fx.employee1}/elections`)
                .expect(200);
              // Divorce: relationship ended, then coverage changed to the employee alone.
              await hr
                .patch(`/benefits/dependents/${spouse.id}`, {
                  relationshipEndDate: '2026-05-31',
                })
                .expect(200);
              const changed = (
                await hr
                  .post(`/benefits/elections/${election.id}/change`, {
                    effectiveDate: '2026-06-01',
                    optionId: options.SINGLE,
                    dependentIds: [],
                    reason: 'Divorce',
                  })
                  .expect(201)
              ).body as Election;
              // Ending the first segment while the change continues it: refused, nothing ended.
              const later = await hr
                .post(`/benefits/elections/${election.id}/end`, {
                  coverageEnd: '2026-04-30',
                })
                .expect(409);
              expect(later.body).toMatchObject({
                code: 'BENEFIT_LATER_COVERAGE',
                laterElections: 1,
              });
              const ended = (
                await hr
                  .post(`/benefits/elections/${changed.id}/end`, {
                    coverageEnd: '2026-12-31',
                    reason: 'Leaving the plan',
                  })
                  .expect(201)
              ).body as Election;
              expect(ended.endReason).toBe('Leaving the plan');
              // The employee never sees HR notes.
              const own = await self.get('/benefits/me').expect(200);
              expect(JSON.stringify(own.body)).not.toContain(
                'Leaving the plan',
              );
              expect(JSON.stringify(own.body)).not.toContain('Divorce');
              // Nobody manages their own benefits.
              await self
                .post(`/benefits/elections/${changed.id}/rescind`, {
                  reason: 'Mine',
                })
                .expect(403);
              // An archived option's rates are history (409 with a domain code).
              await hr
                .post(`/benefits/elections/${changed.id}/rescind`, {
                  reason: 'Entered by mistake',
                })
                .expect(201);
              await hr
                .post(`/benefits/elections/${election.id}/rescind`, {
                  reason: 'Entered by mistake',
                })
                .expect(201);
              await planAdmin
                .post(`/benefits/options/${options.FAMILY}/archive`, {})
                .expect(201);
              const familyRate = (
                (await planAdmin.get(`/benefits/plans/${plan.id}`).expect(200))
                  .body as {
                  rates: Array<{
                    id: string;
                    optionId: string;
                    supersededAt: string | null;
                    actions: { canCorrect: boolean };
                  }>;
                }
              ).rates.find(
                (rate) =>
                  rate.optionId === options.FAMILY && !rate.supersededAt,
              )!;
              expect(familyRate.actions.canCorrect).toBe(false);
              const archived = await planAdmin
                .post(`/benefits/rates/${familyRate.id}/correct`, {
                  employeeAmount: '30',
                  reason: 'Late invoice',
                })
                .expect(409);
              expect(archived.body).toMatchObject({ code: 'BENEFIT_ARCHIVED' });
            },
            [[BenefitsClock, clock]],
          );
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  });
});
