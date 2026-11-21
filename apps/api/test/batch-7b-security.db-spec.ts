import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  activeTemplate,
  cycleInput,
  failure,
  FixedPerformanceClock,
  openReview,
  PERFORMANCE_PERMISSION_KEYS,
  PERFORMANCE_USERS,
  performanceServices,
  type PerformanceServices,
} from './support/performance-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

/** Performance users plus Employee 1's own account holding every performance permission. */
const USERS = {
  ...PERFORMANCE_USERS,
  self1: [{ permissions: PERFORMANCE_PERMISSION_KEYS, scope: 'org' as const }],
};

const quizSource = (fx: SchedulingFixtures, overrides = {}) => ({
  organizationId: fx.orgA,
  code: 'coc-quiz-7b',
  name: 'Code of Conduct quiz',
  provider: 'GOOGLE_FORMS' as const,
  kind: 'ASSESSMENT' as const,
  externalResourceId: '1FAIpQLSf-7b-quiz',
  resourceTitle: 'Staff Code of Conduct Quiz',
  passThresholdPercent: '80',
  ...overrides,
});
const result = (id: string, overrides: Record<string, unknown> = {}) => ({
  externalResultId: id,
  completedAt: '2026-09-01T14:30:00Z',
  score: '17',
  maxScore: '20',
  ...overrides,
});
const emailOf = async (tx: Tx, userId: string) =>
  (await tx.user.findUniqueOrThrow({ where: { id: userId } })).email;

/**
 * Batch 7B — regression tests for the security findings of the Performance audit (S1–S3,
 * S5–S9; S4 is in batch-7b-google-identity). Each failed on the code before its fix.
 */
