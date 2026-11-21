import { ConflictException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  domainError,
  formatDate,
  jsonValue,
  requireActor,
  type DomainRequestContext,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import { GoogleApiError } from '../integrations/google/google-api.client.js';
import { CredentialCipherError } from '../integrations/google/google-credential-cipher.js';
import { GoogleIntegrationError } from '../integrations/google/google-forms.adapters.js';
import { GoogleSheetsExportService } from '../integrations/google/google-workspace.adapters.js';
import { BenefitsReportService } from './benefits-report.service.js';
import { CompensationReportService } from './compensation-report.service.js';
import { DocumentsReportService } from './documents-report.service.js';
import { LeaveReportService } from './leave-report.service.js';
import { PayrollReportService } from './payroll-report.service.js';
import { PerformanceReportService } from './performance-report.service.js';
import { RecruitmentReportService } from './recruitment-report.service.js';
import { ReportingAccessService } from './reporting-access.service.js';
import {
  capRows,
  type AreaReportService,
  type ReportResult,
} from './reporting-common.js';
import {
  describeFilters,
  exportFileName,
  toCsv,
  type RawReportFilters,
} from './reporting-domain.js';
import type { ReportArea } from './reporting-registry.js';
import { SchedulingReportService } from './scheduling-report.service.js';
import { TimeReportService } from './time-report.service.js';
import { WorkflowReportService } from './workflow-report.service.js';
import { WorkforceReportService } from './workforce-report.service.js';

/**
 * Phase 17 — runs reports at request time over the authoritative domain tables (read-only; no
 * report or derived tables) and exports them. Running a report is a read and is not audited;
 * every export is, with identifiers and counts only (never report data).
 */
@Injectable()
export class ReportingService {
  private readonly areas: Record<ReportArea, AreaReportService>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ReportingAccessService,
    private readonly audit: AuditService,
    private readonly sheets: GoogleSheetsExportService,
    workforce: WorkforceReportService,
    time: TimeReportService,
    scheduling: SchedulingReportService,
    leave: LeaveReportService,
    compensation: CompensationReportService,
    payroll: PayrollReportService,
    benefits: BenefitsReportService,
    performance: PerformanceReportService,
    recruitment: RecruitmentReportService,
    workflows: WorkflowReportService,
    documents: DocumentsReportService,
  ) {
    this.areas = {
      workforce,
      time,
      scheduling,
      leave,
      compensation,
      payroll,
      benefits,
      performance,
      recruitment,
      onboarding: workflows,
      offboarding: workflows,
      documents,
    };
  }

  organizations(userId: string) {
    return this.access.organizations(userId);
  }

  catalog(userId: string, organizationId: string) {
    return this.access.catalog(userId, organizationId);
  }

  async run(
    userId: string,
    reportKey: string,
    organizationId: string,
    filters: RawReportFilters,
    forExport = false,
  ): Promise<ReportResult> {
    const scope = await this.access.resolve(
      userId,
      reportKey,
      organizationId,
      filters,
      forExport,
    );
    const output = await this.areas[scope.definition.area].run(scope);
    const notes = [...(output.notes ?? [])];
    const rows = capRows(output.rows, notes);
    // Batch 4F (Q9): a capped result is flagged (and its CSV export says so).
    const truncated = rows.length < output.rows.length;
    return {
      reportKey: scope.definition.key,
      area: scope.definition.area,
      title: scope.definition.title,
      generatedAt: scope.now.toISOString(),
      filters: { organizationId, ...describeFilters(scope.filters) },
      scopeSummary: scope.summary,
      columns: [...scope.definition.columns],
      rows,
      suppressed: output.suppressed ?? 0,
      notes,
      truncated,
    };
  }

  async exportCsv(
    reportKey: string,
    organizationId: string,
    filters: RawReportFilters,
    context: DomainRequestContext,
  ) {
    const actor = requireActor(context);
    const result = await this.run(
      actor,
      reportKey,
      organizationId,
      filters,
      true,
    );
    await this.auditExport(result, 'CSV', context);
    return {
      fileName: exportFileName(result.reportKey, new Date(result.generatedAt)),
      content: toCsv(
        result.columns,
        result.rows,
        result.truncated ? truncationNote(result.rows.length) : null,
      ),
      truncated: result.truncated,
    };
  }

  async exportGoogleSheets(
    reportKey: string,
    organizationId: string,
    filters: RawReportFilters,
    context: DomainRequestContext,
  ) {
    const actor = requireActor(context);
    const result = await this.run(
      actor,
      reportKey,
      organizationId,
      filters,
      true,
    );
    // Phase 18: exports to Google Sheets need Google Workspace enabled.
    await this.access.features.require(organizationId, 'GOOGLE_WORKSPACE');
    let exported: { spreadsheetId: string; rows: number };
    try {
      exported = await this.sheets.export(organizationId, {
        title: `${result.title} ${formatDate(new Date(result.generatedAt))}`,
        header: result.columns.map((column) => column.label),
        rows: [
          ...result.rows.map((row) =>
            result.columns.map((column) => row[column.key] ?? null),
          ),
          // Batch 4F (Q9): a capped export says so in the sheet itself, never looking complete.
          ...(result.truncated
            ? [
                [
                  `TRUNCATED: ${truncationNote(result.rows.length)}`,
                  ...result.columns.slice(1).map(() => null),
                ],
              ]
            : []),
        ],
      });
    } catch (error) {
      if (
        error instanceof GoogleIntegrationError &&
        error.code === 'GOOGLE_NOT_CONNECTED'
      ) {
        throw new ConflictException(
          domainError(
            409,
            'GOOGLE_CONNECTION_REQUIRED',
            'Exporting to Google Sheets needs an active Google Workspace connection with the Sheets export capability.',
          ),
        );
      }
      if (
        error instanceof GoogleIntegrationError ||
        error instanceof GoogleApiError ||
        error instanceof CredentialCipherError
      ) {
        throw new ConflictException(
          domainError(
            409,
            'GOOGLE_EXPORT_FAILED',
            'Google Sheets did not accept the export. Check the Google Workspace connection.',
          ),
        );
      }
      throw error;
    }
    await this.auditExport(result, 'GOOGLE_SHEETS', context, {
      spreadsheetId: exported.spreadsheetId,
    });
    return {
      spreadsheetId: exported.spreadsheetId,
      truncated: result.truncated,
    };
  }

  /** Report key, organization, filters, counts and format — never report data. */
  private auditExport(
    result: ReportResult,
    format: 'CSV' | 'GOOGLE_SHEETS',
    context: DomainRequestContext,
    extra: Record<string, string> = {},
  ) {
    return this.audit.write(
      {
        action: 'REPORT_EXPORTED',
        actorUserId: context.actorUserId,
        entityType: 'Organization',
        entityId: result.filters.organizationId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: jsonValue({
          reportKey: result.reportKey,
          format,
          filters: result.filters,
          rowCount: result.rows.length,
          suppressed: result.suppressed,
          ...extra,
        }),
      },
      this.prisma,
    );
  }
}

/** Batch 4F (Q9): the marker text of a capped export (CSV last line, Sheets last row). */
function truncationNote(rows: number) {
  return `the export was capped at ${rows} rows; narrow the filters to export the rest.`;
}
