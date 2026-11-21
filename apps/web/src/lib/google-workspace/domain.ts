import type {
  FieldMappingEntry,
  FormFieldMapping,
  GoogleCapability,
  GoogleFormBindingTarget,
  GoogleScoreSource,
} from './types';

/** Either permission shows the Google Workspace page (the API decides the organizations). */
export const GOOGLE_WORKSPACE_PERMISSION_KEYS = [
  'integration.google.read',
  'integration.google.manage',
] as const;

export const GOOGLE_CAPABILITIES: readonly GoogleCapability[] = [
  'FORMS',
  'DRIVE_METADATA',
  'GMAIL_SEND',
  'SHEETS_EXPORT',
];

export const CAPABILITY_LABELS: Record<GoogleCapability, string> = {
  FORMS: 'Google Forms (read forms and responses)',
  DRIVE_METADATA: 'Google Drive file details (metadata only)',
  GMAIL_SEND: 'Gmail (send notification email)',
  SHEETS_EXPORT: 'Google Sheets export (files the HRMS creates)',
};

export const CAPABILITY_SHORT_LABELS: Record<GoogleCapability, string> = {
  FORMS: 'Forms',
  DRIVE_METADATA: 'Drive metadata',
  GMAIL_SEND: 'Gmail send',
  SHEETS_EXPORT: 'Sheets export',
};

export const TARGETS: readonly GoogleFormBindingTarget[] = [
  'PERFORMANCE_EVIDENCE',
  'RECRUITMENT_INTAKE',
  'ONBOARDING_TASKS',
];

export const TARGET_LABELS: Record<GoogleFormBindingTarget, string> = {
  PERFORMANCE_EVIDENCE: 'Performance evidence',
  RECRUITMENT_INTAKE: 'Recruitment intake',
  ONBOARDING_TASKS: 'Onboarding tasks',
};

const DOCUMENT_KINDS = [
  'RESUME',
  'COVER_LETTER',
  'CERTIFICATE',
  'REFERENCE',
  'PORTFOLIO',
  'OTHER',
] as const;

/** The contract fields a form question may feed, per target (mirrors the API domain). */
export const MAPPING_FIELDS: Record<GoogleFormBindingTarget, readonly string[]> = {
  PERFORMANCE_EVIDENCE: ['respondentEmail', 'respondentReference'],
  RECRUITMENT_INTAKE: [
    'candidate.firstName',
    'candidate.lastName',
    'candidate.preferredName',
    'candidate.email',
    'candidate.phone',
    'candidate.location',
    'openingCode',
    'answer',
    ...DOCUMENT_KINDS.map((kind) => `document.${kind}`),
  ],
  ONBOARDING_TASKS: ['respondentEmail'],
};

export const REQUIRED_FIELDS: Record<GoogleFormBindingTarget, readonly string[]> = {
  PERFORMANCE_EVIDENCE: [],
  RECRUITMENT_INTAKE: ['candidate.firstName', 'candidate.lastName'],
  ONBOARDING_TASKS: [],
};

const DOCUMENT_LABELS: Record<(typeof DOCUMENT_KINDS)[number], string> = {
  RESUME: 'Résumé',
  COVER_LETTER: 'Cover letter',
  CERTIFICATE: 'Certificate',
  REFERENCE: 'Reference',
  PORTFOLIO: 'Portfolio',
  OTHER: 'Other document',
};

export const FIELD_LABELS: Record<string, string> = {
  respondentEmail: 'Respondent email',
  respondentReference: 'Respondent reference',
  'candidate.firstName': 'Candidate first name',
  'candidate.lastName': 'Candidate last name',
  'candidate.preferredName': 'Candidate preferred name',
  'candidate.email': 'Candidate email',
  'candidate.phone': 'Candidate phone',
  'candidate.location': 'Candidate location',
  openingCode: 'Job opening code',
  answer: 'Application answer',
  ...Object.fromEntries(
    DOCUMENT_KINDS.map((kind) => [`document.${kind}`, `Document upload: ${DOCUMENT_LABELS[kind]}`]),
  ),
};

