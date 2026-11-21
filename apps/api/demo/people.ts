import { CANDIDATES, ORGANIZATIONS } from './dataset.js';
import { samplePdf } from './sample-pdf.js';
import { addDays, dateColumn, tally, type DemoWorld } from './workflows.js';

/**
 * Batch 11 — the people side of the demo, all at Harbourline Outdoor Centre:
 * - Scheduling: the Programs manager publishes this week's counsellor schedule and drafts next
 *   week's.
 * - Leave: vacation balances, one pending request (Sofia) and one approved (Elena), a closure day.
 * - Recruitment → onboarding: a summer counsellor opening with three candidates — one newly
 *   applied, one with an interview booked, one offered, approved, accepted and hired, whose
 *   onboarding workflow starts from the hire. The newest counsellor's onboarding is under way.
 * - Performance: a review cycle for the Programs department, open, with a submitted self-review
 *   and a submitted manager review; a personal goal.
 * - Benefits: an extended-health plan with two coverage levels; a family enrollment with
 *   dependents, a single enrollment and a waiver.
 * - Documents: a synthetic certificate PDF with an expiry date and a paper-file reference.
 */

const centre = (world: DemoWorld) => world.organizationIds.centre;
const employee = (world: DemoWorld, number: string) => {
  const found = world.employees.get(number);
  if (!found) throw new Error(`Demo employee ${number} is missing.`);
  return found;
};

