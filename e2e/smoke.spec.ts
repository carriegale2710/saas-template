import { test, expect } from '@playwright/test';

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
};

let cspViolations: string[] = [];

// Credential-free: every Supabase request is answered by a stub.
test.beforeEach(async ({ page }) => {
  cspViolations = [];
  page.on('console', (m) => {
    if (m.text().includes('Content Security Policy')) cspViolations.push(m.text());
  });
  await page.route('http://127.0.0.1:54321/**', (r) => {
    const req = r.request();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    if (req.url().includes('/auth/v1/token'))
      return r.fulfill({
        status: 400,
        headers: cors,
        json: { error: 'invalid_grant', error_description: 'Invalid login credentials' },
      });
    return r.fulfill({ status: 200, headers: cors, json: [] });
  });
});

test.afterEach(() => {
  expect(cspViolations).toEqual([]);
});

test('landing page renders hero', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Production-Ready Template');
});

test('login form shows error on bad credentials', async ({ page }) => {
  await page.goto('/login');
  await page.getByPlaceholder('Email address').fill('a@example.com');
  await page.getByPlaceholder('Password').fill('wrong-password');
  await page.locator('button[type="submit"]').click();
  await expect(page.getByText('Invalid login credentials')).toBeVisible();
});

test('unauthenticated dashboard redirects away', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).not.toHaveURL(/\/dashboard$/);
});
