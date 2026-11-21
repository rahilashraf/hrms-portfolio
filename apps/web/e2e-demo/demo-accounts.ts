import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';

/**
 * Batch 11 — shared by the demo smoke suite and the portfolio screenshot capture: the demo
 * accounts' generated passwords (.demo/credentials.json, never committed) and a sign-in that
 * respects the API's sign-in rate limits.
 */
interface Account {
  role: string;
  email: string;
  password: string;
}
const CREDENTIALS =
  process.env.DEMO_CREDENTIALS ?? resolve(__dirname, '../../../.demo/credentials.json');
const accounts: Record<string, Account> = Object.fromEntries(
  (JSON.parse(readFileSync(CREDENTIALS, 'utf8')) as { accounts: Account[] }).accounts.map(
    (account) => [account.role, account],
  ),
);

export async function signIn(page: Page, role: string) {
  const account = accounts[role];
  if (!account?.password) throw new Error(`No demo password for ${role}; run pnpm demo first.`);
  await page.goto('/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  // The API limits sign-ins: 10 a minute per address (e.g. right after `pnpm demo`, whose seed
  // signs in too) and 5 per 15 minutes per account and address. A short wait of up to a minute is
  // waited out as a person would; the longer per-account lockout fails with a plain message.
  const limited = page.getByRole('alert').filter({ hasText: /Too many attempts/ });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect
      .poll(async () => /\/dashboard$/.test(page.url()) || (await limited.isVisible()), {
        timeout: 30_000,
      })
      .toBe(true);
    if (!(await limited.isVisible())) break;
    const message = await limited.innerText();
    const seconds = Number(message.match(/(\d+) seconds?/)?.[1] ?? Number.NaN);
    if (!(seconds <= 70)) {
      throw new Error(`Sign-in for ${account.email} is rate-limited (${message}). Wait and rerun.`);
    }
    await page.waitForTimeout((seconds + 2) * 1_000);
  }
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { level: 1, name: /^Welcome/ })).toBeVisible();
}