describe('Batch 7B performance security findings (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (
      tx: Tx,
      fx: SchedulingFixtures,
      svc: PerformanceServices,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS);
          const svc = performanceServices(
            rollbackClient(tx),
            new FixedPerformanceClock(),
          );
          await run(tx, fx, svc).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it("S1: a reviewer's unsubmitted overall rating never reaches read-only viewers", async () => {
    await scenario(async (tx, fx, svc) => {
      const o = await openReview(tx, svc, fx);
      await svc.reviews.saveAnswers(
        o.review.id,
        'REVIEWER',
        {
          answers: [{ itemId: o.items.communication, ratingValue: 4 }],
          overallRatingValue: 4,
        },
        o.reviewer,
      );
      // A performance.read viewer: no draft rating in the review or in the employee history.
      const read = await svc.reviews.detail(fx.users.reader!, o.review.id);
      expect(read.viewer).toBe('READER');
      expect(read.overallRating).toBeNull();
      const history = await svc.history.forEmployee(
        fx.users.reader!,
        fx.employee1,
      );
      expect(JSON.stringify(history)).not.toContain('Exceeds Expectations');
      // The reviewer and HR keep seeing it (drafts stay with the reviewer side and HR).
      expect(
        (await svc.reviews.detail(fx.selfUser2, o.review.id)).overallRating,
      ).toMatchObject({ value: 4 });
      expect(
        (await svc.reviews.detail(fx.users.hrAdmin!, o.review.id))
          .overallRating,
      ).toMatchObject({ value: 4 });
      // The employee: never before finalization.
      expect(
        (await svc.reviews.detail(fx.selfUser1, o.review.id)).overallRating,
      ).toBeNull();
      // Once the reviewer submits, readers see it.
      await svc.reviews.saveAnswers(
        o.review.id,
        'REVIEWER',
        {
          answers: [
            { itemId: o.items.reliability, ratingValue: 4 },
            { itemId: o.items.highlights, textValue: 'Strong year' },
          ],
        },
        o.reviewer,
      );
      await svc.reviews.submit(o.review.id, 'REVIEWER', o.reviewer);
      expect(
        (await svc.reviews.detail(fx.users.reader!, o.review.id)).overallRating,
      ).toMatchObject({ value: 4 });
    });
  });

  it('S2/D2: confidential HR evidence notes reach evidence managers and HR only', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.evidenceAdmin!);
      const manual = await svc.evidence.recordManual(
        {
          organizationId: fx.orgA,
          employeeId: fx.employee2,
          provider: 'CERTIFICATION',
          kind: 'CERTIFICATION',
          title: 'First Aid Level C',
          completedAt: '2026-05-20T12:00:00Z',
          notes: 'Confidential: certificate verified by phone',
        },
        admin,
      );
      const corrected = await svc.evidence.correct(
        manual.id,
        { title: 'First Aid Level C (CPR)', reason: 'Course name' },
        admin,
      );
      const secret = 'Confidential: certificate verified by phone';
      // The employee: neither their list nor the history carries the note.
      expect(
        JSON.stringify(await svc.evidence.mine(fx.selfUser2)),
      ).not.toContain(secret);
      expect(
        JSON.stringify(await svc.evidence.history(fx.selfUser2, corrected.id)),
      ).not.toContain(secret);
      // A performance.read viewer: neither.
      expect(
        JSON.stringify(
          await svc.evidence.forEmployee(fx.users.reader!, fx.employee2),
        ),
      ).not.toContain(secret);
      expect(
        JSON.stringify(
          await svc.evidence.history(fx.users.reader!, corrected.id),
        ),
      ).not.toContain(secret);
      // Evidence managers and HR (performance.evidence.manage) see it.
      for (const user of ['evidenceAdmin', 'hrAdmin']) {
        expect(
          (await svc.evidence.history(fx.users[user]!, corrected.id)).items,
        ).toEqual(
          expect.arrayContaining([expect.objectContaining({ notes: secret })]),
        );
      }
      expect(
        (await svc.evidence.forEmployee(fx.users.hrAdmin!, fx.employee2))
          .items[0],
      ).toMatchObject({ notes: secret });
      void tx;
    });
  });

  it('S3/D3: imports never record one’s own evidence, overwrite synced results or carry future timestamps', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.evidenceAdmin!);
      const source = await svc.evidence.createSource(quizSource(fx), admin);
      const ownEmail = await emailOf(tx, fx.selfUser1);
      // Employee 1 holds evidence management: importing their own result is refused per row.
      const own = await svc.evidence.ingest(
        source.id,
        [
          result('own-email', { respondentEmail: ownEmail }),
          result('own-id', { employeeId: fx.employee1 }),
        ],
        'IMPORT',
        fx.selfUser1,
      );
      expect(own.outcomes.map((o) => [o.outcome, o.reason])).toEqual([
        ['REJECTED', 'PERFORMANCE_SELF_EVIDENCE'],
        ['REJECTED', 'PERFORMANCE_SELF_EVIDENCE'],
      ]);
      expect(
        await tx.performanceEvidence.count({
          where: { employeeId: fx.employee1 },
        }),
      ).toBe(0);
      // A synchronized result cannot be overwritten or withdrawn by an import.
      const colleague = await emailOf(tx, fx.selfUser2);
      await svc.evidence.ingest(
        source.id,
        [
          result('r1', {
            respondentEmail: colleague,
            externalUpdatedAt: '2026-09-01T15:00:00Z',
          }),
        ],
        'SYNC',
        null,
      );
      for (const attempt of [
        result('r1', { respondentEmail: colleague, score: '20' }),
        result('r1', { respondentEmail: colleague, withdrawn: true }),
      ]) {
        const imported = await svc.evidence.ingest(
          source.id,
          [attempt],
          'IMPORT',
          fx.users.evidenceAdmin!,
        );
        expect(imported.outcomes[0]).toMatchObject({
          outcome: 'REJECTED',
          reason: 'PERFORMANCE_SYNCED_RESULT',
        });
      }
      const current = await tx.performanceEvidence.findFirstOrThrow({
        where: { externalResultId: 'r1', supersededAt: null },
      });
      expect([
        current.revision,
        current.status,
        current.score?.toFixed(0),
      ]).toEqual([1, 'ACTIVE', '17']);
      // A future external update time is refused (it would freeze the result: later
      // genuine corrections would look stale) — on import and on sync.
      for (const channel of ['IMPORT', 'SYNC'] as const) {
        const future = await svc.evidence.ingest(
          source.id,
          [
            result('r1', {
              respondentEmail: colleague,
              score: '19',
              externalUpdatedAt: '2031-01-01T00:00:00Z',
            }),
          ],
          channel,
          channel === 'IMPORT' ? fx.users.evidenceAdmin! : null,
        );
        expect(future.outcomes[0]).toMatchObject({
          outcome: 'REJECTED',
          reason: 'PERFORMANCE_EVIDENCE_UPDATED_IN_FUTURE',
        });
      }
      // A genuine later correction from the source still applies.
      const regraded = await svc.evidence.ingest(
        source.id,
        [
          result('r1', {
            respondentEmail: colleague,
            score: '19',
            externalUpdatedAt: '2026-09-02T09:00:00Z',
          }),
        ],
        'SYNC',
        null,
      );
      expect(regraded.counts.CORRECTED).toBe(1);
      // Imports may still correct what an import created.
      await svc.evidence.ingest(
        source.id,
        [result('i1', { respondentEmail: colleague })],
        'IMPORT',
        fx.users.evidenceAdmin!,
      );
      const reimport = await svc.evidence.ingest(
        source.id,
        [result('i1', { respondentEmail: colleague, score: '18' })],
        'IMPORT',
        fx.users.evidenceAdmin!,
      );
      expect(reimport.counts.CORRECTED).toBe(1);
    });
  });

  it('S5/D4: cycle-level operations never add, remove or close the actor’s own review', async () => {
    await scenario(async (tx, fx, svc) => {
      const { template } = await activeTemplate(svc, fx);
      const self = ctx(fx.selfUser1);
      const cycle = await svc.cycles.create(cycleInput(fx, template.id), self);
      // Everyone in the organization: Employee 1's own assignments are left out and reported.
      const all = await svc.cycles.addReviews(
        cycle.id,
        { allInOrganization: true },
        self,
      );
      expect(all.excludedOwn).toBe(2);
      // Targeted: the own assignment is excluded, the colleague's is added.
      const targeted = await svc.cycles.addReviews(
        cycle.id,
        { assignmentIds: [fx.assignmentTeamA, fx.otherTeamA] },
        self,
      );
      expect(targeted).toMatchObject({ excludedOwn: 1 });
      const own = await tx.performanceReview.count({
        where: { cycleId: cycle.id, employeeId: fx.employee1 },
      });
      expect(own).toBe(0);
      // Another cycle manager adds Employee 1; Employee 1 cannot remove their own review.
      const admin = ctx(fx.users.cycleAdmin!);
      await svc.cycles.addReviews(
        cycle.id,
        { assignmentIds: [fx.assignmentTeamA] },
        admin,
      );
      const ownReview = await tx.performanceReview.findFirstOrThrow({
        where: {
          cycleId: cycle.id,
          employmentAssignmentId: fx.assignmentTeamA,
        },
      });
      expect(
        await failure(svc.cycles.removeReview(cycle.id, ownReview.id, self)),
      ).toEqual({ status: 403, code: 'PERFORMANCE_SELF_MANAGEMENT' });
      // Nor close the cycle when that closes their own incomplete review.
      await svc.cycles.open(cycle.id, admin);
      expect(
        await failure(
          svc.cycles.close(
            cycle.id,
            { closeIncomplete: true, reason: 'Window ended' },
            self,
          ),
        ),
      ).toEqual({ status: 403, code: 'PERFORMANCE_SELF_MANAGEMENT' });
      expect(
        (
          await tx.performanceReview.findUniqueOrThrow({
            where: { id: ownReview.id },
          })
        ).status,
      ).not.toBe('CLOSED');
      // Another cycle manager may.
      await svc.cycles.close(
        cycle.id,
        { closeIncomplete: true, reason: 'Window ended' },
        admin,
      );
    });
  });

  it('S6/D8: another organization’s performance records answer 404; same-organization refusals stay 403', async () => {
    await scenario(async (tx, fx, svc) => {
      const o = await openReview(tx, svc, fx);
      const evidenceAdmin = ctx(fx.users.evidenceAdmin!);
      const source = await svc.evidence.createSource(
        quizSource(fx),
        evidenceAdmin,
      );
      const evidence = await svc.evidence.recordManual(
        {
          organizationId: fx.orgA,
          employeeId: fx.employee2,
          provider: 'TRAINING',
          kind: 'TRAINING',
          title: 'Safety training',
          completedAt: '2026-05-20T12:00:00Z',
        },
        evidenceAdmin,
      );
      const intake = (
        await svc.evidence.ingest(
          source.id,
          [result('unknown', { respondentEmail: 'nobody@example.com' })],
          'IMPORT',
          fx.users.evidenceAdmin!,
        )
      ).outcomes[0]!.intakeId!;
      const goal = await svc.goals.create(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          title: 'Mentor a new teacher',
          startDate: '2026-01-15',
        },
        o.self,
      );
      const draftCycle = await svc.cycles.create(
        cycleInput(fx, o.template.id, { code: 'draft-7b' }),
        ctx(fx.users.cycleAdmin!),
      );
      type Call = (userId: string) => Promise<unknown>;
      const cases: [string, Call][] = [
        ['cycle detail', (u) => svc.cycles.detail(u, o.cycle.id)],
        ['cycle reviews', (u) => svc.cycles.reviews(u, o.cycle.id)],
        [
          'cycle update',
          (u) => svc.cycles.update(draftCycle.id, { name: 'X' }, ctx(u)),
        ],
        ['cycle discard', (u) => svc.cycles.discard(draftCycle.id, ctx(u))],
        [
          'cycle add',
          (u) =>
            svc.cycles.addReviews(
              draftCycle.id,
              { allInOrganization: true },
              ctx(u),
            ),
        ],
        ['cycle open', (u) => svc.cycles.open(draftCycle.id, ctx(u))],
        [
          'cycle close',
          (u) =>
            svc.cycles.close(
              o.cycle.id,
              { closeIncomplete: true, reason: 'x' },
              ctx(u),
            ),
        ],
        ['review detail', (u) => svc.reviews.detail(u, o.review.id)],
        [
          'review reassign',
          (u) =>
            svc.reviews.reassignReviewer(
              o.review.id,
              { reviewerEmployeeId: null, reason: 'x' },
              ctx(u),
            ),
        ],
        ['review finalize', (u) => svc.lifecycle.finalize(o.review.id, ctx(u))],
        [
          'competency update',
          (u) =>
            svc.config.updateCompetency(o.competency.id, { name: 'X' }, ctx(u)),
        ],
        [
          'scale update',
          (u) => svc.config.updateScale(o.scale.id, { name: 'X' }, ctx(u)),
        ],
        ['template detail', (u) => svc.config.template(u, o.template.id)],
        [
          'template update',
          (u) =>
            svc.config.updateTemplate(o.template.id, { name: 'X' }, ctx(u)),
        ],
        [
          'template copy',
          (u) =>
            svc.config.copyTemplate(o.template.id, { code: 'COPY-7B' }, ctx(u)),
        ],
        [
          'source update',
          (u) => svc.evidence.updateSource(source.id, { name: 'X' }, ctx(u)),
        ],
        [
          'source import',
          (u) => svc.evidence.ingest(source.id, [], 'IMPORT', u),
        ],
        [
          'intake resolve',
          (u) =>
            svc.evidence.resolveIntake(
              intake,
              { action: 'REJECT', note: 'x' } as never,
              ctx(u),
            ),
        ],
        [
          'evidence withdraw',
          (u) => svc.evidence.withdraw(evidence.id, { reason: 'x' }, ctx(u)),
        ],
        ['evidence history', (u) => svc.evidence.history(u, evidence.id)],
        [
          'goal update',
          (u) => svc.goals.update(goal.id, { title: 'X' }, ctx(u)),
        ],
      ];
      for (const [name, call] of cases) {
        expect([
          name,
          (await failure(call(fx.users.orgBAdmin!))).status,
        ]).toEqual([name, 404]);
      }
      // Same organization without the permission: still 403 for writes.
      for (const [name, call] of cases.filter(
        ([name]) =>
          ![
            'cycle detail',
            'cycle reviews',
            'review detail',
            'template detail',
            'evidence history',
          ].includes(name),
      )) {
        expect([name, (await failure(call(fx.users.reader!))).status]).toEqual([
          name,
          403,
        ]);
      }
    });
  });

  it('S7: a reviewer cannot write goals while Performance is switched off', async () => {
    await scenario(async (tx, fx, svc) => {
      const o = await openReview(tx, svc, fx);
      await tx.organizationModuleSetting.create({
        data: {
          organizationId: fx.orgA,
          module: 'PERFORMANCE',
          enabled: false,
        },
      });
      expect(
        await failure(
          svc.goals.create(
            {
              employmentAssignmentId: fx.assignmentTeamA,
              title: 'Set by the reviewer',
              startDate: '2026-01-15',
            },
            o.reviewer,
          ),
        ),
      ).toMatchObject({ status: 403, code: 'FEATURE_DISABLED' });
    });
  });

  it('S8: cycle review counts cover only the reviews the viewer may read', async () => {
    await scenario(async (tx, fx, svc) => {
      const { template } = await activeTemplate(svc, fx);
      const admin = ctx(fx.users.cycleAdmin!);
      const cycle = await svc.cycles.create(cycleInput(fx, template.id), admin);
      await svc.cycles.addReviews(
        cycle.id,
        { assignmentIds: [fx.assignmentTeamA, fx.assignmentDeptB] },
        admin,
      );
      const counts = async (user: string) =>
        (await svc.cycles.list(fx.users[user]!, fx.orgA)).items.find(
          (c) => c.id === cycle.id,
        )!.reviewCounts;
      expect(await counts('hrAdmin')).toEqual({ NOT_STARTED: 2 });
      // Team A's manager reads Team A only.
      expect(await counts('teamManager')).toEqual({ NOT_STARTED: 1 });
      // Configuration-only administrators see the cycle without review counts.
      expect(await counts('templateAdmin')).toEqual({});
      void tx;
    });
  });

  it('S9/D6: a scale or competency used by an active template cannot be archived', async () => {
    await scenario(async (tx, fx, svc) => {
      const { admin, scale, competency, template } = await activeTemplate(
        svc,
        fx,
      );
      for (const attempt of [
        svc.config.archiveCompetency(competency.id, admin),
        svc.config.transitionScale(scale.id, 'ARCHIVED', admin),
      ]) {
        expect(await failure(attempt)).toEqual({
          status: 409,
          code: 'PERFORMANCE_CONFIG_IN_USE',
        });
      }
      const refusal = await svc.config
        .transitionScale(scale.id, 'ARCHIVED', admin)
        .catch((error: { getResponse(): { templates?: unknown[] } }) =>
          error.getResponse(),
        );
      expect(refusal).toMatchObject({
        templates: [
          { id: template.id, code: template.code, name: template.name },
        ],
      });
      // Once the template is archived, they can be archived.
      await svc.config.transitionTemplate(template.id, 'ARCHIVED', admin);
      await svc.config.archiveCompetency(competency.id, admin);
      await svc.config.transitionScale(scale.id, 'ARCHIVED', admin);
      void tx;
    });
  });

  it('review fixes: a synced result never changes from an unverified or mismatched identity; goal creation 404 across organizations; reviewers get no HR notes', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.evidenceAdmin!);
      const source = await svc.evidence.createSource(quizSource(fx), admin);
      const colleague = await emailOf(tx, fx.selfUser2);
      await svc.evidence.ingest(
        source.id,
        [result('r1', { respondentEmail: colleague })],
        'SYNC',
        null,
      );
      // The form stops verifying emails: the response arrives without a trusted identity.
      const unverified = await svc.evidence.ingest(
        source.id,
        [result('r1', { respondentEmail: null, score: '20' })],
        'SYNC',
        null,
      );
      expect(unverified.outcomes[0]).toMatchObject({
        outcome: 'REJECTED',
        reason: 'PERFORMANCE_IDENTITY_UNVERIFIED',
      });
      // Someone else's verified identity never changes it either.
      const mismatched = await svc.evidence.ingest(
        source.id,
        [
          result('r1', {
            respondentEmail: await emailOf(tx, fx.selfUser1),
            score: '20',
          }),
        ],
        'SYNC',
        null,
      );
      expect(mismatched.outcomes[0]).toMatchObject({
        outcome: 'REJECTED',
        reason: 'PERFORMANCE_IDENTITY_MISMATCH',
      });
      expect(
        (
          await tx.performanceEvidence.findFirstOrThrow({
            where: { externalResultId: 'r1', supersededAt: null },
          })
        ).score?.toFixed(0),
      ).toBe('17');
      // The respondent's own verified correction applies.
      expect(
        (
          await svc.evidence.ingest(
            source.id,
            [result('r1', { respondentEmail: colleague, score: '19' })],
            'SYNC',
            null,
          )
        ).counts.CORRECTED,
      ).toBe(1);
      // Goal creation on another organization's assignment reads as missing.
      expect(
        await failure(
          svc.goals.create(
            {
              employmentAssignmentId: fx.assignmentTeamA,
              title: 'Probe',
              startDate: '2026-01-15',
            },
            ctx(fx.users.orgBAdmin!),
          ),
        ),
      ).toMatchObject({ status: 404 });
      // An ordinary reviewer (no performance.read) never receives HR notes.
      const o = await openReview(tx, svc, fx);
      await svc.evidence.recordManual(
        {
          organizationId: fx.orgA,
          employeeId: fx.employee1,
          provider: 'CERTIFICATION',
          kind: 'CERTIFICATION',
          title: 'First Aid',
          completedAt: '2026-05-20T12:00:00Z',
          notes: 'Reviewer must not see this',
        },
        admin,
      );
      expect(
        JSON.stringify(
          await svc.evidence.forEmployee(fx.selfUser2, fx.employee1),
        ),
      ).not.toContain('Reviewer must not see this');
      void o;
    });
  });
});