/** The UTC offset of a time zone at a local date and time, as "+05:30" / "-05:00". */
function offsetAt(timezone: string, date: string, time: string) {
  const guess = new Date(`${date}T${time}:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(guess);
  const value = (type: string) =>
    Number(parts.find((part) => part.type === type)!.value);
  const local = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
  );
  const minutes = Math.round((local - guess.getTime()) / 60_000);
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

const zoned = (timezone: string, date: string, time: string) =>
  `${date}T${time}:00${offsetAt(timezone, date, time)}`;

// ─── Scheduling ─────────────────────────────────────────────────────────────

async function ensureSchedules(world: DemoWorld) {
  const { prisma } = world.context;
  const manager = await world.session('manager');
  const timezone = ORGANIZATIONS.centre.timezone;
  const departmentId = world.departmentIds.get('centre:PRG')!;
  const counsellors = ['HL-1005', 'HL-1007', 'HL-1008'].map((number) =>
    employee(world, number),
  );
  for (const week of [
    { start: world.date(0), name: 'Programs — this week', publish: true },
    { start: world.date(7), name: 'Programs — next week', publish: false },
  ]) {
    let schedule = await prisma.schedule.findFirst({
      where: {
        organizationId: centre(world),
        departmentId,
        periodStart: dateColumn(week.start),
      },
      select: { id: true, status: true },
    });
    tally(world.summary, 'schedules', !schedule);
    if (!schedule) {
      const created = await manager.post<{ id: string }>('/schedules', {
        scopeType: 'DEPARTMENT',
        organizationId: centre(world),
        departmentId,
        name: week.name,
        periodStart: week.start,
        periodEnd: addDays(week.start, 6),
        type: 'STANDARD',
      });
      schedule = { id: created.id, status: 'DRAFT' as never };
    }
    if (schedule.status !== 'DRAFT') continue;
    for (const [index, counsellor] of counsellors.entries()) {
      for (let day = 0; day < 5; day += 1) {
        const workDate = addDays(week.start, day);
        const existing = await prisma.scheduledShift.findFirst({
          where: {
            scheduleId: schedule.id,
            employmentAssignmentId: counsellor.assignmentId,
            workDate: dateColumn(workDate),
          },
          select: { id: true },
        });
        tally(world.summary, 'shifts', !existing);
        if (existing) continue;
        // Staggered starts so the camp is covered from 08:00 to 18:00.
        const [from, to] = [
          ['08:00', '16:00'],
          ['09:00', '17:00'],
          ['10:00', '18:00'],
        ][index]!;
        await manager.post(`/schedules/${schedule.id}/shifts`, {
          employmentAssignmentId: counsellor.assignmentId,
          workDate,
          startsAt: zoned(timezone, workDate, from),
          endsAt: zoned(timezone, workDate, to),
          timezone,
        });
      }
    }
    if (week.publish) await manager.post(`/schedules/${schedule.id}/publish`);
  }
}

// ─── Leave ──────────────────────────────────────────────────────────────────

async function ensureLeave(world: DemoWorld) {
  const { prisma } = world.context;
  const hr = await world.session('hr');
  const organizationId = centre(world);
  const types = [
    {
      code: 'VAC',
      name: 'Vacation',
      classification: 'PAID',
      tracksBalance: true,
      displayUnit: 'DAYS',
    },
    {
      code: 'PER',
      name: 'Personal day (unpaid)',
      classification: 'UNPAID',
      tracksBalance: false,
      displayUnit: 'DAYS',
    },
  ];
  const typeIds = new Map<string, string>();
  for (const type of types) {
    const existing = await prisma.leaveType.findFirst({
      where: { organizationId, code: type.code },
      select: { id: true },
    });
    const id =
      existing?.id ??
      (
        await hr.post<{ id: string }>('/leave/types', {
          organizationId,
          ...type,
        })
      ).id;
    typeIds.set(type.code, id);
    tally(world.summary, 'leaveTypes', !existing);
    const policy = await prisma.leavePolicy.findFirst({
      where: { leaveTypeId: id, organizationId },
      select: { id: true },
    });
    tally(world.summary, 'leavePolicies', !policy);
    if (!policy) {
      await hr.post('/leave/policies', {
        leaveTypeId: id,
        organizationId,
        scopeType: 'ORGANIZATION',
        effectiveFrom: world.date(-730),
        accrualMethod: 'NONE',
        standardWorkdayMinutes: 480,
      });
    }
  }
  // Opening vacation balances (10 days), posted once each (the idempotency key makes a rerun a
  // no-op on the API side too).
  for (const [number, person] of world.employees) {
    if (person.spec.organization !== 'centre' || person.spec.account === 'hr')
      continue;
    const key = `demo-opening-vac-${number}`;
    // The API stores the key namespaced (`adjustment:<actor>:<key>`).
    const existing = await prisma.leaveLedgerEntry.findFirst({
      where: { idempotencyKey: { endsWith: `:${key}` } },
      select: { id: true },
    });
    tally(world.summary, 'leaveBalanceAdjustments', !existing);
    if (existing) continue;
    await hr.post('/leave/adjustments', {
      employmentAssignmentId: person.assignmentId,
      leaveTypeId: typeIds.get('VAC'),
      amountMinutes: 10 * 480,
      effectiveDate: world.date(-60),
      reason: 'Opening vacation balance (demonstration data).',
      idempotencyKey: key,
    });
  }
  // HR's own balance is granted by the System Owner (nobody adjusts their own).
  const hrPerson = [...world.employees.values()].find(
    (person) => person.spec.account === 'hr',
  )!;
  const hrKey = `demo-opening-vac-${hrPerson.spec.number}`;
  if (
    !(await prisma.leaveLedgerEntry.findFirst({
      where: { idempotencyKey: { endsWith: `:${hrKey}` } },
      select: { id: true },
    }))
  ) {
    await (
      await world.session('owner')
    ).post('/leave/adjustments', {
      employmentAssignmentId: hrPerson.assignmentId,
      leaveTypeId: typeIds.get('VAC'),
      amountMinutes: 10 * 480,
      effectiveDate: world.date(-60),
      reason: 'Opening vacation balance (demonstration data).',
      idempotencyKey: hrKey,
    });
  }

  const closure = world.date(25);
  if (
    !(await prisma.organizationHoliday.findFirst({
      where: { organizationId, date: dateColumn(closure) },
      select: { id: true },
    }))
  ) {
    await hr.post('/holidays', {
      organizationId,
      date: closure,
      name: 'Staff training day (centre closed)',
      kind: 'CLOSURE',
    });
    tally(world.summary, 'holidays', true);
  } else tally(world.summary, 'holidays', false);

  // Sofia asks for two days off (pending her manager's decision).
  const sofia = employee(world, 'HL-1005');
  const pendingStart = world.date(15);
  if (
    !(await prisma.leaveRequest.findFirst({
      where: { employeeId: sofia.id, startDate: dateColumn(pendingStart) },
      select: { id: true },
    }))
  ) {
    await (
      await world.session('employee')
    ).post('/leave/me/requests', {
      employmentAssignmentId: sofia.assignmentId,
      leaveTypeId: typeIds.get('VAC'),
      startDate: pendingStart,
      endDate: addDays(pendingStart, 1),
      reason: 'Family visit.',
    });
    tally(world.summary, 'leaveRequests', true);
  } else tally(world.summary, 'leaveRequests', false);

  // Elena's request, entered and approved by her manager.
  const elena = employee(world, 'HL-1007');
  const approvedStart = world.date(22);
  if (
    !(await prisma.leaveRequest.findFirst({
      where: { employeeId: elena.id, startDate: dateColumn(approvedStart) },
      select: { id: true },
    }))
  ) {
    await (
      await world.session('manager')
    ).post('/leave/requests', {
      employmentAssignmentId: elena.assignmentId,
      leaveTypeId: typeIds.get('VAC'),
      startDate: approvedStart,
      endDate: addDays(approvedStart, 1),
      reason: 'Long weekend.',
      approve: true,
      note: 'Covered by the next-week schedule.',
    });
    tally(world.summary, 'leaveRequests', true);
  } else tally(world.summary, 'leaveRequests', false);
}

// ─── Recruitment → onboarding ───────────────────────────────────────────────

async function ensureOnboardingTemplate(world: DemoWorld) {
  const { prisma } = world.context;
  const hr = await world.session('hr');
  const organizationId = centre(world);
  let template = await prisma.workflowTemplate.findFirst({
    where: { organizationId, code: 'CNS-ONBOARD' },
    select: { id: true, status: true, isDefault: true },
  });
  tally(world.summary, 'onboardingTemplates', !template);
  if (!template) {
    const created = await hr.post<{ id: string }>('/onboarding/templates', {
      organizationId,
      kind: 'ONBOARDING',
      code: 'CNS-ONBOARD',
      name: 'Counsellor onboarding',
      tasks: [
        {
          title: 'Sign the employment agreement',
          category: 'PAPERWORK',
          ownerType: 'EMPLOYEE',
          dueOffsetDays: 0,
          required: true,
        },
        {
          title: 'Read and acknowledge the camp safety policy',
          category: 'POLICY',
          ownerType: 'EMPLOYEE',
          dueOffsetDays: 2,
          required: true,
          acknowledgementRequired: true,
          acknowledgementStatement:
            'I have read the camp safety policy and will follow it on every program day.',
        },
        {
          title: 'Set up payroll and tax details',
          category: 'PAYROLL',
          ownerType: 'HR',
          dueOffsetDays: 3,
          required: true,
        },
        {
          title: 'Issue radio, first-aid kit and uniform',
          category: 'EQUIPMENT',
          ownerType: 'HR',
          dueOffsetDays: 0,
          required: false,
        },
        {
          title: 'Site orientation walk with the Programs manager',
          category: 'ORIENTATION',
          ownerType: 'MANAGER',
          dueOffsetDays: 1,
          required: true,
        },
        {
          title: 'Upload a current first-aid certificate',
          category: 'TRAINING',
          ownerType: 'EMPLOYEE',
          dueOffsetDays: 7,
          required: true,
        },
      ],
    });
    template = { id: created.id, status: 'DRAFT' as never, isDefault: false };
  }
  if (template.status === 'DRAFT')
    await hr.post(`/onboarding/templates/${template.id}/activate`);
  if (!template.isDefault)
    await hr.post(`/onboarding/templates/${template.id}/default`);
}

async function ensureRecruitment(world: DemoWorld) {
  const { prisma } = world.context;
  const recruiter = await world.session('recruiter');
  const hr = await world.session('hr');
  const organizationId = centre(world);

  if (
    !(await prisma.recruitmentStage.findFirst({
      where: { organizationId },
      select: { id: true },
    }))
  ) {
    await recruiter.post('/recruitment/stages/initialize', { organizationId });
  }
  const stage = async (kind: string) =>
    (
      await prisma.recruitmentStage.findFirstOrThrow({
        where: { organizationId, kind: kind as never, archivedAt: null },
        orderBy: { sortOrder: 'asc' },
        select: { id: true },
      })
    ).id;

  const recruiterUser = await prisma.user.findUniqueOrThrow({
    where: { email: 'recruiter@demo.harbourline.test' },
    select: { id: true },
  });
  let opening = await prisma.jobOpening.findFirst({
    where: { organizationId, code: 'CNS-SUMMER' },
    select: { id: true, status: true },
  });
  tally(world.summary, 'jobOpenings', !opening);
  if (!opening) {
    const created = await recruiter.post<{ id: string }>(
      '/recruitment/openings',
      {
        organizationId,
        code: 'CNS-SUMMER',
        title: 'Camp Counsellor (summer season)',
        description:
          'Lead day programs for campers aged 8–14: canoeing, orienteering and nature craft. Demonstration posting.',
        employmentType: 'PART_TIME',
        departmentId: world.departmentIds.get('centre:PRG'),
        hiringManagerEmployeeId: employee(world, 'HL-1004').id,
        recruiterUserId: recruiterUser.id,
        openingCount: 2,
        postedOn: world.date(-21),
        closesOn: world.date(30),
      },
    );
    opening = { id: created.id, status: 'DRAFT' as never };
  }
  if (opening.status === 'DRAFT')
    await recruiter.post(`/recruitment/openings/${opening.id}/open`);

  const applicationFor = async (email: string) =>
    prisma.recruitmentApplication.findFirst({
      where: { openingId: opening!.id, candidate: { email } },
      select: { id: true, status: true, stage: { select: { kind: true } } },
    });

  const [taylor, casey, riley] = CANDIDATES;
  const applied: Record<string, string> = {};
  for (const [index, candidate] of CANDIDATES.entries()) {
    let application = await applicationFor(candidate.email);
    tally(world.summary, 'applications', !application);
    if (!application) {
      await recruiter.post('/recruitment/applications', {
        openingId: opening.id,
        candidate: {
          firstName: candidate.firstName,
          lastName: candidate.lastName,
          email: candidate.email,
        },
        source: 'CAREERS_SITE',
        appliedAt: `${world.date(-18 + index * 3)}T14:00:00.000Z`,
      });
      application = (await applicationFor(candidate.email))!;
    }
    applied[candidate.email] = application.id;
  }
  void taylor;

  // Casey: moved to the interview stage, with an interview booked with the hiring manager.
  const caseyApplication = await applicationFor(casey.email);
  if (caseyApplication?.stage.kind === 'APPLIED') {
    await recruiter.post(
      `/recruitment/applications/${caseyApplication.id}/stage`,
      {
        stageId: await stage('INTERVIEW'),
        note: 'Strong outdoor-leadership background.',
      },
    );
  }
  if (
    !(await prisma.recruitmentInterview.findFirst({
      where: { applicationId: applied[casey.email] },
      select: { id: true },
    }))
  ) {
    const daniel = await prisma.user.findUniqueOrThrow({
      where: { email: 'manager@demo.harbourline.test' },
      select: { id: true },
    });
    await recruiter.post(
      `/recruitment/applications/${applied[casey.email]}/interviews`,
      {
        type: 'IN_PERSON',
        title: 'Panel interview at the boathouse',
        scheduledStart: zoned(
          ORGANIZATIONS.centre.timezone,
          world.date(2),
          '10:00',
        ),
        durationMinutes: 45,
        interviewerUserIds: [daniel.id],
        location: 'Boathouse meeting room',
      },
    );
    tally(world.summary, 'interviews', true);
  } else tally(world.summary, 'interviews', false);

  // Riley: offered, approved by HR, sent, accepted and hired into an open counsellor seat.
  let rileyApplication = await applicationFor(riley.email);
  if (
    rileyApplication &&
    rileyApplication.status === 'ACTIVE' &&
    rileyApplication.stage.kind !== 'OFFER'
  ) {
    await recruiter.post(
      `/recruitment/applications/${rileyApplication.id}/stage`,
      {
        stageId: await stage('OFFER'),
        note: 'References checked.',
      },
    );
  }
  let offer = await prisma.recruitmentOffer.findFirst({
    where: { applicationId: applied[riley.email] },
    select: { id: true, status: true },
  });
  if (!offer) {
    const created = await recruiter.post<{ id: string }>(
      `/recruitment/applications/${applied[riley.email]}/offers`,
      {
        positionId: world.positionIds.get('centre:CNS-OPEN1'),
        employmentType: 'PART_TIME',
        startDate: world.date(14),
        payBasis: 'HOURLY',
        rateAmount: '22.50',
        currency: 'CAD',
        expiresOn: world.date(10),
      },
    );
    offer = { id: created.id, status: 'DRAFT' as never };
    tally(world.summary, 'offers', true);
  } else tally(world.summary, 'offers', false);
  if (offer.status === 'DRAFT') {
    await hr.post(`/recruitment/offers/${offer.id}/approve`);
    offer.status = 'APPROVED' as never;
  }
  if (offer.status === 'APPROVED') {
    await recruiter.post(`/recruitment/offers/${offer.id}/send`);
    offer.status = 'SENT' as never;
  }
  if (offer.status === 'SENT') {
    await recruiter.post(`/recruitment/offers/${offer.id}/accept`);
  }
  rileyApplication = await applicationFor(riley.email);
  if (rileyApplication?.status !== 'HIRED') {
    const payGroup = await prisma.payGroup.findFirstOrThrow({
      where: { organizationId, code: 'HRL' },
      select: { id: true },
    });
    await hr.post(`/recruitment/applications/${applied[riley.email]}/hire`, {
      confirmNewPerson: true,
      isPrimary: true,
      managerAssignmentId: employee(world, 'HL-1004').assignmentId,
      initializeCompensation: true,
      payGroupId: payGroup.id,
    });
    tally(world.summary, 'hires', true);
  } else tally(world.summary, 'hires', false);

  // The hire's onboarding starts from the hire record (the template above is the default).
  const hire = await prisma.recruitmentHire.findFirstOrThrow({
    where: { applicationId: applied[riley.email] },
    select: { id: true },
  });
  if (
    !(await prisma.employeeWorkflow.findFirst({
      where: { recruitmentHireId: hire.id },
      select: { id: true },
    }))
  ) {
    await hr.post(`/onboarding/from-hire/${hire.id}`);
    tally(world.summary, 'onboardingWorkflows', true);
  } else tally(world.summary, 'onboardingWorkflows', false);
}

/** The newest counsellor's onboarding, part-way through. */
async function ensureOnboardingInProgress(world: DemoWorld) {
  const { prisma } = world.context;
  const hr = await world.session('hr');
  const marcus = employee(world, 'HL-1008');
  let workflow = await prisma.employeeWorkflow.findFirst({
    where: { employmentAssignmentId: marcus.assignmentId, kind: 'ONBOARDING' },
    select: { id: true },
  });
  tally(world.summary, 'onboardingWorkflows', !workflow);
  if (!workflow) {
    workflow = await hr.post<{ id: string }>(
      '/onboarding/workflows/onboarding',
      {
        employmentAssignmentId: marcus.assignmentId,
      },
    );
  }
  const tasks = await prisma.employeeWorkflowTask.findMany({
    where: { workflowId: workflow.id, ownerType: 'HR' },
    select: { id: true, status: true },
    orderBy: { sortOrder: 'asc' },
  });
  for (const task of tasks) {
    if (task.status === 'NOT_STARTED')
      await hr.post(`/onboarding/tasks/${task.id}/complete`);
  }
}

// ─── Performance ────────────────────────────────────────────────────────────

async function ensurePerformance(world: DemoWorld) {
  const { prisma } = world.context;
  const hr = await world.session('hr');
  const organizationId = centre(world);

  let scale = await prisma.performanceRatingScale.findFirst({
    where: { organizationId, code: 'FIVE' },
    select: { id: true, status: true },
  });
  if (!scale) {
    scale = {
      ...(await hr.post<{ id: string }>('/performance/rating-scales', {
        organizationId,
        code: 'FIVE',
        name: 'Five-point scale',
        levels: [
          { value: 1, label: 'Not yet meeting expectations' },
          { value: 2, label: 'Partly meeting expectations' },
          { value: 3, label: 'Meeting expectations' },
          { value: 4, label: 'Exceeding expectations' },
          { value: 5, label: 'Outstanding' },
        ],
      })),
      status: 'DRAFT' as never,
    };
  }
  if (scale.status === 'DRAFT')
    await hr.post(`/performance/rating-scales/${scale.id}/activate`);

  let template = await prisma.performanceTemplate.findFirst({
    where: { organizationId, code: 'SEASON' },
    select: { id: true, status: true },
  });
  tally(world.summary, 'performanceTemplates', !template);
  if (!template) {
    template = {
      ...(await hr.post<{ id: string }>('/performance/templates', {
        organizationId,
        code: 'SEASON',
        name: 'Seasonal review',
        scoringMode: 'NONE',
        ratingScaleId: scale.id,
        overallRatingEnabled: true,
        sections: [
          {
            title: 'Program delivery',
            items: [
              {
                itemType: 'RATING',
                prompt: 'Camper safety and supervision',
                respondent: 'BOTH',
                required: true,
                ratingScaleId: scale.id,
              },
              {
                itemType: 'RATING',
                prompt: 'Planning and running activities',
                respondent: 'BOTH',
                required: true,
                ratingScaleId: scale.id,
              },
            ],
          },
          {
            title: 'Reflection',
            items: [
              {
                itemType: 'TEXT',
                prompt: 'What went well this season?',
                respondent: 'BOTH',
                required: true,
              },
              {
                itemType: 'TEXT',
                prompt: 'What would you like to learn next season?',
                respondent: 'SELF',
                required: false,
              },
            ],
          },
        ],
      })),
      status: 'DRAFT' as never,
    };
  }
  if (template.status === 'DRAFT')
    await hr.post(`/performance/templates/${template.id}/activate`);

  let cycle = await prisma.performanceCycle.findFirst({
    where: { organizationId, code: 'H2-SEASON' },
    select: { id: true, status: true },
  });
  tally(world.summary, 'performanceCycles', !cycle);
  if (!cycle) {
    cycle = {
      ...(await hr.post<{ id: string }>('/performance/cycles', {
        organizationId,
        code: 'H2-SEASON',
        name: 'Autumn season review',
        templateId: template.id,
        periodStart: world.date(-120),
        periodEnd: world.date(-1),
        windowStart: world.date(-7),
        windowEnd: world.date(28),
        reviewerModel: 'DIRECT_MANAGER',
        selfReviewEnabled: true,
        selfReviewDueDate: world.date(10),
        reviewerDueDate: world.date(24),
      })),
      status: 'DRAFT' as never,
    };
    await hr.post(`/performance/cycles/${cycle.id}/reviews`, {
      assignmentIds: ['HL-1005', 'HL-1007', 'HL-1008'].map(
        (number) => employee(world, number).assignmentId,
      ),
    });
  }
  if (cycle.status === 'DRAFT')
    await hr.post(`/performance/cycles/${cycle.id}/open`);

  // The cycle's form is a snapshot of the template, taken when the cycle opens.
  const items = await prisma.performanceFormItem.findMany({
    where: { cycleId: cycle.id },
    orderBy: [{ section: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
    select: { id: true, itemType: true, respondent: true, prompt: true },
  });
  const answers = (
    respondent: 'SELF' | 'REVIEWER',
    ratings: number[],
    texts: string[],
  ) => {
    let rating = 0;
    let text = 0;
    return items
      .filter(
        (item) => item.respondent === 'BOTH' || item.respondent === respondent,
      )
      .map((item) =>
        item.itemType === 'RATING'
          ? { itemId: item.id, ratingValue: ratings[rating++] ?? 3 }
          : { itemId: item.id, textValue: texts[text++] ?? '' },
      );
  };
  const reviewOf = (number: string) =>
    prisma.performanceReview.findFirstOrThrow({
      where: {
        cycleId: cycle!.id,
        employmentAssignmentId: employee(world, number).assignmentId,
      },
      select: { id: true, selfStatus: true, reviewerStatus: true },
    });
  const today = new Date().toISOString().slice(0, 10);
  const windowOpen = today >= world.date(-7) && today <= world.date(28);

  // Sofia has submitted her self-review; Daniel has submitted his review of Elena.
  const sofiaReview = await reviewOf('HL-1005');
  if (sofiaReview.selfStatus !== 'SUBMITTED') {
    if (windowOpen) {
      const sofia = await world.session('employee');
      await sofia.post(`/performance/reviews/${sofiaReview.id}/self`, {
        answers: answers(
          'SELF',
          [4, 4],
          [
            'Ran the canoe safety module for three cohorts with no incidents.',
            'Wilderness first responder certification.',
          ],
        ),
      });
      await sofia.post(`/performance/reviews/${sofiaReview.id}/self/submit`);
    } else
      world.summary.skipped.push(
        'Self-review not submitted: the review window has closed.',
      );
  }
  const elenaReview = await reviewOf('HL-1007');
  if (elenaReview.reviewerStatus !== 'SUBMITTED') {
    if (windowOpen) {
      const manager = await world.session('manager');
      await manager.post(`/performance/reviews/${elenaReview.id}/reviewer`, {
        answers: answers(
          'REVIEWER',
          [5, 4],
          ['Calm, reliable lead on every overnight trip.'],
        ),
        overallRatingValue: 4,
      });
      await manager.post(
        `/performance/reviews/${elenaReview.id}/reviewer/submit`,
      );
    } else
      world.summary.skipped.push(
        'Manager review not submitted: the review window has closed.',
      );
  }

  const sofia = employee(world, 'HL-1005');
  if (
    !(await prisma.performanceGoal.findFirst({
      where: { employmentAssignmentId: sofia.assignmentId },
      select: { id: true },
    }))
  ) {
    await (
      await world.session('employee')
    ).post('/performance/goals', {
      employmentAssignmentId: sofia.assignmentId,
      title: 'Lead the canoe safety module next season',
      description:
        'Shadow the senior counsellor, then lead two sessions independently.',
      startDate: world.date(-30),
      dueDate: world.date(150),
    });
    tally(world.summary, 'goals', true);
  } else tally(world.summary, 'goals', false);
}

// ─── Benefits ───────────────────────────────────────────────────────────────

async function ensureBenefits(world: DemoWorld) {
  const { prisma } = world.context;
  const hr = await world.session('hr');
  const organizationId = centre(world);
  const effectiveFrom = world.date(-180);

  let plan = await prisma.benefitPlan.findFirst({
    where: { organizationId, code: 'EHC' },
    select: { id: true, status: true },
  });
  tally(world.summary, 'benefitPlans', !plan);
  if (!plan) {
    plan = {
      ...(await hr.post<{ id: string }>('/benefits/plans', {
        organizationId,
        code: 'EHC',
        name: 'Extended health care',
        benefitType: 'HEALTH',
        currency: 'CAD',
        effectiveFrom,
      })),
      status: 'DRAFT' as never,
    };
  }
  const optionIds = new Map<string, string>();
  for (const option of [
    {
      code: 'SINGLE',
      name: 'Employee only',
      coverageLevel: 'EMPLOYEE_ONLY',
      employee: '18.50',
      employer: '41.00',
    },
    {
      code: 'FAMILY',
      name: 'Family',
      coverageLevel: 'FAMILY',
      employee: '46.00',
      employer: '92.00',
    },
  ]) {
    let found = await prisma.benefitCoverageOption.findFirst({
      where: { planId: plan.id, code: option.code },
      select: { id: true },
    });
    if (!found) {
      found = await hr.post<{ id: string }>(
        `/benefits/plans/${plan.id}/options`,
        {
          code: option.code,
          name: option.name,
          coverageLevel: option.coverageLevel,
        },
      );
      await hr.post(`/benefits/options/${found.id}/rates`, {
        effectiveFrom,
        frequency: 'PER_PAY_PERIOD',
        employeeAmount: option.employee,
        employerAmount: option.employer,
      });
    }
    optionIds.set(option.code, found.id);
  }
  if (
    !(await prisma.benefitEligibilityRule.findFirst({
      where: { planId: plan.id },
      select: { id: true },
    }))
  ) {
    await hr.post(`/benefits/plans/${plan.id}/eligibility-rules`, {
      effectiveFrom,
      employmentTypes: ['FULL_TIME'],
      minimumServiceDays: 90,
    });
  }
  if (plan.status === 'DRAFT')
    await hr.post(`/benefits/plans/${plan.id}/activate`);

  // Daniel's family coverage with his dependents; Priya's single coverage; Hana waives.
  const daniel = employee(world, 'HL-1004');
  const dependentIds: string[] = [];
  for (const dependent of [
    {
      firstName: 'Imani',
      lastName: 'Okafor',
      relationship: 'SPOUSE',
      dateOfBirth: '1988-04-12',
    },
    {
      firstName: 'Theo',
      lastName: 'Okafor',
      relationship: 'CHILD',
      dateOfBirth: '2017-09-03',
    },
  ]) {
    let found = await prisma.benefitDependent.findFirst({
      where: { employeeId: daniel.id, firstName: dependent.firstName },
      select: { id: true },
    });
    if (!found)
      found = await hr.post<{ id: string }>(
        `/benefits/employees/${daniel.id}/dependents`,
        dependent,
      );
    dependentIds.push(found.id);
  }
  const coverageStart = world.date(0);
  for (const election of [
    { number: 'HL-1004', option: 'FAMILY', dependentIds },
    { number: 'HL-1003', option: 'SINGLE', dependentIds: [] as string[] },
  ]) {
    const person = employee(world, election.number);
    const existing = await prisma.benefitEnrollment.findFirst({
      where: { employmentAssignmentId: person.assignmentId, planId: plan.id },
      select: { id: true },
    });
    tally(world.summary, 'benefitEnrollments', !existing);
    if (existing) continue;
    await hr.post('/benefits/elections/enroll', {
      employmentAssignmentId: person.assignmentId,
      planId: plan.id,
      optionId: optionIds.get(election.option),
      coverageStart,
      ...(election.dependentIds.length
        ? { dependentIds: election.dependentIds }
        : {}),
    });
  }
  const hana = employee(world, 'HL-1010');
  if (
    !(await prisma.benefitEnrollment.findFirst({
      where: { employmentAssignmentId: hana.assignmentId, planId: plan.id },
      select: { id: true },
    }))
  ) {
    await hr.post('/benefits/elections/waive', {
      employmentAssignmentId: hana.assignmentId,
      planId: plan.id,
      coverageStart,
      reason: 'Covered under a spouse’s plan.',
    });
    tally(world.summary, 'benefitWaivers', true);
  } else tally(world.summary, 'benefitWaivers', false);
}

// ─── Documents ──────────────────────────────────────────────────────────────

async function ensureDocuments(world: DemoWorld) {
  const { prisma } = world.context;
  const hr = await world.session('hr');
  const organizationId = centre(world);
  if (
    !(await prisma.documentType.findFirst({
      where: { organizationId },
      select: { id: true },
    }))
  ) {
    await hr.post('/documents/types/initialize', { organizationId });
  }
  const typeOf = async (category: string) =>
    (
      await prisma.documentType.findFirstOrThrow({
        where: {
          organizationId,
          category: category as never,
          archivedAt: null,
        },
        select: { id: true },
      })
    ).id;

  const sofia = employee(world, 'HL-1005');
  const certificateTitle = 'Wilderness first aid certificate (sample)';
  if (
    !(await prisma.employeeDocument.findFirst({
      where: { employeeId: sofia.id, title: certificateTitle },
      select: { id: true },
    }))
  ) {
    const form = new FormData();
    const pdf = samplePdf([
      'Wilderness First Aid - sample certificate',
      'Issued to: Sofia Martins (fictional person)',
      'Harbourline Outdoor Centre - demonstration data only',
      'This file is not a real certificate and contains no personal information.',
    ]);
    form.append(
      'file',
      new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }),
      'first-aid-certificate-sample.pdf',
    );
    const upload = await hr.upload<{ id?: string; uploadId?: string }>(
      `/documents/uploads?organizationId=${organizationId}&employeeId=${sofia.id}`,
      form,
    );
    await hr.post('/documents/records', {
      organizationId,
      employeeId: sofia.id,
      typeId: await typeOf('CERTIFICATION'),
      title: certificateTitle,
      // Her own certificate: visible to her in My documents, as well as to HR.
      confidentiality: 'EMPLOYEE_VISIBLE',
      version: {
        provider: 'INTERNAL_OBJECT_STORAGE',
        uploadId: upload.uploadId ?? upload.id,
        issuedOn: world.date(-200),
        expiresOn: world.date(40),
      },
    });
    tally(world.summary, 'documents', true);
  } else tally(world.summary, 'documents', false);

  const elena = employee(world, 'HL-1007');
  const agreementTitle = 'Signed employment agreement (paper file)';
  if (
    !(await prisma.employeeDocument.findFirst({
      where: { employeeId: elena.id, title: agreementTitle },
      select: { id: true },
    }))
  ) {
    await hr.post('/documents/records', {
      organizationId,
      employeeId: elena.id,
      typeId: await typeOf('EMPLOYMENT_AGREEMENT'),
      title: agreementTitle,
      version: {
        provider: 'MANUAL_REFERENCE',
        issuedOn: world.date(-300),
        note: 'Original kept in the HR filing cabinet, drawer 2 (demonstration data).',
      },
    });
    tally(world.summary, 'documents', true);
  } else tally(world.summary, 'documents', false);
}

export async function seedDemoPeople(world: DemoWorld) {
  world.context.log('Scheduling and leave…');
  await ensureSchedules(world);
  await ensureLeave(world);
  world.context.log('Recruitment and onboarding…');
  await ensureOnboardingTemplate(world);
  await ensureRecruitment(world);
  await ensureOnboardingInProgress(world);
  world.context.log('Performance, benefits and documents…');
  await ensurePerformance(world);
  await ensureBenefits(world);
  await ensureDocuments(world);
}
