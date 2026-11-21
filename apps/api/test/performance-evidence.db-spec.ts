import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import type {
  ExternalAssessmentProvider,
  ExternalAssessmentResult,
} from '../src/performance/performance-evidence.contract.js';
import { syncPerformanceEvidence } from '../src/performance/performance-jobs.js';
import {
  failure,
  FixedPerformanceClock,
  openReview,
  orgBAssignment,
  PERFORMANCE_USERS,
  performanceServices,
  type PerformanceServices,
} from './support/performance-fixtures.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
  type UserSpec,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const quizSource = (fx: SchedulingFixtures, overrides = {}) => ({
  organizationId: fx.orgA,
  code: 'coc-quiz-2026',
  name: 'Code of Conduct quiz',
  provider: 'GOOGLE_FORMS' as const,
  kind: 'ASSESSMENT' as const,
  externalResourceId: '1FAIpQLSf-code-of-conduct',
  resourceTitle: 'Staff Code of Conduct Quiz 2026',
  passThresholdPercent: '80',
  ...overrides,
});

const result = (
  id: string,
  overrides: Partial<ExternalAssessmentResult> = {},
) => ({
  externalResultId: id,
  completedAt: '2026-09-01T14:30:00Z',
  score: '17',
  maxScore: '20',
  ...overrides,
});

