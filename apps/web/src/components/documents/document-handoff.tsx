'use client';

import { checkboxClass } from '../ui/tokens';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ErrorBanner } from '../organization/shared';
import { documentsApi } from '../../lib/documents/api';
import { documentsErrorMessage, isDocumentsForbidden } from '../../lib/documents/errors';
import type { DocumentType, HandoffOutcome } from '../../lib/documents/types';
import type { CandidateDocument, DocumentKind } from '../../lib/recruitment/types';
import { Field, inputClass, label, primaryButton } from './documents-shared';

/** The default type code a candidate document kind most likely maps to. */
const KIND_TYPE_CODES: Record<DocumentKind, string> = {
  RESUME: 'RESUME',
  COVER_LETTER: 'OTHER',
  CERTIFICATE: 'CERTIFICATION',
  REFERENCE: 'OTHER',
  PORTFOLIO: 'OTHER',
  OTHER: 'OTHER',
};

function guessType(types: DocumentType[], code: string) {
  return (types.find((t) => t.code === code) ?? types.find((t) => t.code === 'OTHER') ?? types[0])
    ?.id;
}

/**
 * The explicit hand-off to Phase 15: moves selected candidate documents (and optionally the
 * accepted offer, as a record) into the hired employee's records, keeping provenance. Nothing
 * moves automatically; a document already moved is reported, not duplicated.
 */
export function DocumentHandoff({
  hireId,
  organizationId,
  employeeId,
  documents,
}: {
  hireId: string;
  organizationId: string;
  employeeId: string;
  documents: CandidateDocument[];
}) {
  const current = documents.filter((document) => !document.removedAt);
  const [types, setTypes] = useState<DocumentType[] | null>(null);
  const [typesError, setTypesError] = useState<string | null>(null);
  const [moved, setMoved] = useState<Map<string, string>>(new Map());
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [typeOf, setTypeOf] = useState<Record<string, string>>({});
  const [offer, setOffer] = useState(false);
  const [offerType, setOfferType] = useState('');
  const [outcomes, setOutcomes] = useState<HandoffOutcome[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      documentsApi
        .types(organizationId)
        .then((result) => {
          if (active) setTypes(result.items);
        })
        .catch((cause) => {
          if (active) setTypesError(documentsErrorMessage(cause, 'Unable to load document types.'));
        });
      // Which candidate documents already reached the employee's records (best effort).
      documentsApi
        .employeeRecords(employeeId)
        .then((result) => {
          if (!active) return;
          const found = new Map<string, string>();
          for (const item of result.items) {
            for (const document of item.documents) {
              if (
                document.provenance?.recruitmentHireId === hireId &&
                document.provenance.recruitmentDocumentId
              ) {
                found.set(document.provenance.recruitmentDocumentId, document.id);
              }
            }
          }
          setMoved(found);
        })
        .catch(() => undefined);
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [organizationId, employeeId, hireId]);

  const typeFor = (document: CandidateDocument) =>
    typeOf[document.id] ?? guessType(types ?? [], KIND_TYPE_CODES[document.kind]) ?? '';
  const offerTypeId = offerType || guessType(types ?? [], 'OFFER-LETTER') || '';
  const chosen = current.filter((document) => selected[document.id] && !moved.has(document.id));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await documentsApi.handoff(hireId, {
        documents: chosen.map((document) => ({
          recruitmentDocumentId: document.id,
          typeId: typeFor(document),
        })),
        offer: offer && offerTypeId ? { typeId: offerTypeId } : null,
      });
      setOutcomes(result.outcomes);
      setMoved((previous) => {
        const next = new Map(previous);
        for (const outcome of result.outcomes) {
          if (outcome.recruitmentDocumentId)
            next.set(outcome.recruitmentDocumentId, outcome.documentId);
        }
        return next;
      });
      setSelected({});
      setOffer(false);
    } catch (cause) {
      setError(
        isDocumentsForbidden(cause)
          ? 'You do not have permission to move documents to this employee’s records.'
          : documentsErrorMessage(cause, 'Unable to move the documents.'),
      );
    } finally {
      setBusy(false);
    }
  }

  const created = outcomes?.filter((o) => o.outcome === 'CREATED').length ?? 0;
  const skipped = outcomes?.filter((o) => o.outcome === 'ALREADY_HANDED_OFF').length ?? 0;
  return (
    <div
      role="region"
      aria-label="Move documents to employee record"
      className="space-y-3 border-t border-slate-100 pt-3"
    >
      <h3 className="text-sm font-semibold text-slate-900">Move documents to employee record</h3>
      <p className="text-xs text-slate-600">
        Choose which candidate documents become employee records. Nothing moves automatically, and
        each document is moved once.
      </p>
      {typesError && <ErrorBanner>{typesError}</ErrorBanner>}
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {outcomes && (
        <p role="status" className="text-sm text-slate-800">
          {created} moved to the employee record
          {skipped > 0 ? `, ${skipped} already moved earlier` : ''}.{' '}
          <Link
            href={`/admin/employees/${employeeId}`}
            className="font-medium text-indigo-700 underline"
          >
            Open employee documents
          </Link>
        </p>
      )}
      {types && types.length === 0 && (
        <p className="text-sm text-slate-600">
          The organization has no document types yet. Initialize the defaults in Documents
          administration first.
        </p>
      )}
      {current.length === 0 ? (
        <p className="text-sm text-slate-600">The candidate has no current documents.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {current.map((document) => {
            const movedId = moved.get(document.id);
            return (
              <li key={document.id} className="flex flex-wrap items-end gap-3">
                <label className="flex items-center gap-2 text-slate-800">
                  <input
                    type="checkbox"
                    disabled={Boolean(movedId)}
                    checked={Boolean(movedId) || Boolean(selected[document.id])}
                    onChange={(e) =>
                      setSelected({ ...selected, [document.id]: e.currentTarget.checked })
                    }
                    className={checkboxClass}
                  />
                  {document.title}
                  <span className="text-xs text-slate-500">{label(document.kind)}</span>
                </label>
                {movedId ? (
                  <Link
                    href={`/documents/records/${movedId}`}
                    className="text-xs font-medium text-emerald-800 underline"
                  >
                    Already moved — open record
                  </Link>
                ) : (
                  selected[document.id] &&
                  types &&
                  types.length > 0 && (
                    <Field label={`Record type for ${document.title}`}>
                      <select
                        className={inputClass}
                        value={typeFor(document)}
                        onChange={(e) =>
                          setTypeOf({ ...typeOf, [document.id]: e.currentTarget.value })
                        }
                      >
                        {types.map((type) => (
                          <option key={type.id} value={type.id}>
                            {type.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex items-center gap-2 text-slate-800">
          <input
            type="checkbox"
            checked={offer}
            onChange={(e) => setOffer(e.currentTarget.checked)}
            className={checkboxClass}
          />
          Also record the accepted offer
        </label>
        {offer && types && types.length > 0 && (
          <Field label="Offer letter type">
            <select
              className={inputClass}
              value={offerTypeId}
              onChange={(e) => setOfferType(e.currentTarget.value)}
            >
              {types.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <button
        type="button"
        className={primaryButton}
        disabled={busy || !types?.length || (chosen.length === 0 && !offer)}
        onClick={() => void submit()}
      >
        Move to employee record
      </button>
    </div>
  );
}
