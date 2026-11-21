'use client';

import type { FormEvent } from 'react';
import { useMemo, useState } from 'react';
import { recruitmentApi, type OfferInput } from '../../../lib/recruitment/api';
import type {
  ApplicationDetail,
  EmploymentType,
  Offer,
  OfferAction,
  PayBasis,
} from '../../../lib/recruitment/types';
import {
  EMPLOYMENT_TYPES,
  EmptyState,
  Field,
  formatDateOnly,
  inputClass,
  label,
  OfferStatusBadge,
  primaryButton,
  secondaryButton,
  Section,
} from '../recruitment-shared';
import { RecordCombobox } from '../../ui/record-combobox';
import { recruitmentOptionSource } from '../../../lib/recruitment/pickers';
import { Run } from './application-shared';

// Batch 10E-1: offers and the offer form (moved from application-page.tsx unchanged).
const OFFER_ACTION_LABELS: Record<OfferAction, string> = {
  approve: 'Approve offer',
  revise: 'Return to draft',
  send: 'Send offer',
  accept: 'Record acceptance',
  decline: 'Record decline',
  withdraw: 'Withdraw offer',
};
const OFFER_ACTION_MESSAGES: Record<OfferAction, string> = {
  approve: 'Offer approved.',
  revise: 'Offer returned to draft.',
  send: 'Offer sent.',
  accept: 'Offer acceptance recorded.',
  decline: 'Offer decline recorded.',
  withdraw: 'Offer withdrawn.',
};
const NEEDS_REASON: OfferAction[] = ['decline', 'withdraw'];

/** The actions the viewer may take on an offer, by its (date-derived) status. */
function offerActions(offer: Offer, application: ApplicationDetail): OfferAction[] {
  const { canManage, canApproveOffer } = application.actions;
  const status = offer.effectiveStatus;
  const out: OfferAction[] = [];
  if (status === 'DRAFT') {
    if (canApproveOffer) out.push('approve');
    if (canManage) out.push('withdraw');
  } else if (status === 'APPROVED') {
    if (canManage) out.push('send', 'revise', 'withdraw');
  } else if (status === 'SENT') {
    if (canManage) out.push('accept', 'decline', 'withdraw');
  } else if (status === 'EXPIRED' && offer.status === 'SENT') {
    if (canManage) out.push('withdraw');
  }
  return out;
}

