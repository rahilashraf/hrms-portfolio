'use client';

// Batch 10E-1: moved from application-page.tsx unchanged.
export type Run = (action: () => Promise<unknown>, message: string) => Promise<boolean>;