describe('Performance evidence and external assessments (database)', () => {
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
    users: Record<string, UserSpec[]> = PERFORMANCE_USERS,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, users);
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

  const emailOf = async (tx: Tx, userId: string) =>
    (await tx.user.findUniqueOrThrow({ where: { id: userId } })).email;

  it('configures evidence sources with organization-level permission', async () => {
    await scenario(async (_tx, fx, svc) => {
      const admin = ctx(fx.users.evidenceAdmin!);
      for (const user of [
        'reader',
        'teamManager',
        'templateAdmin',
        'hr',
        'orgBAdmin',
      ]) {
        expect(
          await failure(
            svc.evidence.createSource(quizSource(fx), ctx(fx.users[user]!)),
          ),
        ).toMatchObject({ status: 403 });
      }
      expect(
        await failure(
          svc.evidence.createSource(
            quizSource(fx, { externalResourceId: null }),
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'PERFORMANCE_SOURCE_RESOURCE_REQUIRED' });
      const source = await svc.evidence.createSource(quizSource(fx), admin);
      expect(source).toMatchObject({
        code: 'COC-QUIZ-2026',
        passThresholdPercent: '80.00',
      });
      // One source per external form in an organization.
      expect(
        await failure(
          svc.evidence.createSource(quizSource(fx, { code: 'again' }), admin),
        ),
      ).toEqual({ status: 409, code: 'PERFORMANCE_SOURCE_EXISTS' });
      // The same form may be a source of another organization (its own results only).
      await svc.evidence.createSource(
        quizSource(fx, { organizationId: fx.orgB }),
        ctx(fx.users.orgBAdmin!),
      );
      expect(
        await failure(svc.evidence.sources(fx.users.reader!, fx.orgA)),
      ).toMatchObject({
        status: 403,
      });
    });
  });

  it('consumes Google Forms quiz results idempotently, mapping them to employees', async () => {
    await scenario(async (tx, fx, svc) => {
      const source = await svc.evidence.createSource(
        quizSource(fx),
        ctx(fx.users.evidenceAdmin!),
      );
      const employee1 = await emailOf(tx, fx.selfUser1);
      const employee2 = await emailOf(tx, fx.selfUser2);
      const first = await svc.evidence.ingest(
        source.id,
        [
          // Matched by (case-insensitive) email; Employee 1 has two assignments: none inferred.
          result('r1', {
            respondentEmail: employee1.toUpperCase(),
            title: 'Code of Conduct Quiz',
          }),
          // Nobody with that email: waits for HR.
          result('r2', { respondentEmail: 'former.address@example.org' }),
          // Pre-mapped with the assignment.
          result('r3', {
            respondentEmail: employee2,
            employmentAssignmentId: fx.otherTeamA,
          }),
          // An ungraded completion is still evidence.
          result('r4', {
            respondentEmail: employee2,
            score: null,
            maxScore: null,
          }),
          // Invalid rows are rejected alone.
          result('r5', {
            respondentEmail: employee1,
            completedAt: 'yesterday',
          }),
          result('r6', { respondentEmail: employee1, score: '21' }),
        ],
        'SYNC',
        null,
      );
      expect(first.counts).toMatchObject({
        CREATED: 3,
        PENDING_MATCH: 1,
        REJECTED: 2,
      });
      expect(
        first.outcomes.find((o) => o.externalResultId === 'r5'),
      ).toMatchObject({
        reason: 'PERFORMANCE_EVIDENCE_DATE_INVALID',
      });
      const r1 = await tx.performanceEvidence.findFirstOrThrow({
        where: { externalResultId: 'r1' },
      });
      expect(r1).toMatchObject({
        employeeId: fx.employee1,
        employmentAssignmentId: null,
        title: 'Code of Conduct Quiz',
        channel: 'SYNC',
        revision: 1,
      });
      expect([
        r1.percentage?.toFixed(2),
        r1.passed,
        r1.passThresholdPercent?.toFixed(2),
      ]).toEqual(['85.00', true, '80.00']);
      const r3 = await tx.performanceEvidence.findFirstOrThrow({
        where: { externalResultId: 'r3' },
      });
      expect(r3.employmentAssignmentId).toBe(fx.otherTeamA);
      const r4 = await tx.performanceEvidence.findFirstOrThrow({
        where: { externalResultId: 'r4' },
      });
      expect([r4.score, r4.percentage, r4.passed]).toEqual([null, null, null]);
      // The same deliveries again (webhook retry, re-poll): nothing new.
      const again = await svc.evidence.ingest(
        source.id,
        [
          result('r1', {
            respondentEmail: employee1,
            title: 'Code of Conduct Quiz',
          }),
          result('r2', { respondentEmail: 'former.address@example.org' }),
        ],
        'SYNC',
        null,
      );
      expect(again.counts).toMatchObject({ UNCHANGED: 1, PENDING_MATCH: 1 });
      expect(
        await tx.performanceEvidence.count({ where: { sourceId: source.id } }),
      ).toBe(3);
      expect(
        await tx.performanceEvidenceIntake.count({
          where: { sourceId: source.id },
        }),
      ).toBe(1);
      expect(
        await tx.performanceEvidenceSource.findUniqueOrThrow({
          where: { id: source.id },
        }),
      ).toMatchObject({ lastSyncStatus: 'OK' });
      // Nothing personal reaches the audit trail.
      const audit = await tx.auditLog.findMany({
        where: { entityId: source.id },
      });
      expect(JSON.stringify(audit.map((row) => row.metadata))).not.toContain(
        '@',
      );
      // Imports need performance.evidence.manage at the organization.
      expect(
        await failure(
          svc.evidence.ingest(source.id, [], 'IMPORT', fx.users.reader!),
        ),
      ).toMatchObject({ status: 403 });
    });
  });

  it('keeps results meaningful through corrections, renames, threshold changes and withdrawal', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.evidenceAdmin!);
      const source = await svc.evidence.createSource(quizSource(fx), admin);
      const email = await emailOf(tx, fx.selfUser1);
      await svc.evidence.ingest(
        source.id,
        [
          result('r1', {
            respondentEmail: email,
            externalUpdatedAt: '2026-09-01T15:00:00Z',
          }),
        ],
        'SYNC',
        null,
      );
      // The form is renamed and the threshold raised: history keeps title and judgement.
      await svc.evidence.updateSource(
        source.id,
        { resourceTitle: 'Renamed quiz', passThresholdPercent: '95' },
        admin,
      );
      // Regraded at the source: a new revision, judged by the original threshold.
      const regraded = await svc.evidence.ingest(
        source.id,
        [
          result('r1', {
            respondentEmail: email,
            score: '19',
            externalUpdatedAt: '2026-09-02T09:00:00Z',
          }),
        ],
        'SYNC',
        null,
      );
      expect(regraded.counts.CORRECTED).toBe(1);
      const current = await tx.performanceEvidence.findFirstOrThrow({
        where: { externalResultId: 'r1', supersededAt: null },
      });
      expect([
        current.revision,
        current.title,
        current.score?.toFixed(2),
        current.percentage?.toFixed(2),
        current.passThresholdPercent?.toFixed(2),
        current.passed,
        current.correctionReason,
      ]).toEqual([
        2,
        'Staff Code of Conduct Quiz 2026',
        '19.00',
        '95.00',
        '80.00',
        true,
        'Corrected at the source',
      ]);
      // An out-of-order older delivery is ignored.
      const stale = await svc.evidence.ingest(
        source.id,
        [
          result('r1', {
            respondentEmail: email,
            score: '10',
            externalUpdatedAt: '2026-09-01T16:00:00Z',
          }),
        ],
        'SYNC',
        null,
      );
      expect(stale.counts.STALE).toBe(1);
      // Deleted at the source: withdrawn, kept; the same content again does not revive it.
      await svc.evidence.ingest(
        source.id,
        [result('r1', { withdrawn: true })],
        'SYNC',
        null,
      );
      expect(
        (
          await tx.performanceEvidence.findUniqueOrThrow({
            where: { id: current.id },
          })
        ).status,
      ).toBe('WITHDRAWN');
      const replay = await svc.evidence.ingest(
        source.id,
        [
          result('r1', {
            respondentEmail: email,
            score: '19',
            externalUpdatedAt: '2026-09-02T09:00:00Z',
          }),
        ],
        'SYNC',
        null,
      );
      expect(replay.counts.UNCHANGED).toBe(1);
      const history = await svc.evidence.history(fx.users.reader!, current.id);
      expect(history.items.map((item) => [item.revision, item.status])).toEqual(
        [
          [1, 'ACTIVE'],
          [2, 'WITHDRAWN'],
        ],
      );
      // Archived sources take no more results.
      await svc.evidence.archiveSource(source.id, admin);
      expect(
        await failure(svc.evidence.ingest(source.id, [], 'SYNC', null)),
      ).toEqual({
        status: 409,
        code: 'PERFORMANCE_SOURCE_ARCHIVED',
      });
    });
  });

  it('lets HR match or reject unmatched results, inside the source organization only', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.evidenceAdmin!);
      const source = await svc.evidence.createSource(quizSource(fx), admin);
      const orgBSource = await svc.evidence.createSource(
        quizSource(fx, { organizationId: fx.orgB }),
        ctx(fx.users.orgBAdmin!),
      );
      // Employee 1 works only in organization A.
      const email = await emailOf(tx, fx.selfUser1);
      const orgB = await svc.evidence.ingest(
        orgBSource.id,
        [
          result('b1', { respondentEmail: email }),
          result('b2', { employeeId: fx.employee1 }),
        ],
        'SYNC',
        null,
      );
      expect(orgB.outcomes.map((o) => [o.outcome, o.reason])).toEqual([
        ['PENDING_MATCH', 'EMPLOYEE_NOT_IN_ORGANIZATION'],
        ['REJECTED', 'EMPLOYEE_NOT_IN_ORGANIZATION'],
      ]);
      await svc.evidence.ingest(
        source.id,
        [
          result('u1', { respondentEmail: 'old.email@example.org' }),
          result('u2', {}),
        ],
        'SYNC',
        null,
      );
      const pending = await svc.evidence.intake(
        fx.users.evidenceAdmin!,
        fx.orgA,
      );
      expect(
        pending.items
          .map((item) => [item.externalResultId, item.reason])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ).toEqual([
        ['u1', 'NO_MATCHING_EMPLOYEE'],
        ['u2', 'NO_RESPONDENT_EMAIL'],
      ]);
      const u1 = pending.items.find((item) => item.externalResultId === 'u1')!;
      const u2 = pending.items.find((item) => item.externalResultId === 'u2')!;
      // The employee changed their email: HR matches the result to them (and an assignment).
      expect(
        await failure(
          svc.evidence.resolveIntake(
            u1.id,
            {
              action: 'MATCH',
              employeeId: fx.employee1,
              employmentAssignmentId: fx.otherTeamA,
            },
            admin,
          ),
        ),
      ).toEqual({
        status: 400,
        code: 'PERFORMANCE_EVIDENCE_ASSIGNMENT_INVALID',
      });
      const matched = await svc.evidence.resolveIntake(
        u1.id,
        {
          action: 'MATCH',
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentTeamA,
          note: 'Email changed',
        },
        admin,
      );
      expect(matched.status).toBe('MATCHED');
      expect(
        await failure(
          svc.evidence.resolveIntake(
            u1.id,
            { action: 'REJECT', note: 'x' },
            admin,
          ),
        ),
      ).toEqual({ status: 409, code: 'PERFORMANCE_INTAKE_RESOLVED' });
      await svc.evidence.resolveIntake(
        u2.id,
        { action: 'REJECT', note: 'Test submission' },
        admin,
      );
      // Later deliveries follow the decisions.
      const later = await svc.evidence.ingest(
        source.id,
        [
          result('u1', { respondentEmail: 'old.email@example.org' }),
          result('u2', {}),
        ],
        'SYNC',
        null,
      );
      expect(later.outcomes.map((o) => [o.outcome, o.reason ?? null])).toEqual([
        ['UNCHANGED', null],
        ['REJECTED', 'PREVIOUSLY_REJECTED'],
      ]);
      expect(
        await tx.performanceEvidence.findUniqueOrThrow({
          where: { id: matched.evidenceId! },
        }),
      ).toMatchObject({
        employeeId: fx.employee1,
        employmentAssignmentId: fx.assignmentTeamA,
      });
      // Another organization's evidence manager never touches organization A's queue (Batch 7B
      // D8: it reads as missing).
      expect(
        await failure(
          svc.evidence.resolveIntake(
            u1.id,
            { action: 'REJECT', note: 'x' },
            ctx(fx.users.orgBAdmin!),
          ),
        ),
      ).toMatchObject({ status: 404 });
      expect(await orgBAssignment(tx, fx)).toBeTruthy();
    });
  });

  it("records, corrects, re-maps and withdraws evidence with history, never one's own", async () => {
    await scenario(
      async (tx, fx, svc) => {
        const admin = ctx(fx.users.evidenceAdmin!);
        const manual = await svc.evidence.recordManual(
          {
            organizationId: fx.orgA,
            employeeId: fx.employee2,
            provider: 'CERTIFICATION',
            kind: 'CERTIFICATION',
            title: 'First Aid Level C',
            completedAt: '2026-05-20T12:00:00Z',
            notes: 'Certificate on file',
          },
          admin,
        );
        expect(manual).toMatchObject({
          channel: 'MANUAL',
          revision: 1,
          notes: 'Certificate on file',
        });
        // Self protection: Employee 1 (with evidence management) never records their own.
        expect(
          await failure(
            svc.evidence.recordManual(
              {
                organizationId: fx.orgA,
                employeeId: fx.employee1,
                provider: 'TRAINING',
                kind: 'TRAINING',
                title: 'Mine',
                completedAt: '2026-05-20T12:00:00Z',
              },
              ctx(fx.selfUser1),
            ),
          ),
        ).toEqual({ status: 403, code: 'PERFORMANCE_SELF_MANAGEMENT' });
        const corrected = await svc.evidence.correct(
          manual.id,
          {
            title: 'First Aid Level C (CPR)',
            reason: 'Typo in the course name',
          },
          admin,
        );
        expect(corrected).toMatchObject({
          revision: 2,
          title: 'First Aid Level C (CPR)',
        });
        expect(
          await failure(
            svc.evidence.correct(manual.id, { reason: 'again' }, admin),
          ),
        ).toEqual({ status: 409, code: 'PERFORMANCE_EVIDENCE_SUPERSEDED' });
        // External results are corrected at the source, but can be re-matched here.
        const source = await svc.evidence.createSource(quizSource(fx), admin);
        const email = await emailOf(tx, fx.selfUser2);
        const imported = await svc.evidence.ingest(
          source.id,
          [result('r1', { respondentEmail: email })],
          'SYNC',
          null,
        );
        const evidenceId = imported.outcomes[0]!.evidenceId!;
        expect(
          await failure(
            svc.evidence.correct(
              evidenceId,
              { score: '20', reason: 'x' },
              admin,
            ),
          ),
        ).toEqual({ status: 409, code: 'PERFORMANCE_EVIDENCE_EXTERNAL' });
        // Shared family email matched the wrong person: it was Employee 1's attempt.
        const remapped = await svc.evidence.remap(
          evidenceId,
          {
            employeeId: fx.employee1,
            employmentAssignmentId: fx.assignmentTeamA,
            reason: 'Shared email',
          },
          ctx(fx.users.templateAdminWithEvidence!),
        );
        expect(remapped).toMatchObject({
          employeeId: fx.employee1,
          revision: 2,
        });
        // The next sync keeps the HR re-match (same content: unchanged).
        expect(
          (
            await svc.evidence.ingest(
              source.id,
              [result('r1', { respondentEmail: email })],
              'SYNC',
              null,
            )
          ).counts.UNCHANGED,
        ).toBe(1);
        const withdrawn = await svc.evidence.withdraw(
          corrected.id,
          { reason: 'Certificate revoked' },
          admin,
        );
        expect(withdrawn).toMatchObject({
          status: 'WITHDRAWN',
          withdrawalReason: 'Certificate revoked',
        });
        // Readers: the employee sees their evidence without HR notes; HR access is not enough.
        const mine = await svc.evidence.mine(fx.selfUser2);
        expect(mine.items.map((item) => item.title)).toEqual([
          'First Aid Level C (CPR)',
        ]);
        expect(mine.items[0]).not.toHaveProperty('notes');
        // Batch 7B (D2): HR notes are for evidence managers and HR only, not readers.
        expect(
          (await svc.evidence.forEmployee(fx.users.reader!, fx.employee2))
            .items[0],
        ).not.toHaveProperty('notes');
        expect(
          (
            await svc.evidence.forEmployee(
              fx.users.evidenceAdmin!,
              fx.employee2,
            )
          ).items[0],
        ).toMatchObject({ notes: 'Certificate on file' });
        expect(
          await failure(svc.evidence.forEmployee(fx.users.hr!, fx.employee2)),
        ).toMatchObject({
          status: 403,
        });
        expect(
          await failure(
            svc.evidence.forEmployee(fx.users.orgBAdmin!, fx.employee2),
          ),
        ).toMatchObject({ status: 403 });
      },
      {
        ...PERFORMANCE_USERS,
        self1: [{ permissions: ['performance.evidence.manage'], scope: 'org' }],
        templateAdminWithEvidence: [
          { permissions: ['performance.evidence.manage'], scope: 'org' },
        ],
      },
    );
  });

  it('links evidence into reviews as supporting input, never into the score', async () => {
    await scenario(async (tx, fx, svc) => {
      const { review, items, reviewer, self } = await openReview(tx, svc, fx);
      const admin = ctx(fx.users.evidenceAdmin!);
      const source = await svc.evidence.createSource(quizSource(fx), admin);
      const email = await emailOf(tx, fx.selfUser1);
      const quiz = (
        await svc.evidence.ingest(
          source.id,
          [result('r1', { respondentEmail: email })],
          'SYNC',
          null,
        )
      ).outcomes[0]!.evidenceId!;
      const deptB = await svc.evidence.recordManual(
        {
          organizationId: fx.orgA,
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentDeptB,
          provider: 'TRAINING',
          kind: 'TRAINING',
          title: 'Dept B safety',
          completedAt: '2026-06-01T12:00:00Z',
        },
        admin,
      );
      // The active reviewer reads the employee's evidence to choose what to link.
      expect(
        (await svc.evidence.forEmployee(fx.selfUser2, fx.employee1)).items
          .map((e) => e.id)
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual([quiz, deptB.id].sort((a, b) => a.localeCompare(b)));
      expect(
        await failure(svc.evidence.link(review.id, { evidenceId: quiz }, self)),
      ).toMatchObject({
        status: 403,
      });
      expect(
        await failure(
          svc.evidence.link(review.id, { evidenceId: deptB.id }, reviewer),
        ),
      ).toEqual({ status: 400, code: 'PERFORMANCE_EVIDENCE_OTHER_ASSIGNMENT' });
      expect(
        await failure(
          svc.evidence.link(
            review.id,
            { evidenceId: quiz, formItemId: items.highlights },
            reviewer,
          ),
        ),
      ).toEqual({ status: 400, code: 'PERFORMANCE_ITEM_NOT_EVIDENCE' });
      const { linkId } = await svc.evidence.link(
        review.id,
        { evidenceId: quiz, formItemId: items.evidence },
        reviewer,
      );
      // Rate: the score is the reviewer's ratings only.
      const rated = await svc.reviews.saveAnswers(
        review.id,
        'REVIEWER',
        {
          answers: [
            { itemId: items.communication, ratingValue: 3 },
            { itemId: items.reliability, ratingValue: 3 },
          ],
        },
        reviewer,
      );
      expect(rated.calculatedScore).toBe('3.00');
      expect(rated.evidence).toEqual([
        expect.objectContaining({
          linkId,
          title: 'Staff Code of Conduct Quiz 2026',
          percentage: '85.00',
          passed: true,
          changedSinceLinked: false,
        }),
      ]);
      // A later correction at the source is flagged on the link (which keeps what was reviewed).
      await svc.evidence.ingest(
        source.id,
        [result('r1', { respondentEmail: email, score: '12' })],
        'SYNC',
        null,
      );
      const after = await svc.reviews.detail(fx.selfUser1, review.id);
      expect(after.evidence[0]).toMatchObject({
        percentage: '85.00',
        changedSinceLinked: true,
      });
      await svc.evidence.unlink(review.id, linkId, ctx(fx.users.teamManager!));
      expect(
        (await svc.reviews.detail(fx.selfUser2, review.id)).evidence,
      ).toEqual([]);
    });
  });
});

