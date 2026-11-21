import {
  DEMO_EMAIL_DOMAIN,
  DEMO_ORGANIZATION_CODE_PREFIX,
} from './demo-database.js';

/**
 * Batch 11 — the demonstration dataset: one fictional group of companies, Harbourline Group.
 * Every name, address and number here is invented. Emails use the reserved `.test` domain, so
 * nothing can ever be delivered to a real mailbox. No real staff, payroll or financial data.
 *
 * The data is a coherent story rather than random rows: an outdoor education centre in Toronto
 * (most modules) and a small design studio in Bengaluru (a second organization and time zone,
 * which also shows organization isolation: studio staff never see the centre's records).
 */

export const demoEmail = (local: string) => `${local}${DEMO_EMAIL_DOMAIN}`;

export type DemoAccountKey =
  | 'owner'
  | 'hr'
  | 'payroll'
  | 'manager'
  | 'employee'
  | 'recruiter'
  | 'studioLead'
  | 'facilities';

export interface DemoAccount {
  key: DemoAccountKey;
  email: string;
  firstName: string;
  lastName: string;
  /** What the account shows in the demo (documented in docs/development/demo.md). */
  purpose: string;
}

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  {
    key: 'owner',
    email: demoEmail('owner'),
    firstName: 'Avery',
    lastName: 'Lindqvist',
    purpose: 'System Owner: every organization, roles and administration.',
  },
  {
    key: 'hr',
    email: demoEmail('hr.admin'),
    firstName: 'Morgan',
    lastName: 'Achebe',
    purpose:
      'HR administrator of Harbourline Outdoor Centre: employees, leave, onboarding, documents, benefits.',
  },
  {
    key: 'payroll',
    email: demoEmail('payroll'),
    firstName: 'Priya',
    lastName: 'Raman',
    purpose:
      'Payroll administrator of the Outdoor Centre: pay groups, calendars, runs.',
  },
  {
    key: 'manager',
    email: demoEmail('manager'),
    firstName: 'Daniel',
    lastName: 'Okafor',
    purpose:
      'Programs manager: schedules, attendance review, leave approval, performance reviews of the team.',
  },
  {
    key: 'employee',
    email: demoEmail('employee'),
    firstName: 'Sofia',
    lastName: 'Martins',
    purpose:
      'Camp counsellor: self-service time, schedule, leave, pay statements, documents.',
  },
  {
    key: 'recruiter',
    email: demoEmail('recruiter'),
    firstName: 'Jordan',
    lastName: 'Kim',
    purpose: 'Recruiter: openings, candidates, applications and interviews.',
  },
  {
    key: 'studioLead',
    email: demoEmail('studio.lead'),
    firstName: 'Arjun',
    lastName: 'Mehta',
    purpose:
      'Lead of Harbourline Studio (Asia/Kolkata): a second organization that cannot see the Outdoor Centre.',
  },
  {
    key: 'facilities',
    email: demoEmail('facilities'),
    firstName: 'Hana',
    lastName: 'Suzuki',
    purpose:
      "Facilities coordinator: manages the Operations department's structure only (its teams and positions); sees the rest of the centre's structure read-only.",
  },
];

export const ORGANIZATIONS = {
  centre: {
    code: `${DEMO_ORGANIZATION_CODE_PREFIX}OUT`,
    name: 'Harbourline Outdoor Centre',
    timezone: 'America/Toronto',
    description: 'Fictional outdoor education centre (demonstration data).',
    currency: 'CAD',
  },
  studio: {
    code: `${DEMO_ORGANIZATION_CODE_PREFIX}STU`,
    name: 'Harbourline Studio',
    timezone: 'Asia/Kolkata',
    description: 'Fictional design studio (demonstration data).',
    currency: 'INR',
  },
} as const;

export type DemoOrganizationKey = keyof typeof ORGANIZATIONS;

