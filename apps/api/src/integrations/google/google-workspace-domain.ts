import {
  createHash,
  createPrivateKey,
  randomBytes,
  sign as signData,
} from 'node:crypto';
import type {
  GoogleCapability,
  GoogleFormBindingTarget,
  RecruitmentDocumentKind,
} from '../../generated/prisma/client.js';

/**
 * Phase 16.5 — pure rules of the Google Workspace integration: capabilities and their minimal
 * scopes, OAuth state / PKCE helpers, service-account key validation and JWT assertions, the
 * versioned form field mapping, response cursors, sync backoff and Gmail message building.
 * Nothing here performs I/O.
 */

// ─── Capabilities → minimal scopes ───────────────────────────────────────────

export const GOOGLE_CAPABILITIES = [
  'FORMS',
  'DRIVE_METADATA',
  'GMAIL_SEND',
  'SHEETS_EXPORT',
] as const satisfies readonly GoogleCapability[];

const SCOPE = (name: string) => `https://www.googleapis.com/auth/${name}`;

/**
 * The least-privilege scopes of each capability. None of them needs domain-wide delegation:
 * all are ordinary delegated OAuth scopes a Workspace admin (or a dedicated mailbox, for
 * Gmail) consents to. Sheets export uses drive.file (only files the app creates), never the
 * broad spreadsheets scope.
 */
export const CAPABILITY_SCOPES: Record<GoogleCapability, readonly string[]> = {
  FORMS: [SCOPE('forms.body.readonly'), SCOPE('forms.responses.readonly')],
  DRIVE_METADATA: [SCOPE('drive.metadata.readonly')],
  GMAIL_SEND: [SCOPE('gmail.send')],
  SHEETS_EXPORT: [SCOPE('drive.file')],
};

/** Identity scopes requested with OAuth only (the consenting account's email / hosted domain). */
export const IDENTITY_SCOPES = ['openid', 'email'] as const;

/** Every scope this integration may ever record (mirrors the database check). */
export const KNOWN_SCOPES = new Set<string>([
  ...IDENTITY_SCOPES,
  SCOPE('userinfo.email'),
  ...Object.values(CAPABILITY_SCOPES).flat(),
]);

export function normalizeCapabilities(
  capabilities: readonly string[],
): GoogleCapability[] {
  const set = new Set(capabilities);
  return GOOGLE_CAPABILITIES.filter((capability) => set.has(capability));
}

export function scopesFor(capabilities: readonly GoogleCapability[]) {
  return [...new Set(capabilities.flatMap((c) => CAPABILITY_SCOPES[c]))].sort();
}

/** Recorded scopes: the known ones Google reports granted (anything else is dropped). */
export function recordedScopes(granted: string | readonly string[]) {
  const list =
    typeof granted === 'string' ? granted.split(/\s+/) : [...granted];
  return [...new Set(list.filter((scope) => KNOWN_SCOPES.has(scope)))].sort();
}

/** Capabilities whose every scope was granted. */
export function grantedCapabilities(
  requested: readonly GoogleCapability[],
  scopes: readonly string[],
) {
  const granted = new Set(scopes);
  return requested.filter((c) =>
    CAPABILITY_SCOPES[c].every((scope) => granted.has(scope)),
  );
}

export function connectionCan(
  connection: {
    status: string;
    capabilities: readonly string[];
    grantedScopes: readonly string[];
  },
  capability: GoogleCapability,
) {
  return (
    connection.status === 'ACTIVE' &&
    connection.capabilities.includes(capability) &&
    CAPABILITY_SCOPES[capability].every((scope) =>
      connection.grantedScopes.includes(scope),
    )
  );
}

// ─── OAuth state and PKCE ────────────────────────────────────────────────────

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
export const GOOGLE_AUTHORIZATION_ENDPOINT =
  'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** RFC 7636: a 43–128 character verifier and its S256 challenge. */
export function pkcePair() {
  const verifier = randomToken(48);
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function authorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
}) {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: input.scopes.join(' '),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    // Always show consent so Google issues a refresh token for exactly these scopes.
    prompt: 'consent',
    include_granted_scopes: 'false',
  });
  return `${GOOGLE_AUTHORIZATION_ENDPOINT}?${params.toString()}`;
}

