-- Phase 15: onboarding tasks can reference policy documents and required document types.
-- (Enum values are added in their own migration, before any use.)
ALTER TYPE "WorkflowReferenceType" ADD VALUE 'POLICY_DOCUMENT';
ALTER TYPE "WorkflowReferenceType" ADD VALUE 'DOCUMENT_TYPE';
