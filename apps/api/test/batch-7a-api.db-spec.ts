import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { OnboardingClock } from '../src/onboarding/onboarding-common.js';
import { RecruitmentClock } from '../src/recruitment/recruitment-common.js';
import { FixedClock } from './support/leave-fixtures.js';
import {
  activeTemplate,
  FixedOnboardingClock,
  offboardingTasks,
  ONBOARDING_USERS,
  onboardingServices,
} from './support/onboarding-fixtures.js';
import {
  candidateDetails,
  FixedRecruitmentClock,
  RECRUITMENT_USERS,
  recruitmentServices,
} from './support/recruitment-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
} from './support/scheduling-fixtures.js';
import { withTimeHttp } from './support/time-http.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

type Page = {
  items: Array<{ id: string; label: string; placement?: object }>;
  nextAfterId: string | null;
};

/**
 * Batch 7A — Recruitment and Onboarding over HTTP: the whole application (real guards,
 * validation pipe, controllers, services) on the scenario's rollback transaction. A team
 * recruiter creates an opening and schedules an interview entirely from picker options (no
 * raw ids typed), the security fixes hold at the HTTP boundary (S1, S3, Q4), intake history
 * pages; onboarding HR picks owners, offboards an ENDED assignment and is refused outside its
 * kind and organization.
 */