/** The validity of a stored state at callback time (single use, unexpired, same initiator). */
export function oauthStateProblem(
  state: {
    consumedAt: Date | null;
    expiresAt: Date;
    initiatedByUserId: string;
    browserBindingHash: string;
  },
  now: Date,
  caller: { userId?: string | null; browserNonce?: string | null },
):
  | null
  | 'OAUTH_STATE_USED'
  | 'OAUTH_STATE_EXPIRED'
  | 'OAUTH_STATE_OTHER_USER'
  | 'OAUTH_STATE_UNBOUND' {
  if (state.consumedAt) return 'OAUTH_STATE_USED';
  if (state.expiresAt.getTime() <= now.getTime()) return 'OAUTH_STATE_EXPIRED';
  if (!caller.userId && !caller.browserNonce) return 'OAUTH_STATE_UNBOUND';
  if (caller.userId && caller.userId !== state.initiatedByUserId)
    return 'OAUTH_STATE_OTHER_USER';
  if (
    caller.browserNonce &&
    sha256Hex(caller.browserNonce) !== state.browserBindingHash
  )
    return 'OAUTH_STATE_OTHER_USER';
  return null;
}

/**
 * The claims of an ID token received directly from Google's token endpoint over TLS (OpenID
 * Connect Core 3.1.3.7 allows skipping the signature check then). Issuer, audience, expiry and
 * a verified email are still checked; `hd` is the Workspace hosted domain.
 */
export function idTokenIdentity(
  idToken: string | null | undefined,
  clientId: string,
  now: Date,
): { email: string; hostedDomain: string | null } | null {
  if (!idToken) return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    claims.iss !== 'https://accounts.google.com' &&
    claims.iss !== 'accounts.google.com'
  )
    return null;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(clientId)) return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < now.getTime())
    return null;
  if (typeof claims.email !== 'string' || claims.email_verified !== true)
    return null;
  const email = claims.email.trim().toLowerCase();
  if (!isEmailAddress(email)) return null;
  const hd =
    typeof claims.hd === 'string' && isDomain(claims.hd.toLowerCase())
      ? claims.hd.toLowerCase()
      : null;
  return { email, hostedDomain: hd };
}

// ─── Service-account keys and JWT assertions ─────────────────────────────────

/** The minimal key material kept (encrypted) for a service account: never the rest of the JSON. */
export interface ServiceAccountCredential {
  clientEmail: string;
  privateKeyId: string;
  privateKey: string;
}

export type ServiceAccountKeyProblem =
  | 'SERVICE_ACCOUNT_KEY_NOT_JSON'
  | 'SERVICE_ACCOUNT_KEY_TYPE'
  | 'SERVICE_ACCOUNT_KEY_FIELDS'
  | 'SERVICE_ACCOUNT_KEY_TOKEN_URI'
  | 'SERVICE_ACCOUNT_KEY_PRIVATE_KEY';

/**
 * Validates the shape of a Google service-account JSON key and extracts the minimal material.
 * The token URI must be Google's (the key never chooses where assertions are sent).
 */
export function parseServiceAccountKey(
  input: string,
): ServiceAccountCredential | ServiceAccountKeyProblem {
  let key: unknown;
  try {
    key = JSON.parse(input);
  } catch {
    return 'SERVICE_ACCOUNT_KEY_NOT_JSON';
  }
  if (!key || typeof key !== 'object' || Array.isArray(key))
    return 'SERVICE_ACCOUNT_KEY_NOT_JSON';
  const value = key as Record<string, unknown>;
  if (value.type !== 'service_account') return 'SERVICE_ACCOUNT_KEY_TYPE';
  const text = (field: string, max: number) =>
    typeof value[field] === 'string' &&
    (value[field] as string).length > 0 &&
    (value[field] as string).length <= max
      ? (value[field] as string)
      : null;
  const clientEmail = text('client_email', 320)?.toLowerCase() ?? null;
  const privateKeyId = text('private_key_id', 100);
  const privateKey = text('private_key', 10_000);
  if (
    !clientEmail ||
    !/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/.test(clientEmail) ||
    !privateKeyId ||
    !/^[A-Za-z0-9]+$/.test(privateKeyId) ||
    !privateKey ||
    !text('project_id', 100)
  )
    return 'SERVICE_ACCOUNT_KEY_FIELDS';
  if (
    value.token_uri !== undefined &&
    value.token_uri !== GOOGLE_TOKEN_ENDPOINT
  )
    return 'SERVICE_ACCOUNT_KEY_TOKEN_URI';
  try {
    const parsed = createPrivateKey({ key: privateKey, format: 'pem' });
    if (parsed.asymmetricKeyType !== 'rsa')
      return 'SERVICE_ACCOUNT_KEY_PRIVATE_KEY';
  } catch {
    return 'SERVICE_ACCOUNT_KEY_PRIVATE_KEY';
  }
  return { clientEmail, privateKeyId, privateKey };
}