export interface DemoEmployee {
  /** Stable natural key (employee number), unique across the demo. */
  number: string;
  organization: DemoOrganizationKey;
  firstName: string;
  lastName: string;
  /** The demo account that signs in as this employee, if any. */
  account?: DemoAccountKey;
  department: string;
  position: string;
  /** Employee number of the manager (same organization). */
  manager?: string;
  /** Hire date as a number of days before the demo reference date. */
  hiredDaysAgo: number;
  pay: { type: 'SALARY'; annual: number } | { type: 'HOURLY'; hourly: number };
}

export const DEPARTMENTS: Record<
  DemoOrganizationKey,
  ReadonlyArray<{ code: string; name: string }>
> = {
  centre: [
    { code: 'PRG', name: 'Programs' },
    { code: 'OPS', name: 'Operations' },
    { code: 'PPL', name: 'People & Culture' },
    { code: 'FIN', name: 'Finance' },
  ],
  studio: [{ code: 'DSN', name: 'Design' }],
};

export const POSITIONS: Record<
  DemoOrganizationKey,
  ReadonlyArray<{ code: string; name: string; department: string }>
> = {
  centre: [
    { code: 'EXD', name: 'Executive Director', department: 'PPL' },
    { code: 'HRA', name: 'HR Administrator', department: 'PPL' },
    { code: 'REC', name: 'Recruiter', department: 'PPL' },
    { code: 'PAY', name: 'Payroll Specialist', department: 'FIN' },
    { code: 'FIM', name: 'Finance Manager', department: 'FIN' },
    { code: 'PGM', name: 'Programs Manager', department: 'PRG' },
    { code: 'CNS', name: 'Camp Counsellor', department: 'PRG' },
    { code: 'FAC', name: 'Facilities Coordinator', department: 'OPS' },
  ],
  studio: [
    { code: 'SLD', name: 'Studio Lead', department: 'DSN' },
    { code: 'DES', name: 'Designer', department: 'DSN' },
  ],
};

export const EMPLOYEES: readonly DemoEmployee[] = [
  // Harbourline Outdoor Centre (America/Toronto)
  {
    number: 'HL-1001',
    organization: 'centre',
    firstName: 'Avery',
    lastName: 'Lindqvist',
    account: 'owner',
    department: 'PPL',
    position: 'EXD',
    hiredDaysAgo: 1460,
    pay: { type: 'SALARY', annual: 118000 },
  },
  {
    number: 'HL-1002',
    organization: 'centre',
    firstName: 'Morgan',
    lastName: 'Achebe',
    account: 'hr',
    department: 'PPL',
    position: 'HRA',
    manager: 'HL-1001',
    hiredDaysAgo: 1100,
    pay: { type: 'SALARY', annual: 82000 },
  },
  {
    number: 'HL-1003',
    organization: 'centre',
    firstName: 'Priya',
    lastName: 'Raman',
    account: 'payroll',
    department: 'FIN',
    position: 'PAY',
    manager: 'HL-1009',
    hiredDaysAgo: 900,
    pay: { type: 'SALARY', annual: 76000 },
  },
  {
    number: 'HL-1004',
    organization: 'centre',
    firstName: 'Daniel',
    lastName: 'Okafor',
    account: 'manager',
    department: 'PRG',
    position: 'PGM',
    manager: 'HL-1001',
    hiredDaysAgo: 1000,
    pay: { type: 'SALARY', annual: 79000 },
  },
  {
    number: 'HL-1005',
    organization: 'centre',
    firstName: 'Sofia',
    lastName: 'Martins',
    account: 'employee',
    department: 'PRG',
    position: 'CNS',
    manager: 'HL-1004',
    hiredDaysAgo: 420,
    pay: { type: 'HOURLY', hourly: 24.5 },
  },
  {
    number: 'HL-1006',
    organization: 'centre',
    firstName: 'Jordan',
    lastName: 'Kim',
    account: 'recruiter',
    department: 'PPL',
    position: 'REC',
    manager: 'HL-1002',
    hiredDaysAgo: 600,
    pay: { type: 'SALARY', annual: 68000 },
  },
  {
    number: 'HL-1007',
    organization: 'centre',
    firstName: 'Elena',
    lastName: 'Petrova',
    department: 'PRG',
    position: 'CNS',
    manager: 'HL-1004',
    hiredDaysAgo: 300,
    pay: { type: 'HOURLY', hourly: 23.75 },
  },
  {
    number: 'HL-1008',
    organization: 'centre',
    firstName: 'Marcus',
    lastName: 'Bell',
    department: 'PRG',
    position: 'CNS',
    manager: 'HL-1004',
    hiredDaysAgo: 120,
    pay: { type: 'HOURLY', hourly: 22.5 },
  },
  {
    number: 'HL-1009',
    organization: 'centre',
    firstName: 'Grace',
    lastName: 'Mwangi',
    department: 'FIN',
    position: 'FIM',
    manager: 'HL-1001',
    hiredDaysAgo: 1300,
    pay: { type: 'SALARY', annual: 96000 },
  },
  {
    number: 'HL-1010',
    organization: 'centre',
    firstName: 'Hana',
    lastName: 'Suzuki',
    account: 'facilities',
    department: 'OPS',
    position: 'FAC',
    manager: 'HL-1001',
    hiredDaysAgo: 700,
    pay: { type: 'SALARY', annual: 61000 },
  },
  // Harbourline Studio (Asia/Kolkata)
  {
    number: 'HL-2001',
    organization: 'studio',
    firstName: 'Arjun',
    lastName: 'Mehta',
    account: 'studioLead',
    department: 'DSN',
    position: 'SLD',
    hiredDaysAgo: 800,
    pay: { type: 'SALARY', annual: 2400000 },
  },
  {
    number: 'HL-2002',
    organization: 'studio',
    firstName: 'Kavya',
    lastName: 'Iyer',
    department: 'DSN',
    position: 'DES',
    manager: 'HL-2001',
    hiredDaysAgo: 365,
    pay: { type: 'SALARY', annual: 1500000 },
  },
  {
    number: 'HL-2003',
    organization: 'studio',
    firstName: 'Rohan',
    lastName: 'Das',
    department: 'DSN',
    position: 'DES',
    manager: 'HL-2001',
    hiredDaysAgo: 90,
    pay: { type: 'SALARY', annual: 1200000 },
  },
];

