'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from '../shell/icons';

export type ToastTone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  notify(message: string, tone?: ToastTone): void;
  success(message: string): void;
  error(message: string): void;
}

const NOOP: ToastApi = {
  notify: () => undefined,
  success: () => undefined,
  error: () => undefined,
};
const ToastContext = createContext<ToastApi | null>(null);

export const TOAST_TIMEOUT_MS = 6000;

/**
 * Transient success/error notifications. Success and info toasts are announced politely
 * (`role="status"`), errors assertively (`role="alert"`); each can be dismissed.
 */
export function ToastProvider({
  children,
  timeoutMs = TOAST_TIMEOUT_MS,
}: {
  children: ReactNode;
  timeoutMs?: number;
}) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (message: string, tone: ToastTone = 'success') => {
      const id = next.current++;
      setToasts((current) => [...current.slice(-3), { id, tone, message }]);
      if (timeoutMs > 0) window.setTimeout(() => dismiss(id), timeoutMs);
    },
    [dismiss, timeoutMs],
  );

  const api = useMemo<ToastApi>(
    () => ({
      notify,
      success: (message) => notify(message, 'success'),
      error: (message) => notify(message, 'error'),
    }),
    [notify],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[70] flex flex-col items-center gap-2 p-4 sm:items-end">
        <div aria-live="polite" className="contents">
          {toasts
            .filter((toast) => toast.tone !== 'error')
            .map((toast) => (
              <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
            ))}
        </div>
        <div aria-live="assertive" className="contents">
          {toasts
            .filter((toast) => toast.tone === 'error')
            .map((toast) => (
              <ToastCard key={toast.id} toast={toast} onDismiss={dismiss} />
            ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss(id: number): void }) {
  const tone =
    toast.tone === 'error'
      ? 'border-rose-200 bg-rose-50 text-rose-900'
      : toast.tone === 'info'
        ? 'border-slate-200 bg-white text-slate-900'
        : 'border-emerald-200 bg-emerald-50 text-emerald-900';
  return (
    <div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border p-4 text-sm shadow-lg ${tone}`}
    >
      <Icon
        name={toast.tone === 'error' ? 'alert' : toast.tone === 'info' ? 'info' : 'check'}
        className="mt-0.5 size-4"
      />
      <p className="flex-1">{toast.message}</p>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
        className="rounded p-0.5 opacity-70 hover:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-current"
      >
        <Icon name="close" className="size-4" />
      </button>
    </div>
  );
}

/** Toasts when a provider is mounted; a silent no-op otherwise (e.g. isolated unit tests). */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}
