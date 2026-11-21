import type { ReactNode } from 'react';

export type MessageTone = 'success' | 'error' | 'info' | 'warning';

const TONES: Record<MessageTone, string> = {
  success: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  error: 'border-rose-300 bg-rose-50 text-rose-900',
  info: 'border-sky-300 bg-sky-50 text-sky-900',
  warning: 'border-amber-300 bg-amber-50 text-amber-950',
};

/**
 * Batch 3A — the inline result of a form or page action (D3: forms report inline; row and
 * list actions may use a toast). Errors are announced assertively (`role="alert"`), the
 * other tones politely (`role="status"`).
 */
export function InlineMessage({
  tone = 'info',
  children,
  as: Element = 'div',
  className = '',
}: {
  tone?: MessageTone;
  children: ReactNode;
  as?: 'div' | 'p';
  className?: string;
}) {
  return (
    <Element
      role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-lg border p-3 text-sm ${TONES[tone]} ${className}`.trim()}
    >
      {children}
    </Element>
  );
}
