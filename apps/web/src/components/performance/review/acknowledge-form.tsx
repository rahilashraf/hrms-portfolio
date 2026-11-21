'use client';

import { useState } from 'react';
import { inputClass, primaryButton } from '../performance-shared';

// Batch 10E-2: moved from review-page.tsx unchanged.
export function AcknowledgeForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit(comment: string | null): Promise<boolean>;
}) {
  const [comment, setComment] = useState('');
  return (
    <form
      aria-label="Acknowledge review"
      className="space-y-2 rounded-xl border border-indigo-200 bg-indigo-50 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit(comment.trim() || null);
      }}
    >
      <p className="text-sm text-slate-800">
        Acknowledge that you have seen this review. Acknowledging does not mean you agree; you can
        add a comment.
      </p>
      <label className="block text-sm text-slate-700">
        Comment (optional)
        <textarea
          className={inputClass}
          rows={3}
          value={comment}
          onChange={(e) => setComment(e.currentTarget.value)}
        />
      </label>
      <button type="submit" className={primaryButton} disabled={busy}>
        Acknowledge
      </button>
    </form>
  );
}