/** A self-signed RS256 JWT bearer assertion (RFC 7523) for domain-wide delegation. */
export function serviceAccountAssertion(
  credential: ServiceAccountCredential,
  input: { subject: string; scopes: readonly string[]; now: Date },
) {
  const iat = Math.floor(input.now.getTime() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: credential.privateKeyId };
  const claims = {
    iss: credential.clientEmail,
    sub: input.subject,
    scope: input.scopes.join(' '),
    aud: GOOGLE_TOKEN_ENDPOINT,
    iat,
    exp: iat + 3600,
  };
  const encode = (part: object) =>
    Buffer.from(JSON.stringify(part), 'utf8').toString('base64url');
  const unsigned = `${encode(header)}.${encode(claims)}`;
  const signature = signData(
    'RSA-SHA256',
    Buffer.from(unsigned, 'utf8'),
    credential.privateKey,
  ).toString('base64url');
  return `${unsigned}.${signature}`;
}

// ─── Small value checks ──────────────────────────────────────────────────────

const EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isEmailAddress(value: string) {
  return value.length <= 320 && EMAIL.test(value);
}

export function isDomain(value: string) {
  return /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
    value,
  );
}

export const FORM_ID = /^[A-Za-z0-9_-]{10,200}$/;
export const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{10,200}$/;
export const QUESTION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A short non-reversible reference to a form id for audit metadata. */
export function formIdHash(formId: string) {
  return sha256Hex(`google-form:${formId}`).slice(0, 16);
}

// ─── Field mapping (versioned, strict) ───────────────────────────────────────

export const MAPPING_SCHEMA_VERSION = 1;

export const DOCUMENT_KINDS = [
  'RESUME',
  'COVER_LETTER',
  'CERTIFICATE',
  'REFERENCE',
  'PORTFOLIO',
  'OTHER',
] as const satisfies readonly RecruitmentDocumentKind[];

/** The contract fields a form question may feed, per target. */
export const MAPPING_FIELDS: Record<
  GoogleFormBindingTarget,
  readonly string[]
> = {
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

const MULTI_VALUED = (field: string) =>
  field === 'answer' || field.startsWith('document.');

const REQUIRED_FIELDS: Record<GoogleFormBindingTarget, readonly string[]> = {
  PERFORMANCE_EVIDENCE: [],
  RECRUITMENT_INTAKE: ['candidate.firstName', 'candidate.lastName'],
  ONBOARDING_TASKS: [],
};

export interface FieldMappingEntry {
  questionId: string;
  field: string;
  /** Recruitment answers/documents: the label shown to recruiters (else the question title). */
  label?: string;
}

export interface FormFieldMapping {
  schemaVersion: 1;
  fields: FieldMappingEntry[];
  /** Performance only: report the quiz total score (default) or no score. */
  scoreSource?: 'QUIZ_TOTAL' | 'NONE';
}

export class MappingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MappingError';
  }
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0)
    throw new MappingError(
      'GOOGLE_MAPPING_INVALID',
      `Unknown mapping property ${where}${extra[0]}.`,
    );
}