/** Recruitment: an open counsellor opening with candidates at different stages. */
export const CANDIDATES = [
  { email: demoEmail('cand.lee'), firstName: 'Taylor', lastName: 'Lee' },
  { email: demoEmail('cand.novak'), firstName: 'Casey', lastName: 'Novak' },
  { email: demoEmail('cand.oduya'), firstName: 'Riley', lastName: 'Oduya' },
] as const;

// ─── R5-A demonstration scenarios (lifecycle panel, multi-assignment clock-in, scoped structure) ──

/**
 * Extra assignments on existing employees, each in its own new single-occupancy position (with a
 * job title of the same code). Offsets are days from the demo reference date. None of them gets
 * compensation, so no payroll run (calculated or finalized) includes or changes because of them.
 *
 * - `endVia: 'create'`: the end date is sent when the assignment is created (still to come).
 * - `endVia: 'correct'`: an end date already past cannot be created as ACTIVE (the API derives
 *   ENDED from the dates), so the assignment is created open-ended and its end date is then set by
 *   the assignment correction, which keeps an ACTIVE assignment ACTIVE (overdue) until someone
 *   applies the end. Lifecycle automation stays off, so nothing applies it.
 */
export interface DemoExtraAssignment {
  /** Stable natural key: the position code (positions are single-occupancy). */
  positionCode: string;
  employee: string;
  jobTitle: { code: string; name: string };
  department: string;
  employmentType: 'FULL_TIME' | 'PART_TIME' | 'CASUAL' | 'CONTRACT';
  startOffset: number;
  endOffset: number | null;
  endVia: 'create' | 'correct' | null;
  /** Employee number of the manager (same organization), if any. */
  manager?: string;
  story: string;
}

