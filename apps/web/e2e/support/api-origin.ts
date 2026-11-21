/**
 * The API origin the web app under test calls. Every request to it is answered by the specs'
 * `page.route` mocks; nothing is ever reached. Production builds require an HTTPS API
 * (src/lib/api-config.ts), and `.invalid` is a reserved name that never resolves, so an
 * unmocked request fails instead of reaching a real API.
 */
export const API = process.env.E2E_API_URL ?? 'https://api.e2e.invalid';
