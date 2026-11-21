import type { DocumentReferenceStatus } from '../../generated/prisma/client.js';
import {
  StorageAdapterUnavailableError,
  type DocumentStorageAdapter,
  type StoredReference,
} from '../../documents/document-storage.contract.js';
import {
  NotificationEmailTransport,
  NotificationTransportError,
  type NotificationEmailMessage,
} from '../../notifications/notification-email.transport.js';
import { GoogleApiError, type GoogleApiClient } from './google-api.client.js';
import { CredentialCipherError } from './google-credential-cipher.js';
import {
  buildPlainTextMessage,
  DRIVE_FILE_ID,
  exportRows,
  MessageHeaderError,
  type ExportCell,
} from './google-workspace-domain.js';
import type { GoogleWorkspaceRuntime } from './google-workspace-runtime.js';
import { GoogleIntegrationError } from './google-forms.adapters.js';

/**
 * Phase 16.5 — the Drive adapter of the Phase 15 document storage contract (registered under
 * DOCUMENT_STORAGE_ADAPTERS and used by documents.verify-references). A GOOGLE_DRIVE reference
 * is checked with its document's organization's own connection (drive.metadata.readonly):
 * exists and not trashed → OK; trashed or not found → MISSING; not shared with the connected
 * account → ACCESS_DENIED. Only the status is kept — never names, links or contents.
 */
export class GoogleDriveStorageAdapter implements DocumentStorageAdapter {
  readonly provider = 'GOOGLE_DRIVE' as const;

  constructor(
    private readonly runtime: GoogleWorkspaceRuntime,
    private readonly api: GoogleApiClient,
  ) {}

  async checkReference(
    reference: StoredReference,
  ): Promise<Exclude<DocumentReferenceStatus, 'UNKNOWN'>> {
    if (!reference.organizationId)
      throw new StorageAdapterUnavailableError('GOOGLE_ORGANIZATION_UNKNOWN');
    if (
      !reference.externalFileId ||
      !DRIVE_FILE_ID.test(reference.externalFileId)
    )
      return 'MISSING';
    const connection = await this.runtime.connectionFor(
      reference.organizationId,
      'DRIVE_METADATA',
    );
    if (!connection)
      throw new StorageAdapterUnavailableError('GOOGLE_NOT_CONNECTED');
    try {
      const file = await this.runtime.call(
        connection,
        'DRIVE_METADATA',
        (token) => this.api.getDriveFile(token, reference.externalFileId!),
      );
      return file.trashed ? 'MISSING' : 'OK';
    } catch (error) {
      if (error instanceof GoogleApiError) {
        if (error.code === 'GOOGLE_NOT_FOUND') return 'MISSING';
        if (error.code === 'GOOGLE_FORBIDDEN') return 'ACCESS_DENIED';
        if (error.authFailure)
          throw new StorageAdapterUnavailableError(error.code);
        throw new Error(error.code);
      }
      if (error instanceof CredentialCipherError)
        throw new StorageAdapterUnavailableError(error.code);
      throw error;
    }
  }
}

/**
 * Phase 16.5 — a NotificationEmailTransport routing each email by its notification's
 * organization: through that organization's Gmail connection (gmail.send) when it has an
 * ACTIVE one with the GMAIL_SEND capability, otherwise through the default transport. Gmail
 * failures are classified (rate limits / outages retryable; rejected messages permanent); a
 * refused credential marks the connection ERROR and the retry falls back to the default.
 */
export class GoogleWorkspaceEmailTransport extends NotificationEmailTransport {
  readonly provider = 'google-workspace-router';

  constructor(
    private readonly runtime: GoogleWorkspaceRuntime,
    private readonly api: GoogleApiClient,
    private readonly fallback: NotificationEmailTransport,
  ) {
    super();
  }

  /** Batch 8 (D3): Gmail for an organization with a gmail.send connection, else the fallback's. */
  override async providerFor(organizationId: string) {
    const connection = await this.runtime.connectionFor(
      organizationId,
      'GMAIL_SEND',
    );
    return connection ? 'gmail' : this.fallback.providerFor(organizationId);
  }

  async send(message: NotificationEmailMessage) {
    const connection = message.organizationId
      ? await this.runtime.connectionFor(message.organizationId, 'GMAIL_SEND')
      : null;
    if (!connection) {
      const result = await this.fallback.send(message);
      return {
        providerReference: result.providerReference
          ? `${this.fallback.provider}:${result.providerReference}`.slice(
              0,
              200,
            )
          : null,
      };
    }
    let raw: string;
    try {
      raw = buildPlainTextMessage({
        from: connection.accountEmail,
        to: message.to,
        subject: message.subject,
        text: message.text,
        messageId: message.notificationId,
      });
    } catch (error) {
      if (error instanceof MessageHeaderError)
        throw new NotificationTransportError(
          error.code,
          false,
          'The message was refused.',
        );
      throw error;
    }
    try {
      const sent = await this.runtime.call(connection, 'GMAIL_SEND', (token) =>
        this.api.sendGmailMessage(token, raw),
      );
      return { providerReference: `gmail:${sent.id}`.slice(0, 200) };
    } catch (error) {
      if (error instanceof GoogleApiError)
        throw new NotificationTransportError(
          error.code,
          // Refused credentials: retried later through the default transport.
          error.retryable || error.authFailure,
          'Gmail refused or failed the send.',
        );
      if (error instanceof CredentialCipherError)
        throw new NotificationTransportError(
          error.code,
          true,
          'Credentials unavailable.',
        );
      throw error;
    }
  }
}

/**
 * Phase 16.5 — the Sheets export boundary for later reporting (Phase 17): creates a new
 * spreadsheet in the organization's connected account (drive.file — only files this app
 * creates) and appends rows to it, RAW (never evaluated as formulas). It never opens, reads or
 * edits any other spreadsheet.
 */
export class GoogleSheetsExportService {
  constructor(
    private readonly runtime: GoogleWorkspaceRuntime,
    private readonly api: GoogleApiClient,
  ) {}

  async export(
    organizationId: string,
    input: {
      title: string;
      header: readonly string[];
      rows: readonly ExportCell[][];
    },
  ): Promise<{ spreadsheetId: string; rows: number }> {
    const title = input.title
      .replace(/[\r\n\t]+/g, ' ')
      .trim()
      .slice(0, 200);
    if (!title)
      throw new GoogleIntegrationError('GOOGLE_EXPORT_TITLE_REQUIRED');
    const values = exportRows(input.header, input.rows);
    const connection = await this.runtime.connectionFor(
      organizationId,
      'SHEETS_EXPORT',
    );
    if (!connection) throw new GoogleIntegrationError('GOOGLE_NOT_CONNECTED');
    return this.runtime.call(connection, 'SHEETS_EXPORT', async (token) => {
      const { spreadsheetId } = await this.api.createSpreadsheet(
        token,
        title,
        'Export',
      );
      const appended = await this.api.appendValues(
        token,
        spreadsheetId,
        'Export!A1',
        values,
      );
      return { spreadsheetId, rows: appended.updatedRows };
    });
  }
}