/** Validates a mapping for a target (strict: unknown properties and fields are refused). */
export function validateFieldMapping(
  target: GoogleFormBindingTarget,
  input: unknown,
): FormFieldMapping {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new MappingError(
      'GOOGLE_MAPPING_INVALID',
      'mapping must be an object.',
    );
  const value = input as Record<string, unknown>;
  exactKeys(value, ['schemaVersion', 'fields', 'scoreSource'], '');
  if (value.schemaVersion !== MAPPING_SCHEMA_VERSION)
    throw new MappingError(
      'GOOGLE_MAPPING_VERSION',
      `mapping.schemaVersion must be ${MAPPING_SCHEMA_VERSION}.`,
    );
  if (!Array.isArray(value.fields) || value.fields.length > 100)
    throw new MappingError(
      'GOOGLE_MAPPING_INVALID',
      'mapping.fields must be a list of at most 100 entries.',
    );
  const allowed = MAPPING_FIELDS[target];
  const questions = new Set<string>();
  const single = new Set<string>();
  const fields: FieldMappingEntry[] = [];
  for (const [index, raw] of value.fields.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new MappingError(
        'GOOGLE_MAPPING_INVALID',
        `mapping.fields[${index}] must be an object.`,
      );
    const entry = raw as Record<string, unknown>;
    exactKeys(entry, ['questionId', 'field', 'label'], `fields[${index}].`);
    if (
      typeof entry.questionId !== 'string' ||
      !QUESTION_ID.test(entry.questionId)
    )
      throw new MappingError(
        'GOOGLE_MAPPING_INVALID',
        `mapping.fields[${index}].questionId is invalid.`,
      );
    if (typeof entry.field !== 'string' || !allowed.includes(entry.field))
      throw new MappingError(
        'GOOGLE_MAPPING_FIELD',
        `mapping.fields[${index}].field is not a ${target} contract field.`,
      );
    if (
      entry.label !== undefined &&
      (typeof entry.label !== 'string' ||
        entry.label.trim().length === 0 ||
        entry.label.length > 200 ||
        /[\r\n]/.test(entry.label))
    )
      throw new MappingError(
        'GOOGLE_MAPPING_INVALID',
        `mapping.fields[${index}].label must be a single line of 1–200 characters.`,
      );
    if (entry.label !== undefined && !MULTI_VALUED(entry.field))
      throw new MappingError(
        'GOOGLE_MAPPING_INVALID',
        'Only answers and documents take a label.',
      );
    if (questions.has(entry.questionId))
      throw new MappingError(
        'GOOGLE_MAPPING_DUPLICATE',
        'A question maps to one field only.',
      );
    if (!MULTI_VALUED(entry.field)) {
      if (single.has(entry.field))
        throw new MappingError(
          'GOOGLE_MAPPING_DUPLICATE',
          `Field ${entry.field} is mapped more than once.`,
        );
      single.add(entry.field);
    }
    questions.add(entry.questionId);
    fields.push({
      questionId: entry.questionId,
      field: entry.field,
      ...(entry.label !== undefined ? { label: entry.label.trim() } : {}),
    });
  }
  for (const required of REQUIRED_FIELDS[target]) {
    if (!single.has(required))
      throw new MappingError(
        'GOOGLE_MAPPING_REQUIRED',
        `Field ${required} must be mapped.`,
      );
  }
  if (value.scoreSource !== undefined) {
    if (target !== 'PERFORMANCE_EVIDENCE')
      throw new MappingError(
        'GOOGLE_MAPPING_INVALID',
        'scoreSource applies to performance evidence only.',
      );
    if (value.scoreSource !== 'QUIZ_TOTAL' && value.scoreSource !== 'NONE')
      throw new MappingError(
        'GOOGLE_MAPPING_INVALID',
        'scoreSource must be QUIZ_TOTAL or NONE.',
      );
  }
  return {
    schemaVersion: 1,
    fields,
    ...(value.scoreSource !== undefined
      ? { scoreSource: value.scoreSource as 'QUIZ_TOTAL' | 'NONE' }
      : {}),
  };
}

/** Checks a validated mapping against the form's questions (ids exist, kinds fit). */
export function mappingProblemsAgainstForm(
  mapping: FormFieldMapping,
  form: GoogleFormInfo,
): string | null {
  const questions = new Map(form.questions.map((q) => [q.questionId, q]));
  for (const entry of mapping.fields) {
    const question = questions.get(entry.questionId);
    if (!question) return 'GOOGLE_MAPPING_UNKNOWN_QUESTION';
    const isFile = question.kind === 'FILE_UPLOAD';
    if (entry.field.startsWith('document.') !== isFile)
      return 'GOOGLE_MAPPING_QUESTION_KIND';
  }
  return null;
}

