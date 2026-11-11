import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/chat', (route) => route.abort('blockedbyclient'));
});

test('窄屏项目抽屉限制焦点，Escape 关闭并回到触发按钮', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const trigger = page.getByRole('button', { name: '打开项目栏' });
  await trigger.click();
  await expect(page.locator('#sidebar')).toBeVisible();
  await expect(page.locator('#sidebar-close')).toBeFocused();
  expect(await page.locator('.chat-panel').evaluate((el) => (el as HTMLElement).inert)).toBe(true);
  for (let i = 0; i < 20; i += 1) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('#sidebar'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('窄屏观测台限制焦点，Escape 关闭且不触发停止生成', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const trigger = page.getByRole('button', { name: '打开观测台' });
  await trigger.click();
  await expect(page.getByRole('complementary', { name: '实验观测台' })).toBeVisible();
  expect(await page.locator('.chat-panel').evaluate((el) => (el as HTMLElement).inert)).toBe(true);
  for (let i = 0; i < 25; i += 1) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('#sys-panel'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();
});

test('原生项目弹窗关闭后恢复焦点', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const trigger = page.locator('#new-project-btn');
  await trigger.click();
  await expect(page.getByRole('dialog', { name: '新建项目' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '新建项目' })).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('首页没有严重或关键 axe 自动可访问性问题', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations.filter((violation) => ['serious', 'critical'].includes(violation.impact || ''))).toEqual([]);
});

test('reduced-motion 关闭非必要持续动画', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const running = await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length);
  expect(running).toBe(0);
});