describe('Performance evidence concurrency (committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures;
  let svc: PerformanceServices;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      (tx) => createSchedulingFixtures(tx, PERFORMANCE_USERS),
      {
        timeout: 60_000,
      },
    );
    svc = performanceServices(prisma, new FixedPerformanceClock());
  });

  afterAll(async () => {
    if (fx) await cleanupSchedulingFixtures(prisma, fx);
    await prisma?.$disconnect();
  });

  it('keeps one result when the same response is delivered concurrently', async () => {
    const source = await svc.evidence.createSource(
      quizSource(fx, {
        code: `coc-${fx.suffix}`,
        externalResourceId: `form-${fx.suffix}`,
      }),
      ctx(fx.users.evidenceAdmin!),
    );
    const email = (
      await prisma.user.findUniqueOrThrow({ where: { id: fx.selfUser1 } })
    ).email;
    const deliveries = await Promise.all(
      [0, 1, 2, 3].map(() =>
        svc.evidence.ingest(
          source.id,
          [result('r1', { respondentEmail: email })],
          'SYNC',
          null,
        ),
      ),
    );
    expect(deliveries.map((d) => d.outcomes[0]!.outcome).sort()).toEqual([
      'CREATED',
      'UNCHANGED',
      'UNCHANGED',
      'UNCHANGED',
    ]);
    expect(
      await prisma.performanceEvidence.count({
        where: { sourceId: source.id },
      }),
    ).toBe(1);
  });
});

