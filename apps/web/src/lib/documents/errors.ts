import { AuthApiError } from '../auth/types';
import { sharedErrorMessage } from '../features/errors';

export function isDocumentsForbidden(error: unknown): boolean {
  return error instanceof AuthApiError && error.status === 403;
}

export function isDocumentsNotFound(error: unknown): boolean {
  return error instanceof AuthApiError && error.status === 404;
}

/** The domain error code of a 400/409 documents response (e.g. POLICY_VERSION_NOT_CURRENT). */
export function documentsErrorCode(error: unknown): string | null {
  if (!(error instanceof AuthApiError)) return null;
  const code = error.details?.code;
  return typeof code === 'string' ? code : null;
}

/** The current version a POLICY_VERSION_NOT_CURRENT conflict points at, or null. */
export function currentPolicyVersionId(error: unknown): string | null {
  if (documentsErrorCode(error) !== 'POLICY_VERSION_NOT_CURRENT') return null;
  const id = (error as AuthApiError).details?.currentVersionId;
  return typeof id === 'string' ? id : null;
}

/** Friendly messages for the documents domain error codes (the API's message is the fallback). */
export const DOCUMENTS_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  DOCUMENT_CODE_INVALID:
    'Codes are 2–64 characters: letters, digits, "_" or "-" (for example FIRST-AID).',
  DOCUMENT_TEXT_REQUIRED: 'Fill in the required fields.',
  DOCUMENT_TEXT_TOO_LONG: 'One of the fields is too long.',
  DOCUMENT_URL_INVALID: 'Document links must be https:// URLs.',
  DOCUMENT_FILE_ID_INVALID: 'The file ID has characters that are not allowed.',
  DOCUMENT_STORAGE_KEY_INVALID: 'Storage keys cannot be entered. Upload the file instead.',
  DOCUMENT_STORAGE_KEY_NOT_ACCEPTED: 'Storage keys cannot be entered. Upload the file instead.',
  DOCUMENT_REFERENCE_REQUIRED:
    'Add where the document is: an uploaded file, an https link, or a Google Drive link or file ID.',
  // Batch 9: uploads and downloads.
  DOCUMENT_STORAGE_NOT_CONFIGURED:
    'File uploads are not available. Add a link or a manual reference instead.',
  DOCUMENT_STORAGE_UNAVAILABLE: 'File storage is unavailable right now. Please try again shortly.',
  DOCUMENT_FILE_TOO_LARGE: 'The file is larger than the upload limit.',
  DOCUMENT_FILE_TYPE_NOT_ALLOWED: 'Only PDF, PNG and JPEG files can be uploaded.',
  DOCUMENT_FILE_TYPE_MISMATCH:
    "The file name's extension does not match its contents (for example a PDF named .png). Rename it and try again.",
  DOCUMENT_FILE_MALFORMED: 'The file is damaged or incomplete. Export or scan it again.',
  DOCUMENT_FILE_EMPTY: 'The file is empty.',
  DOCUMENT_UPLOAD_INTERRUPTED: 'The upload was interrupted. Nothing was saved; try again.',
  DOCUMENT_UPLOAD_INVALID: 'The upload could not be used. Choose the file again.',
  DOCUMENT_UPLOAD_USED: 'This upload is already attached elsewhere. Choose the file again.',
  DOCUMENT_UPLOAD_EXPIRED: 'The upload expired before it was saved. Choose the file again.',
  DOCUMENT_UPLOAD_REQUIRED: 'Choose a file to upload.',
  DOCUMENT_UPLOAD_TARGET_INVALID: 'The upload is not for a document you can change.',
  DOCUMENT_SCAN_REQUIRED: 'Files cannot be accepted until malware scanning is available.',
  DOCUMENT_SCAN_UNAVAILABLE: 'Malware scanning is unavailable right now. Please try again later.',
  DOCUMENT_FILE_INFECTED: 'The malware scan flagged this file. It was not saved.',
  DOCUMENT_FILE_QUARANTINED:
    'The file is waiting for its malware scan and cannot be downloaded yet.',
  DOCUMENT_FILE_UNAVAILABLE: 'The file is not available for download.',
  DOCUMENT_LEGACY_REFERENCE:
    'This version refers to an earlier storage reference that cannot be downloaded here.',
  DOCUMENT_NOT_A_STORED_FILE: 'This version is a link or reference, not an uploaded file.',
  DOCUMENT_REQUIREMENT_ARCHIVED:
    'This requirement was already replaced or archived. Reload to see the current one.',
  DOCUMENT_REQUIREMENT_UNCHANGED: 'The replacement is the same as the current requirement.',
  POLICY_NOT_RETIRED: 'Only retired policies can be copied into a new draft.',
  DOCUMENT_MIME_INVALID: 'The media type is not valid (for example application/pdf).',
  DOCUMENT_SIZE_INVALID: 'The size must be a whole number of bytes.',
  DOCUMENT_EXPIRY_REQUIRED: 'This type of document needs its expiry date.',
  DOCUMENT_DATES_INVALID: 'The expiry date cannot be before the issue date.',
  DOCUMENT_TYPE_INVALID: 'Choose an active document type of this organization.',
  DOCUMENT_TYPE_EXISTS: 'A document type with this code already exists.',
  DOCUMENT_TYPE_REQUIRED: 'Archive the requirements that use this type first.',
  DOCUMENT_REQUIREMENT_EXISTS: 'This requirement already exists.',
  DOCUMENT_REQUIREMENT_INVALID:
    'The department, position or type does not belong to this organization.',
  DOCUMENT_ASSIGNMENT_INVALID: "The assignment is not the employee's in this organization.",
  DOCUMENT_ARCHIVED: 'The document is archived and can no longer change.',
  DOCUMENT_TASK_INVALID: 'The task is not one of your onboarding tasks.',
  DOCUMENT_HANDOFF_INVALID: 'Only current documents of the hired candidate can be moved.',
  DOCUMENT_NOT_AN_EMPLOYEE: 'Your account is not linked to an employee record.',
  DOCUMENT_NOT_EMPLOYEE_PROVIDED: 'HR records this type of document.',
  DOCUMENT_SELF_MANAGEMENT: 'You cannot manage your own employee records.',
  DOCUMENT_CLEARANCE_REQUIRED:
    'Managing documents at this confidentiality level needs the matching read permission.',
  POLICY_EXISTS: 'A policy with this code already exists.',
  POLICY_DRAFT_EXISTS: 'The policy already has a draft version. Publish it first.',
  POLICY_VERSION_PUBLISHED: 'The version is already published.',
  POLICY_STATEMENT_REQUIRED:
    'A policy that needs acknowledgement must state what employees acknowledge.',
  POLICY_RETIRED: 'The policy is retired and can no longer change.',
  POLICY_NOT_PUBLISHED: 'The policy is not published.',
  POLICY_VERSION_NOT_CURRENT:
    'A newer version of this policy was published. Review it before acknowledging.',
  POLICY_ACKNOWLEDGEMENT_REQUIRED: 'Confirm the acknowledgement statement.',
  POLICY_AUDIENCE_INVALID: 'The department belongs to another organization.',
};