// ─── Forms: normalized shapes (no raw payloads leave the adapter) ────────────

export interface GoogleFormQuestion {
  questionId: string;
  title: string;
  kind: 'TEXT' | 'CHOICE' | 'FILE_UPLOAD' | 'OTHER';
  pointValue: number | null;
}

export interface GoogleFormInfo {
  formId: string;
  title: string;
  /** DO_NOT_COLLECT, VERIFIED, RESPONDER_INPUT, or null when Google does not say. */
  emailCollection: string | null;
  questions: GoogleFormQuestion[];
}

export interface GoogleFormAnswer {
  texts: string[];
  files: Array<{
    fileId: string;
    fileName: string | null;
    mimeType: string | null;
  }>;
}

export interface GoogleFormResponse {
  responseId: string;
  createTime: string;
  lastSubmittedTime: string;
  respondentEmail: string | null;
  totalScore: number | null;
  answers: Record<string, GoogleFormAnswer>;
}

// ─── Cursor ──────────────────────────────────────────────────────────────────

/**
 * An RFC 3339 instant normalized to a fixed 9-digit fraction in UTC, so cursors compare as
 * text without losing Google's microsecond precision (a JS Date keeps milliseconds only).
 */
export function normalizeInstant(value: string): string | null {
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) return null;
  const [, date, time, fraction = '', zone] = match;
  const base = new Date(`${date}T${time}${zone}`);
  if (Number.isNaN(base.getTime())) return null;
  return `${base.toISOString().slice(0, 19)}.${fraction.padEnd(9, '0')}Z`;
}

export interface ResponseCursor {
  submittedAt: string;
  responseId: string;
}

export function compareCursor(a: ResponseCursor, b: ResponseCursor) {
  if (a.submittedAt !== b.submittedAt)
    return a.submittedAt < b.submittedAt ? -1 : 1;
  if (a.responseId === b.responseId) return 0;
  return a.responseId < b.responseId ? -1 : 1;
}

/** The responses strictly after a cursor, ordered by (submission time, id). */
export function responsesAfter(
  responses: readonly GoogleFormResponse[],
  cursor: ResponseCursor | null,
) {
  const keyed: Array<{ response: GoogleFormResponse; key: ResponseCursor }> =
    [];
  for (const response of responses) {
    const submittedAt = normalizeInstant(response.lastSubmittedTime);
    if (!submittedAt) continue;
    const key = { submittedAt, responseId: response.responseId };
    if (cursor && compareCursor(key, cursor) <= 0) continue;
    keyed.push({ response, key });
  }
  return keyed.sort((a, b) => compareCursor(a.key, b.key));
}

/** The Forms API filter for responses at or after a cursor (seconds; refined locally). */
export function responseFilter(cursor: ResponseCursor | null) {
  return cursor ? `timestamp >= ${cursor.submittedAt.slice(0, 19)}Z` : null;
}

// ─── Mapping responses to the domain contracts ───────────────────────────────

const text = (answer: GoogleFormAnswer | undefined, max = 2000) => {
  const value = answer?.texts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ');
  return value ? value.slice(0, max) : null;
};

function fieldValue(
  mapping: FormFieldMapping,
  response: GoogleFormResponse,
  field: string,
  max?: number,
) {
  const entry = mapping.fields.find((f) => f.field === field);
  return entry ? text(response.answers[entry.questionId], max) : null;
}

/**
 * Batch 7B (D1): the targets where a response is associated with an employee automatically
 * (evidence, task completion) and identity must therefore be trustworthy.
 */
export const IDENTITY_TARGETS: readonly GoogleFormBindingTarget[] = [
  'PERFORMANCE_EVIDENCE',
  'ONBOARDING_TASKS',
];
export const IDENTITY_UNVERIFIED = 'GOOGLE_FORM_IDENTITY_UNVERIFIED';

/**
 * Batch 7B (D1): the respondent's identity — only the email Google collected with VERIFIED
 * collection (the respondent's signed-in Google account). A respondent-typed email (collection
 * RESPONDER_INPUT) or a mapped email question is never proof of identity.
 */
