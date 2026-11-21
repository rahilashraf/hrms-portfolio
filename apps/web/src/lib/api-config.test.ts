import { describe, expect, it } from 'vitest';
import { getApiBaseUrl } from './api-config';

describe('getApiBaseUrl', () => {
  it('normalizes a valid API URL', () => {
    expect(getApiBaseUrl('https://api.example.com/', true)).toBe('https://api.example.com');
  });

  it('requires an explicit URL and rejects unsafe production configuration', () => {
    expect(() => getApiBaseUrl('', false)).toThrow('NEXT_PUBLIC_API_URL is required');
    expect(() => getApiBaseUrl('http://api.example.com', true)).toThrow(/HTTPS in production/);
    expect(() => getApiBaseUrl('https://user:password@api.example.com', true)).toThrow();
    expect(() => getApiBaseUrl('https://api.example.com/v1', true)).toThrow();
  });
});
