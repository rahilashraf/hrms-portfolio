import type { PrismaService } from '../../database/prisma.service.js';
import type { GoogleFormBinding } from '../../generated/prisma/client.js';
import type { GoogleApiClient } from './google-api.client.js';
import type {
  ExternalAssessmentProvider,
  ExternalAssessmentResult,
} from '../../performance/performance-evidence.contract.js';
import type {
  ExternalApplicationProvider,
  ExternalApplicationSubmission,
} from '../../recruitment/recruitment-intake.contract.js';
import {
  normalizeInstant,
  responseFilter,
  responsesAfter,
  toApplicationSubmission,
  toAssessmentResult,
  validateFieldMapping,
  type GoogleFormInfo,
  type GoogleFormResponse,
  type ResponseCursor,
} from './google-workspace-domain.js';
import type { GoogleWorkspaceRuntime } from './google-workspace-runtime.js';

/** A failure of the integration itself (not of a Google call): safe code only. */
export class GoogleIntegrationError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
    this.name = 'GoogleIntegrationError';
  }
}

const PAGE_SIZE = 500;
const MAX_PAGES = 200;

/**
 * Reads a bound form through its organization's own connection: the form's questions and the
 * responses after a cursor, in (submission time, id) order. Every page is read before anything
 * is returned (pages are not ordered), so a cursor never skips a response.
 */
export class GoogleFormsReader {
  constructor(
    private readonly runtime: GoogleWorkspaceRuntime,
    private readonly api: GoogleApiClient,
  ) {}

  async connection(organizationId: string) {
    const connection = await this.runtime.connectionFor(
      organizationId,
      'FORMS',
    );
    if (!connection) throw new GoogleIntegrationError('GOOGLE_NOT_CONNECTED');
    return connection;
  }

  /** The form's questions (bind-time verification that the organization can read it). */
  async form(organizationId: string, formId: string): Promise<GoogleFormInfo> {
    const connection = await this.connection(organizationId);
    return this.runtime.call(connection, 'FORMS', (token) =>
      this.api.getForm(token, formId),
    );
  }

  async responsesAfter(
    organizationId: string,
    formId: string,
    cursor: ResponseCursor | null,
  ) {
    const connection = await this.connection(organizationId);
    return this.runtime.call(connection, 'FORMS', async (token) => {
      const form = await this.api.getForm(token, formId);
      const all: GoogleFormResponse[] = [];
      let pageToken: string | null = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const result = await this.api.listFormResponses(token, formId, {
          filter: responseFilter(cursor),
          pageToken,
          pageSize: PAGE_SIZE,
        });
        all.push(...result.responses);
        pageToken = result.nextPageToken;
        if (!pageToken) break;
      }
      if (pageToken)
        throw new GoogleIntegrationError('GOOGLE_FORM_TOO_MANY_RESPONSES');
      return { form, responses: responsesAfter(all, cursor) };
    });
  }
}

export function bindingCursor(binding: {
  cursorSubmittedAt: string | null;
  cursorResponseId: string | null;
}): ResponseCursor | null {
  return binding.cursorSubmittedAt && binding.cursorResponseId
    ? {
        submittedAt: binding.cursorSubmittedAt,
        responseId: binding.cursorResponseId,
      }
    : null;
}

/** The later of the binding's cursor and a domain job's "since" instant. */
function cursorSince(binding: GoogleFormBinding, since: Date | null) {
  const own = bindingCursor(binding);
  const fromSince = since
    ? { submittedAt: normalizeInstant(since.toISOString())!, responseId: '' }
    : null;
  if (!own) return fromSince;
  if (!fromSince) return own;
  return own.submittedAt >= fromSince.submittedAt ? own : fromSince;
}

/**
 * The Google Forms adapter of the Phase 12 performance evidence contract (registered under
 * PERFORMANCE_EVIDENCE_PROVIDERS). It reads the source's live binding; ingestion stays the
 * performance domain's.
 */
export class GoogleFormsAssessmentProvider implements ExternalAssessmentProvider {
  readonly provider = 'GOOGLE_FORMS' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: GoogleFormsReader,
  ) {}

  async fetchResults(
    source: {
      id: string;
      externalResourceId: string;
      lastSyncedAt: Date | null;
    },
    since: Date | null,
  ): Promise<ExternalAssessmentResult[]> {
    const binding = await this.prisma.googleFormBinding.findFirst({
      where: {
        performanceSourceId: source.id,
        target: 'PERFORMANCE_EVIDENCE',
        archivedAt: null,
        enabled: true,
      },
    });
    if (!binding || binding.formId !== source.externalResourceId)
      throw new GoogleIntegrationError('GOOGLE_BINDING_NOT_FOUND');
    const mapping = validateFieldMapping(binding.target, binding.mapping);
    const { form, responses } = await this.reader.responsesAfter(
      binding.organizationId,
      binding.formId,
      cursorSince(binding, since),
    );
    return responses.map(({ response }) =>
      toAssessmentResult(mapping, form, response),
    );
  }
}

/** The Google Forms adapter of the Phase 13 recruitment intake contract. */
export class GoogleFormsApplicationProvider implements ExternalApplicationProvider {
  readonly provider = 'GOOGLE_FORMS' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: GoogleFormsReader,
  ) {}

  async fetchSubmissions(
    source: {
      id: string;
      externalResourceId: string;
      lastSyncedAt: Date | null;
    },
    since: Date | null,
  ): Promise<ExternalApplicationSubmission[]> {
    const binding = await this.prisma.googleFormBinding.findFirst({
      where: {
        recruitmentSourceId: source.id,
        target: 'RECRUITMENT_INTAKE',
        archivedAt: null,
        enabled: true,
      },
    });
    if (!binding || binding.formId !== source.externalResourceId)
      throw new GoogleIntegrationError('GOOGLE_BINDING_NOT_FOUND');
    const mapping = validateFieldMapping(binding.target, binding.mapping);
    const { form, responses } = await this.reader.responsesAfter(
      binding.organizationId,
      binding.formId,
      cursorSince(binding, since),
    );
    return responses.map(({ response }) =>
      toApplicationSubmission(mapping, form, response),
    );
  }
}