export function trustedRespondentEmail(
  form: Pick<GoogleFormInfo, 'emailCollection'>,
  response: GoogleFormResponse,
) {
  if (form.emailCollection !== 'VERIFIED') return null;
  const email = (response.respondentEmail ?? '').trim().toLowerCase();
  return email && isEmailAddress(email) ? email : null;
}

/** An email the respondent claimed (typed or mapped) but Google did not verify, for HR review. */
function claimedEmail(
  mapping: FormFieldMapping,
  form: Pick<GoogleFormInfo, 'emailCollection'>,
  response: GoogleFormResponse,
  trusted: string | null,
) {
  const candidates = [
    fieldValue(mapping, response, 'respondentEmail', 320),
    form.emailCollection === 'VERIFIED' ? null : response.respondentEmail,
  ];
  for (const candidate of candidates) {
    const email = (candidate ?? '').trim().toLowerCase();
    if (email && isEmailAddress(email) && email !== trusted) return email;
  }
  return null;
}

export function toAssessmentResult(
  mapping: FormFieldMapping,
  form: GoogleFormInfo,
  response: GoogleFormResponse,
) {
  const maxScore = form.questions.reduce(
    (sum, question) => sum + (question.pointValue ?? 0),
    0,
  );
  const scored =
    (mapping.scoreSource ?? 'QUIZ_TOTAL') === 'QUIZ_TOTAL' &&
    response.totalScore !== null &&
    maxScore > 0;
  const trusted = trustedRespondentEmail(form, response);
  const claimed = claimedEmail(mapping, form, response, trusted);
  return {
    externalResultId: response.responseId,
    // Batch 7B (D1): matching uses the verified email only; an unverified claim is kept for
    // HR's review of the unmatched result, never used to match.
    respondentEmail: trusted,
    respondentReference:
      fieldValue(mapping, response, 'respondentReference', 200) ??
      (claimed ? `Unverified email: ${claimed}` : null),
    title: form.title.slice(0, 500) || null,
    completedAt: response.createTime,
    externalUpdatedAt: response.lastSubmittedTime,
    score: scored ? response.totalScore : null,
    maxScore: scored ? maxScore : null,
  };
}

export function toApplicationSubmission(
  mapping: FormFieldMapping,
  form: GoogleFormInfo,
  response: GoogleFormResponse,
) {
  const titles = new Map(form.questions.map((q) => [q.questionId, q.title]));
  const answers: Array<{ question: string; answer: string }> = [];
  const documents: Array<{
    kind: RecruitmentDocumentKind;
    title: string;
    provider: 'GOOGLE_DRIVE';
    externalFileId: string;
    fileName: string | null;
    mimeType: string | null;
  }> = [];
  for (const entry of mapping.fields) {
    const label = (
      entry.label ??
      titles.get(entry.questionId) ??
      'Question'
    ).slice(0, 200);
    const answer = response.answers[entry.questionId];
    if (entry.field === 'answer') {
      const value = text(answer);
      if (value) answers.push({ question: label, answer: value });
    } else if (entry.field.startsWith('document.')) {
      for (const file of answer?.files ?? []) {
        if (!DRIVE_FILE_ID.test(file.fileId)) continue;
        documents.push({
          kind: entry.field.slice(
            'document.'.length,
          ) as RecruitmentDocumentKind,
          title: label,
          provider: 'GOOGLE_DRIVE',
          externalFileId: file.fileId,
          fileName: file.fileName?.slice(0, 255) ?? null,
          mimeType: file.mimeType?.slice(0, 255) ?? null,
        });
      }
    }
  }
  const field = (name: string, max = 200) =>
    fieldValue(mapping, response, name, max);
  const email =
    field('candidate.email', 320)?.toLowerCase() ??
    response.respondentEmail?.toLowerCase() ??
    null;
  return {
    externalResponseId: response.responseId,
    submittedAt: response.createTime,
    externalUpdatedAt: response.lastSubmittedTime,
    openingCode: field('openingCode', 100),
    candidate: {
      firstName: field('candidate.firstName') ?? '',
      lastName: field('candidate.lastName') ?? '',
      preferredName: field('candidate.preferredName'),
      email,
      phone: field('candidate.phone', 50),
      location: field('candidate.location'),
    },
    answers: answers.slice(0, 50),
    documents: documents.slice(0, 20),
    sourceDetail: 'Google Forms',
  };
}