export const EXTRA_ASSIGNMENTS: readonly DemoExtraAssignment[] = [
  {
    positionCode: 'AUL-1009',
    employee: 'HL-1009',
    jobTitle: { code: 'AUL', name: 'Year-end Audit Liaison' },
    department: 'FIN',
    employmentType: 'PART_TIME',
    startOffset: -56,
    endOffset: -3,
    endVia: 'correct',
    story:
      "Lifecycle panel, overdue: Grace Mwangi's secondary audit assignment ended three days before the reference date and has not been applied.",
  },
  {
    positionCode: 'GIA-1008',
    employee: 'HL-1008',
    jobTitle: { code: 'GIA', name: 'Winter Gear Inventory Assistant' },
    department: 'OPS',
    employmentType: 'CASUAL',
    startOffset: 0,
    endOffset: 12,
    endVia: 'create',
    story:
      "Lifecycle panel, upcoming: Marcus Bell's two-week inventory assignment ends 12 days after the reference date.",
  },
  {
    positionCode: 'LFG-1005',
    employee: 'HL-1005',
    jobTitle: { code: 'LFG', name: 'Waterfront Lifeguard' },
    department: 'PRG',
    employmentType: 'PART_TIME',
    startOffset: 0,
    endOffset: null,
    endVia: null,
    manager: 'HL-1004',
    story:
      'Multi-assignment clock-in: Sofia Martins also works as a lifeguard; her counsellor assignment stays primary.',
  },
];

/**
 * A seasonal hire whose last day is already scheduled: one new, non-account employee created only
 * for the lifecycle panel ("Ends with scheduled termination"). Hired on the reference date, after
 * every pay period the demo calculates or finalizes, and given no compensation and no time: a
 * payroll run's sources are the assignments with compensation in its pay group (plus manual lines
 * and adjustments), so no run, now or later, includes or changes because of this employee.
 */
export const SEASONAL_EMPLOYEE = {
  number: 'HL-1011',
  organization: 'centre' as DemoOrganizationKey,
  firstName: 'Leo',
  lastName: 'Brandt',
  positionCode: 'FSA-1011',
  jobTitle: { code: 'FSA', name: 'Seasonal Facilities Assistant' },
  department: 'OPS',
  employmentType: 'CASUAL',
  hireOffset: 0,
} as const;

/**
 * The termination is scheduled (never applied) for the seasonal hire's last day, inside the
 * panel's default 30-day window. A date that is no longer in the future is skipped.
 */
export const SCHEDULED_TERMINATION = {
  employee: SEASONAL_EMPLOYEE.number,
  dateOffset: 25,
  reason: 'End of the fall season contract (demonstration data).',
} as const;

/**
 * Live clocking for the Programs department (the default policy has the time clock disabled), so
 * Sofia's two Programs assignments are both offered at clock-in. The API never accepts a policy
 * starting in the past, so it starts on the centre's local date when it is first seeded.
 */
export const CLOCK_POLICY = {
  organization: 'centre' as DemoOrganizationKey,
  department: 'PRG',
  config: { clock: { mode: 'LIVE_CLOCK' } },
} as const;

/** Teams the Operations structure manager creates under the Operations department. */
export const OPERATIONS_TEAMS = [
  { code: 'OPS-GRD', name: 'Grounds & Trails' },
  { code: 'OPS-EQP', name: 'Boats & Equipment' },
] as const;

export type DemoRoleScope =
  { type: 'ORGANIZATION' } | { type: 'DEPARTMENT'; department: string };

export interface DemoRole {
  code: string;
  name: string;
  permissions: string[];
  holders: DemoAccountKey[];
  /** Where the role is assigned (default: the whole organization). */
  scope?: DemoRoleScope;
}

/**
 * Scoped structure management for the facilities coordinator: `organization.manage` only on the
 * Operations department (and so on its teams and positions), never on the organization. A
 * separate read-only role lets her see the rest of the centre's structure, and the job titles and
 * work locations a position needs, without being able to change them.
 */
export const STRUCTURE_ROLES: readonly DemoRole[] = [
  {
    code: 'HL-STRUCTURE-VIEWER',
    name: 'Structure viewer (read-only)',
    permissions: ['organization.read'],
    holders: ['facilities'],
  },
  {
    code: 'HL-OPS-STRUCTURE',
    name: 'Operations structure manager',
    permissions: ['organization.read', 'organization.manage'],
    holders: ['facilities'],
    scope: { type: 'DEPARTMENT', department: 'OPS' },
  },
];