/** Documents errors carry a readable message for validation and conflicts. */
export function documentsErrorMessage(
  error: unknown,
  fallback = 'Unable to load documents.',
): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'The upload was cancelled. Nothing was saved.';
  }
  if (!(error instanceof AuthApiError)) return fallback;
  const shared = sharedErrorMessage(error);
  if (shared) return shared;
  const code = documentsErrorCode(error);
  if (code && DOCUMENTS_ERROR_MESSAGES[code]) return DOCUMENTS_ERROR_MESSAGES[code];
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403) {
    return error.validationMessage || 'You do not have permission for this documents action.';
  }
  if (code === 'UPLOAD_NETWORK') {
    return 'The connection was lost during the upload. Nothing was saved; try again.';
  }
  if (error.status === 404) return 'The document record was not found.';
  if (error.status === 413) return DOCUMENTS_ERROR_MESSAGES.DOCUMENT_FILE_TOO_LARGE!;
  if (error.status === 415) return DOCUMENTS_ERROR_MESSAGES.DOCUMENT_FILE_TYPE_NOT_ALLOWED!;
  if (error.status === 409) {
    return error.validationMessage || 'This change conflicts with the current state of the record.';
  }
  if (error.status === 400) return error.validationMessage || 'Check the details and try again.';
  if (error.status >= 500) return 'The Documents service is unavailable. Please try again.';
  return fallback;
}
