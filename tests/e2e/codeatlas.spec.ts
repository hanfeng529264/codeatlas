import { expect, test } from '@playwright/test';

test('explores the complete workspace and focuses a searched symbol', async ({ page }) => {
  await page.goto('/?token=e2e-token');

  await expect(page.getByRole('heading', { name: '完整空间' })).toBeVisible();
  await expect(page.getByText('WORKSPACE NODES')).toBeVisible();
  await expect(page.getByText('COMPLETE', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '04 调用图 CALL FLOW ↗' }).click();
  await expect(page.getByRole('heading', { name: '调用图' })).toBeVisible();

  await page.getByRole('textbox', { name: 'Search workspace graph' }).fill('login');
  await page.getByRole('button', { name: 'Run search' }).click();
  await page.getByRole('button', { name: 'method login src/auth.ts' }).click();

  await expect(page.getByText('FOCUSED PROJECTION')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'login', level: 2 })).toBeVisible();
  await expect(page.getByText('静态推导')).toBeVisible();
  await expect(page.getByRole('button', { name: '← 返回完整空间' })).toBeVisible();
});
