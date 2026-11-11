import { expect, test } from '@playwright/test';

test('桌面显示实验库、实验日志和观测台，不宣称模型已连接', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/chat', (route) => route.abort('blockedbyclient'));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'CYBER//LAB' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: '实验库' })).toBeVisible();
  await expect(page.getByRole('main', { name: '实验日志' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: '实验观测台' })).toBeVisible();
  await expect(page.getByText('把问题变成可复现的实验。')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('神经链路 · 已连接');
  await expect(page.locator('#lab-run-state')).toContainText('待发起');
});

test('实验卡只填写输入框，不自动发送', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/chat', async (route) => { calls += 1; await route.abort(); });
  await page.goto('/');
  const card = page.locator('#suggestions .suggestion').first();
  const prompt = await card.getAttribute('data-prompt');
  expect(prompt).toBeTruthy();
  await card.click();
  await expect(page.getByLabel('输入消息')).toHaveValue(prompt!);
  await expect(page.getByLabel('输入消息')).toBeFocused();
  expect(calls).toBe(0);
});

test('代码块可切换自动换行并在刷新后恢复', async ({ page }) => {
  await page.route('**/api/chat', (route) => route.fulfill({
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
    body: `data: ${JSON.stringify({ delta: '```js\nconst code = 1;\n```' })}\n\ndata: [DONE]\n\n`,
  }));
  await page.goto('/');
  await page.getByLabel('输入消息').fill('代码格式');
  await page.getByRole('button', { name: '发送消息' }).click();
  const toggle = page.getByRole('button', { name: '自动换行' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.code-pre')).toHaveClass(/is-wrapped/);
  await page.reload();
  await expect(page.locator('.code-pre')).toHaveClass(/is-wrapped/);
  await expect(page.getByRole('button', { name: '自动换行' })).toHaveAttribute('aria-pressed', 'true');
});

for (const { width, height } of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 360, height: 800 },
]) {
  test(`${width}×${height} 不产生横向页面滚动，输入与发送可达`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.route('**/api/chat', (route) => route.abort('blockedbyclient'));
    await page.goto('/');
    const size = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(size.scroll).toBeLessThanOrEqual(size.client);
    await expect(page.getByLabel('输入消息')).toBeVisible();
    await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();
  });
}