export const SCORE_SOURCE_LABELS: Record<GoogleScoreSource, string> = {
  QUIZ_TOTAL: 'Quiz total score',
  NONE: 'No score',
};

/** Answers and documents may repeat and take a label; every other field is mapped once. */
export const isMultiValuedField = (field: string) =>
  field === 'answer' || field.startsWith('document.');

export const QUESTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const FORM_ID = /^[A-Za-z0-9_-]{10,200}$/;

export const GOOGLE_AUTHORIZATION_ORIGIN = 'https://accounts.google.com';

/** The OAuth start only ever navigates to Google's own authorization origin. */
export function isGoogleAuthorizationUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === GOOGLE_AUTHORIZATION_ORIGIN && url.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface MappingRow {
  questionId: string;
  field: string;
  label: string;
}

/** The first problem with editor rows (the API validates again), or null. */
export function mappingRowsProblem(
  target: GoogleFormBindingTarget,
  rows: readonly MappingRow[],
): string | null {
  if (rows.length > 100) return 'A mapping has at most 100 questions.';
  const questions = new Set<string>();
  const single = new Set<string>();
  const allowed = MAPPING_FIELDS[target];
  for (const row of rows) {
    const questionId = row.questionId.trim();
    if (!QUESTION_ID.test(questionId))
      return 'Question ids are 1–64 letters, digits, "_" or "-" (copy them from the form).';
    if (!allowed.includes(row.field)) return 'Choose a field for every question.';
    if (questions.has(questionId)) return 'A question can be mapped to one field only.';
    questions.add(questionId);
    const label = row.label.trim();
    if (label && !isMultiValuedField(row.field)) return 'Only answers and documents take a label.';
    if (label.length > 200) return 'Labels are at most 200 characters.';
    if (!isMultiValuedField(row.field)) {
      if (single.has(row.field)) return `${FIELD_LABELS[row.field] ?? row.field} is mapped twice.`;
      single.add(row.field);
    }
  }
  for (const required of REQUIRED_FIELDS[target]) {
    if (!single.has(required)) return `Map a question to ${FIELD_LABELS[required] ?? required}.`;
  }
  return null;
}

export function mappingFromRows(
  target: GoogleFormBindingTarget,
  rows: readonly MappingRow[],
  scoreSource: GoogleScoreSource,
): FormFieldMapping {
  const fields: FieldMappingEntry[] = rows.map((row) => {
    const label = row.label.trim();
    return {
      questionId: row.questionId.trim(),
      field: row.field,
      ...(label && isMultiValuedField(row.field) ? { label } : {}),
    };
  });
  return {
    schemaVersion: 1,
    fields,
    ...(target === 'PERFORMANCE_EVIDENCE' ? { scoreSource } : {}),
  };
}

export function rowsFromMapping(mapping: FormFieldMapping | null | undefined): MappingRow[] {
  return (mapping?.fields ?? []).map((entry) => ({
    questionId: entry.questionId,
    field: entry.field,
    label: entry.label ?? '',
  }));
}

export type CallbackResult =
  { kind: 'connected'; organizationId: string | null } | { kind: 'error'; code: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The result the OAuth callback redirect appended (`?result=connected&organizationId=…` or
 * `?result=error&code=…`). Values are validated against strict patterns; anything else is
 * dropped, and nothing here is ever rendered as markup.
 */
export function parseCallbackResult(search: string): CallbackResult | null {
  const params = new URLSearchParams(search);
  const result = params.get('result');
  if (result === 'connected') {
    const organizationId = params.get('organizationId');
    return {
      kind: 'connected',
      organizationId: organizationId && UUID.test(organizationId) ? organizationId : null,
    };
  }
  if (result === 'error') {
    const code = params.get('code');
    return { kind: 'error', code: code && CODE.test(code) ? code : null };
  }
  return null;
}
