import { expect, test } from '@playwright/test';

test('explores the complete workspace and focuses a searched symbol', async ({ page }) => {
  await page.goto('/?token=e2e-token');

  await expect(page.getByRole('heading', { name: '完整空间' })).toBeVisible();
  await expect(page.getByRole('button', { name: /全部项目.*ALL PROJECTS/ })).toBeVisible();
  await expect(page.getByText('WORKSPACE NODES')).toBeVisible();
  await expect(page.getByText('COMPLETE', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: /API.*INDEXED/ }).click();
  await expect(page.getByRole('main').getByText('PROJECT SCOPE', { exact: true })).toBeVisible();
  await expect(page.getByText('API PROJECT', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: '04 调用图 CALL FLOW ↗' }).click();
  await expect(page.getByRole('heading', { name: '调用图' })).toBeVisible();

  await page.getByRole('textbox', { name: 'Search workspace graph' }).fill('login');
  await page.getByRole('button', { name: 'Run search' }).click();
  await page.getByRole('button', { name: 'method login API · src/auth.ts' }).click();

  await expect(page.getByText('FOCUSED PROJECTION')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'login', level: 2 })).toBeVisible();
  await expect(page.getByText('静态推导')).toBeVisible();
  await expect(page.getByRole('button', { name: '← 返回完整空间' })).toBeVisible();

  await page.getByRole('button', { name: /全部项目.*ALL PROJECTS/ }).click();
  await expect(page.getByText('COMPLETE WORKSPACE', { exact: true })).toBeVisible();
});

test('explores directional data flows and provider evidence', async ({ page }) => {
  await page.goto('/?token=e2e-token');

  await page.getByRole('button', { name: '05 数据链路 DATA FLOW ↗' }).click();
  await expect(page.getByRole('heading', { name: '数据链路' })).toBeVisible();
  await expect(page.getByText(/READS_FROM/)).toBeVisible();
  await expect(page.getByText(/WRITES_TO/)).toBeVisible();
  await expect(page.getByText('1 DIAGNOSTIC', { exact: true })).toBeVisible();
  await expect(page.getByText('TABLES', { exact: true })).toBeVisible();

  await page.getByRole('textbox', { name: 'Search workspace graph' }).fill('audit_log');
  await page.getByRole('button', { name: 'Run search' }).click();
  await page.getByRole('button', { name: /table audit_log API/ }).click();

  await expect(page.getByRole('heading', { name: 'audit_log', level: 2 })).toBeVisible();
  await expect(page.getByText('FLOW RELATIONS', { exact: true })).toBeVisible();
  await expect(page.getByText('java-mybatis', { exact: true }).first()).toBeVisible();
});