export function toTaskSubmission(
  form: Pick<GoogleFormInfo, 'formId' | 'emailCollection'>,
  response: GoogleFormResponse,
) {
  // Batch 7B (D1): only a verified identity completes an employee's task.
  const email = trustedRespondentEmail(form, response);
  return email
    ? {
        externalResourceId: form.formId,
        externalResponseId: response.responseId,
        respondentEmail: email,
        submittedAt: response.createTime,
      }
    : null;
}

// ─── Sync scheduling ─────────────────────────────────────────────────────────

export const SYNC_LEASE_MS = 15 * 60_000;
export const MANUAL_SYNC_MIN_INTERVAL_MS = 60_000;
const BACKOFF_BASE_MS = 15 * 60_000;
const BACKOFF_MAX_MS = 24 * 3_600_000;

/** Exponential backoff after consecutive failures: 15 min, 30 min, 1 h … capped at a day. */
export function nextSyncAfter(consecutiveFailures: number, now: Date) {
  if (consecutiveFailures <= 0) return null;
  const delay = Math.min(
    BACKOFF_BASE_MS * 2 ** Math.min(consecutiveFailures - 1, 20),
    BACKOFF_MAX_MS,
  );
  return new Date(now.getTime() + delay);
}

// ─── Gmail (RFC 5322 text/plain, base64url) ──────────────────────────────────

export class MessageHeaderError extends Error {
  constructor(
    readonly code: 'EMAIL_ADDRESS_INVALID' | 'EMAIL_SUBJECT_INVALID',
  ) {
    super(code);
    this.name = 'MessageHeaderError';
  }
}

function encodedWord(value: string) {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function wrap(value: string, width = 76) {
  const lines: string[] = [];
  for (let i = 0; i < value.length; i += width)
    lines.push(value.slice(i, i + width));
  return lines.join('\r\n');
}

/**
 * Builds a text/plain RFC 5322 message. Addresses must be plain addresses (no display names,
 * no CR/LF); the subject is RFC 2047 encoded after collapsing line breaks, and the body is
 * base64 — so no caller value can inject a header.
 */
export function buildPlainTextMessage(input: {
  from: string | null;
  to: string;
  subject: string;
  text: string;
  messageId?: string;
}) {
  for (const address of [input.to, input.from]) {
    if (address === null) continue;
    if (/[\r\n<>",;:\s]/.test(address) || !isEmailAddress(address))
      throw new MessageHeaderError('EMAIL_ADDRESS_INVALID');
  }
  const subject = input.subject.replace(/[\r\n\t]+/g, ' ').trim();
  if (!subject || subject.length > 500)
    throw new MessageHeaderError('EMAIL_SUBJECT_INVALID');
  const headers = [
    ...(input.from ? [`From: ${input.from}`] : []),
    `To: ${input.to}`,
    `Subject: ${encodedWord(subject)}`,
    ...(input.messageId && /^[A-Za-z0-9.@_-]{1,200}$/.test(input.messageId)
      ? [`X-HRMS-Notification: ${input.messageId}`]
      : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  const body = wrap(
    Buffer.from(input.text.replace(/\r?\n/g, '\r\n'), 'utf8').toString(
      'base64',
    ),
  );
  const message = `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
  return Buffer.from(message, 'utf8').toString('base64url');
}

// ─── Sheets export cells ─────────────────────────────────────────────────────

export type ExportCell = string | number | boolean | null;

/** Bounded export rows; values are sent RAW (never evaluated as formulas). */
export function exportRows(
  header: readonly string[],
  rows: readonly ExportCell[][],
) {
  if (header.length === 0 || header.length > 50)
    throw new Error('An export has 1–50 columns.');
  if (rows.length > 10_000)
    throw new Error('An export has at most 10,000 rows.');
  const cell = (value: ExportCell) =>
    typeof value === 'string' ? value.slice(0, 5000) : value;
  return [
    header.map((h) => String(h).slice(0, 200)),
    ...rows.map((row) => {
      if (row.length > header.length)
        throw new Error('A row has more cells than the header.');
      return row.map(cell);
    }),
  ];
}