describe('Recruitment and onboarding API (HTTP, database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('recruitment: pickers end to end, security fixes and intake history over HTTP', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, RECRUITMENT_USERS);
          const recruitmentClock = new FixedRecruitmentClock();
          const svc = recruitmentServices(rollbackClient(tx), recruitmentClock);
          await withTimeHttp(
            tx,
            new FixedClock(),
            async (http) => {
              const org = `organizationId=${fx.orgA}`;
              const team = await http.as(fx.users.teamRecruiter!);
              const reader = await http.as(fx.users.reader!);
              const outsider = await http.as(fx.users.orgBAdmin!);
              const admin = await http.as(fx.users.hiringAdmin!);

              await http
                .anonymous()
                .get(`/recruitment/options?${org}&kind=staff`)
                .expect(401);
              await team
                .get(`/recruitment/options?${org}&kind=everyone`)
                .expect(400);
              await team
                .get(`/recruitment/options?${org}&kind=staff&limit=51`)
                .expect(400);
              await reader
                .get(`/recruitment/options?${org}&kind=staff`)
                .expect(403);
              await outsider
                .get(`/recruitment/options?${org}&kind=staff`)
                .expect(403);

              // ── A team recruiter builds an opening from pickers only ──────────
              const teams = (
                await team
                  .get(`/recruitment/options?${org}&kind=team`)
                  .expect(200)
              ).body as Page;
              expect(teams.items.map((t) => t.id)).toEqual([fx.teamA]);
              const managers = (
                await team
                  .get(
                    `/recruitment/options?${org}&kind=hiringManager&search=${fx.suffix}`,
                  )
                  .expect(200)
              ).body as Page;
              const opening = (
                await team
                  .post('/recruitment/openings', {
                    organizationId: fx.orgA,
                    code: 'REQ-HTTP',
                    title: 'Classroom assistant',
                    employmentType: 'FULL_TIME',
                    openingCount: 1,
                    ...teams.items[0]!.placement,
                    hiringManagerEmployeeId: managers.items.find(
                      (m) => m.id === fx.employee2,
                    )!.id,
                  })
                  .expect(201)
              ).body as { id: string };
              await team
                .post(`/recruitment/openings/${opening.id}/open`, {})
                .expect(201);
              // Opening details (the page the web now shows).
              const detail = (
                await team
                  .get(`/recruitment/openings/${opening.id}`)
                  .expect(200)
              ).body as { id: string };
              expect(detail.id).toBe(opening.id);

              const application = (
                await team
                  .post('/recruitment/applications', {
                    openingId: opening.id,
                    candidate: candidateDetails({
                      email: `http-${fx.suffix.toLowerCase()}@example.com`,
                    }),
                  })
                  .expect(201)
              ).body as { id: string };
              const staff = (
                await team
                  .get(
                    `/recruitment/options?${org}&kind=staff&search=${fx.suffix}`,
                  )
                  .expect(200)
              ).body as Page;
              const interviewer = staff.items.find(
                (s) => s.id === fx.selfUser2,
              )!;
              const interview = (
                await team
                  .post(
                    `/recruitment/applications/${application.id}/interviews`,
                    {
                      type: 'IN_PERSON',
                      title: 'Classroom visit',
                      scheduledStart: '2026-03-16T15:00:00Z',
                      durationMinutes: 60,
                      location: 'Room 12',
                      interviewerUserIds: [interviewer.id],
                    },
                  )
                  .expect(201)
              ).body as { id: string };

              // S1 over HTTP: an unsubmitted draft never reaches other readers.
              await svc.interviews.saveFeedback(
                interview.id,
                {
                  recommendation: 'YES',
                  comments: 'Private draft over HTTP',
                } as never,
                ctx(fx.selfUser2),
              );
              const history = await admin
                .get(`/recruitment/interviews/${interview.id}/feedback`)
                .expect(200);
              expect(JSON.stringify(history.body)).not.toContain(
                'Private draft over HTTP',
              );

              // S3 over HTTP: an email the team recruiter cannot read is refused neutrally.
              await admin
                .post('/recruitment/applications', {
                  openingId: (
                    await svc.openings.transition(
                      (
                        await svc.openings.create(
                          {
                            organizationId: fx.orgA,
                            code: 'REQ-ORG-HTTP',
                            title: 'Office manager',
                            employmentType: 'FULL_TIME',
                            positionId: fx.positionOrg,
                            openingCount: 1,
                          } as never,
                          ctx(fx.users.hiringAdmin!),
                        )
                      ).id,
                      'open',
                      null,
                      ctx(fx.users.hiringAdmin!),
                    )
                  ).id,
                  candidate: candidateDetails({ email: 'hidden@example.com' }),
                })
                .expect(201);
              const refused = await team
                .post('/recruitment/applications', {
                  openingId: opening.id,
                  candidate: candidateDetails({
                    firstName: 'Other',
                    email: 'HIDDEN@example.com',
                  }),
                })
                .expect(409);
              expect(refused.body).toMatchObject({
                code: 'RECRUITMENT_CANDIDATE_EMAIL_UNAVAILABLE',
              });
              expect(JSON.stringify(refused.body)).not.toMatch(/Ada|hidden@/);

              // Q4 over HTTP: another organization's stage is "not found".
              const stage = (
                await admin
                  .post('/recruitment/stages', {
                    organizationId: fx.orgA,
                    code: 'HTTP-STAGE',
                    name: 'Phone screen',
                    kind: 'SCREENING',
                  })
                  .expect(201)
              ).body as { id: string };
              await outsider
                .patch(`/recruitment/stages/${stage.id}`, { name: 'X' })
                .expect(404);
              await reader
                .patch(`/recruitment/stages/${stage.id}`, { name: 'X' })
                .expect(403);

              // Intake history pages over HTTP.
              const intake = await http.as(fx.users.intakeAdmin!);
              const source = (
                await intake
                  .post('/recruitment/intake-sources', {
                    organizationId: fx.orgA,
                    code: 'HTTP-FORM',
                    name: 'Careers form',
                    provider: 'MANUAL_IMPORT',
                  })
                  .expect(201)
              ).body as { id: string };
              for (const n of [1, 2, 3]) {
                await tx.recruitmentIntakeSubmission.create({
                  data: {
                    organizationId: fx.orgA,
                    sourceId: source.id,
                    externalResponseId: `http-${n}`,
                    status: 'REJECTED',
                    submission: {},
                    contentHash: `h${n}`,
                    submittedAt: new Date(Date.UTC(2026, 2, n)),
                  },
                });
              }
              const first = (
                await intake
                  .get(
                    `/recruitment/intake?${org}&status=REJECTED&sourceId=${source.id}&limit=2`,
                  )
                  .expect(200)
              ).body as { items: Array<{ id: string }>; nextAfterId: string };
              expect(first.items).toHaveLength(2);
              const second = (
                await intake
                  .get(
                    `/recruitment/intake?${org}&status=REJECTED&sourceId=${source.id}&limit=2&afterId=${first.nextAfterId}`,
                  )
                  .expect(200)
              ).body as { items: unknown[]; nextAfterId: string | null };
              expect(second).toMatchObject({ nextAfterId: null });
              expect(second.items).toHaveLength(1);
              await intake
                .get(`/recruitment/intake?${org}&limit=500`)
                .expect(400);
            },
            [[RecruitmentClock, recruitmentClock]],
          );
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  });

  it('onboarding: options, ENDED offboarding, kind and organization refusals over HTTP', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, ONBOARDING_USERS);
          const onboardingClock = new FixedOnboardingClock();
          const svc = onboardingServices(rollbackClient(tx), onboardingClock);
          await activeTemplate(svc, fx);
          await activeTemplate(svc, fx, {
            kind: 'OFFBOARDING',
            code: 'EXIT',
            tasks: offboardingTasks(fx) as never,
          });
          await withTimeHttp(
            tx,
            new FixedClock(),
            async (http) => {
              const org = `organizationId=${fx.orgA}`;
              const onboardingHr = await http.as(fx.users.onboardingHr!);
              const offboardingHr = await http.as(fx.users.offboardingHr!);
              const outsider = await http.as(fx.users.orgBAdmin!);
              const reader = await http.as(fx.users.onboardingReader!);

              await http
                .anonymous()
                .get(`/onboarding/options?${org}&kind=owner`)
                .expect(401);
              const owners = (
                await onboardingHr
                  .get(
                    `/onboarding/options?${org}&kind=owner&search=${fx.suffix}`,
                  )
                  .expect(200)
              ).body as Page;
              expect(owners.items.map((o) => o.id).sort()).toEqual(
                [fx.selfUser1, fx.selfUser2].sort(),
              );
              await reader
                .get(`/onboarding/options?${org}&kind=owner`)
                .expect(403);
              await outsider
                .get(`/onboarding/options?${org}&kind=owner`)
                .expect(403);
              await onboardingHr
                .get(
                  `/onboarding/options?${org}&kind=assignment&workflowKind=OFFBOARDING`,
                )
                .expect(403);

              // Offboarding an ENDED assignment, picked from the options.
              await tx.employmentAssignment.update({
                where: { id: fx.orgLevel },
                data: {
                  status: 'ENDED',
                  endDate: new Date('2026-03-01T00:00:00Z'),
                },
              });
              const ended = (
                await offboardingHr
                  .get(
                    `/onboarding/options?${org}&kind=assignment&workflowKind=OFFBOARDING&search=${fx.suffix}`,
                  )
                  .expect(200)
              ).body as Page;
              expect(ended.items.map((o) => o.id)).toContain(fx.orgLevel);
              const offboarding = (
                await offboardingHr
                  .post('/onboarding/workflows/offboarding', {
                    employmentAssignmentId: fx.orgLevel,
                    plannedEndDate: '2026-03-01',
                  })
                  .expect(201)
              ).body as { id: string; kind: string };
              expect(offboarding.kind).toBe('OFFBOARDING');

              // Q4 over HTTP: another organization's assignment and template read as missing.
              await outsider
                .post('/onboarding/workflows/onboarding', {
                  employmentAssignmentId: fx.assignmentTeamA,
                })
                .expect(404);
              await reader
                .post('/onboarding/workflows/onboarding', {
                  employmentAssignmentId: fx.assignmentTeamA,
                })
                .expect(403);
              const template = await tx.workflowTemplate.findFirstOrThrow({
                where: { organizationId: fx.orgA, kind: 'ONBOARDING' },
              });
              await outsider
                .post(`/onboarding/templates/${template.id}/archive`, {})
                .expect(404);
              await reader
                .post(`/onboarding/templates/${template.id}/archive`, {})
                .expect(403);
              // The dashboard of another organization stays refused.
              await outsider
                .get(`/onboarding/workflows?${org}&kind=ONBOARDING`)
                .expect(403);
            },
            [[OnboardingClock, onboardingClock]],
          );
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  });
});