export function OffersSection({
  application,
  busy,
  run,
}: {
  application: ApplicationDetail;
  busy: boolean;
  run: Run;
}) {
  const offers = application.offers ?? [];
  const [reason, setReason] = useState('');
  const [editing, setEditing] = useState<Offer | null>(null);
  const anyReason = offers.some((offer) =>
    offerActions(offer, application).some((action) => NEEDS_REASON.includes(action)),
  );
  return (
    <Section id="offers" title="Offers">
      {offers.length === 0 ? (
        <EmptyState>No offers yet.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {offers.map((offer) => {
            const available = offerActions(offer, application);
            return (
              <li
                key={offer.id}
                aria-label={`Offer ${offer.id}`}
                className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <OfferStatusBadge status={offer.effectiveStatus} />
                  <span className="font-medium text-slate-900">
                    {offer.currency} {offer.rateAmount}{' '}
                    {offer.payBasis === 'HOURLY' ? 'per hour' : 'per year'}
                  </span>
                  <span className="text-slate-600">
                    {label(offer.employmentType)} · starts {formatDateOnly(offer.startDate)}
                    {offer.expiresOn ? ` · accept by ${formatDateOnly(offer.expiresOn)}` : ''}
                  </span>
                </div>
                {offer.candidateTerms && (
                  <p className="whitespace-pre-wrap text-slate-700">{offer.candidateTerms}</p>
                )}
                {offer.internalNotes && (
                  <p className="text-xs text-slate-500">Internal notes: {offer.internalNotes}</p>
                )}
                {offer.declineReason && <p>Declined: {offer.declineReason}</p>}
                {offer.withdrawalReason && <p>Withdrawn: {offer.withdrawalReason}</p>}
                <div className="flex flex-wrap gap-2">
                  {offer.status === 'DRAFT' && application.actions.canManage && (
                    <button
                      type="button"
                      className={secondaryButton}
                      onClick={() => setEditing(editing?.id === offer.id ? null : offer)}
                    >
                      Edit offer
                    </button>
                  )}
                  {available.map((action) => (
                    <button
                      key={action}
                      type="button"
                      className={
                        action === 'approve' || action === 'send' || action === 'accept'
                          ? primaryButton
                          : secondaryButton
                      }
                      disabled={busy || (NEEDS_REASON.includes(action) && !reason.trim())}
                      onClick={() =>
                        void run(
                          () =>
                            recruitmentApi.offerAction(
                              offer.id,
                              action,
                              NEEDS_REASON.includes(action) ? reason.trim() : undefined,
                            ),
                          OFFER_ACTION_MESSAGES[action],
                        )
                      }
                    >
                      {OFFER_ACTION_LABELS[action]}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {anyReason && (
        <Field label="Reason (required to record a decline or withdraw an offer)">
          <input
            className={inputClass}
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
          />
        </Field>
      )}
      {editing && (
        <OfferForm
          key={editing.id}
          application={application}
          offer={editing}
          busy={busy}
          run={run}
          onDone={() => setEditing(null)}
        />
      )}
      {application.actions.canCreateOffer && !editing && (
        <OfferForm application={application} offer={null} busy={busy} run={run} />
      )}
    </Section>
  );
}

function OfferForm({
  application,
  offer,
  busy,
  run,
  onDone,
}: {
  application: ApplicationDetail;
  offer: Offer | null;
  busy: boolean;
  run: Run;
  onDone?(): void;
}) {
  // Batch 7A: positions the recruiter may place an opening on (GET /recruitment/options), so a
  // Recruiter without employee.manage never types an id. Converting the hire still checks
  // Core HR's permission to staff the position.
  const positions = useMemo(
    () => recruitmentOptionSource(application.organization.id, 'position'),
    [application.organization.id],
  );
  const [form, setForm] = useState({
    positionId: offer?.positionId ?? application.opening.positionId ?? '',
    employmentType: offer?.employmentType ?? application.opening.employmentType,
    startDate: offer?.startDate ?? '',
    payBasis: offer?.payBasis ?? ('HOURLY' as PayBasis),
    rateAmount: offer?.rateAmount ?? '',
    currency: offer?.currency ?? 'CAD',
    expiresOn: offer?.expiresOn ?? '',
    candidateTerms: offer?.candidateTerms ?? '',
    internalNotes: offer?.internalNotes ?? '',
  });
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    const input: OfferInput = {
      positionId: form.positionId.trim(),
      employmentType: form.employmentType as EmploymentType,
      startDate: form.startDate,
      payBasis: form.payBasis,
      rateAmount: form.rateAmount.trim(),
      currency: form.currency.trim().toUpperCase(),
      expiresOn: form.expiresOn || null,
      candidateTerms: form.candidateTerms.trim() || null,
      internalNotes: form.internalNotes.trim() || null,
    };
    const ok = await run(
      () =>
        offer
          ? recruitmentApi.updateOffer(offer.id, input)
          : recruitmentApi.createOffer(application.id, input),
      offer ? 'Offer updated.' : 'Offer drafted.',
    );
    if (ok) onDone?.();
  }
  return (
    <form
      aria-label={offer ? 'Edit offer' : 'Draft offer'}
      className="grid grid-cols-1 gap-3 border-t border-slate-100 pt-3 sm:grid-cols-3"
      onSubmit={(event) => void submit(event)}
    >
      <h3 className="text-sm font-semibold text-slate-900 sm:col-span-3">
        {offer ? 'Edit draft offer' : 'Draft an offer'}
      </h3>
      <RecordCombobox
        label="Position"
        required
        hint="Prefilled with the opening's position. Converting the hire later needs permission to staff it."
        source={positions}
        value={form.positionId}
        selected={
          form.positionId
            ? {
                id: form.positionId,
                label:
                  form.positionId === application.opening.positionId
                    ? "The opening's position"
                    : "The offer's current position",
              }
            : null
        }
        onChange={(id) => set('positionId')(id)}
        placeholder="Search positions"
        noResultsText="No matching positions."
      />
      <Field label="Offer employment type">
        <select
          className={inputClass}
          value={form.employmentType}
          onChange={(e) => set('employmentType')(e.currentTarget.value)}
        >
          {EMPLOYMENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {label(type)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Start date">
        <input
          className={inputClass}
          type="date"
          required
          value={form.startDate}
          onChange={(e) => set('startDate')(e.currentTarget.value)}
        />
      </Field>
      <Field label="Pay basis">
        <select
          className={inputClass}
          value={form.payBasis}
          onChange={(e) => set('payBasis')(e.currentTarget.value)}
        >
          <option value="HOURLY">Hourly</option>
          <option value="SALARY">Salary</option>
        </select>
      </Field>
      <Field label="Rate amount">
        <input
          className={inputClass}
          inputMode="decimal"
          required
          value={form.rateAmount}
          onChange={(e) => set('rateAmount')(e.currentTarget.value)}
        />
      </Field>
      <Field label="Currency">
        <input
          className={inputClass}
          required
          maxLength={3}
          value={form.currency}
          onChange={(e) => set('currency')(e.currentTarget.value)}
        />
      </Field>
      <Field label="Accept by">
        <input
          className={inputClass}
          type="date"
          value={form.expiresOn}
          onChange={(e) => set('expiresOn')(e.currentTarget.value)}
        />
      </Field>
      <div className="sm:col-span-3">
        <Field label="Candidate terms">
          <textarea
            className={inputClass}
            rows={3}
            value={form.candidateTerms}
            onChange={(e) => set('candidateTerms')(e.currentTarget.value)}
          />
        </Field>
      </div>
      <div className="sm:col-span-3">
        <Field label="Internal notes">
          <textarea
            className={inputClass}
            rows={2}
            value={form.internalNotes}
            onChange={(e) => set('internalNotes')(e.currentTarget.value)}
          />
        </Field>
      </div>
      <div className="flex gap-2">
        <button type="submit" className={primaryButton} disabled={busy}>
          {offer ? 'Save offer' : 'Draft offer'}
        </button>
        {onDone && (
          <button type="button" className={secondaryButton} onClick={onDone}>
            Cancel editing
          </button>
        )}
      </div>
    </form>
  );
}