describe('Performance evidence synchronization job (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('feeds provider adapters through the ingestion contract, idempotently', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, PERFORMANCE_USERS);
          const client = rollbackClient(tx);
          const svc = performanceServices(client, new FixedPerformanceClock());
          const source = await svc.evidence.createSource(
            quizSource(fx),
            ctx(fx.users.evidenceAdmin!),
          );
          const email = (
            await tx.user.findUniqueOrThrow({ where: { id: fx.selfUser1 } })
          ).email;
          // Phase 12 registers no adapter: nothing is fetched or changed.
          expect(await syncPerformanceEvidence(client)).toMatchObject({
            synced: 0,
            failed: [],
          });
          const calls: Array<Date | null> = [];
          const googleForms: ExternalAssessmentProvider = {
            provider: 'GOOGLE_FORMS',
            fetchResults: async (target, since) => {
              expect(target.externalResourceId).toBe(
                '1FAIpQLSf-code-of-conduct',
              );
              calls.push(since);
              return [result('r1', { respondentEmail: email })];
            },
          };
          expect(
            await syncPerformanceEvidence(client, [googleForms]),
          ).toMatchObject({
            synced: 1,
            received: 1,
            failed: [],
          });
          // The second run asks only for what changed since, and duplicates are no-ops.
          await syncPerformanceEvidence(client, [googleForms]);
          expect(calls[0]).toBeNull();
          expect(calls[1]).toBeInstanceOf(Date);
          expect(
            await tx.performanceEvidence.count({
              where: { sourceId: source.id },
            }),
          ).toBe(1);
          const failing: ExternalAssessmentProvider = {
            provider: 'GOOGLE_FORMS',
            fetchResults: () =>
              Promise.reject(new Error('Google API quota exceeded')),
          };
          expect(
            (await syncPerformanceEvidence(client, [failing])).failed,
          ).toEqual([
            { sourceId: source.id, message: 'Google API quota exceeded' },
          ]);
          expect(
            await tx.performanceEvidenceSource.findUniqueOrThrow({
              where: { id: source.id },
            }),
          ).toMatchObject({
            lastSyncStatus: 'FAILED',
            lastSyncMessage: 'Google API quota exceeded',
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  });
});
