import { z } from 'zod';

export const passwordSchema = z.string().refine((password) => {
  const length = Array.from(password).length;
  return length >= 12 && length <= 128;
}, 'Password must be between 12 and 128 characters');
