import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('浏览器离线与恢复只改变网络徽标，不伪造服务状态', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('#lab-network')).toHaveText('浏览器在线');
  await context.setOffline(true);
  await expect(page.locator('#lab-network')).toHaveText('浏览器离线');
  await expect(page.locator('#lab-run-state')).toHaveText('待发起实验');
  await context.setOffline(false);
  await expect(page.locator('#lab-network')).toHaveText('浏览器在线');
  await expect(page.locator('#lab-run-state')).toHaveText('待发起实验');
});

test('主存储损坏时保留原文并显示持久警告', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('cyberchat.v1', '{坏的原始数据'));
  await page.goto('/');
  await expect(page.locator('#lab-storage-warning')).toContainText('原始内容未覆盖');
  await page.locator('#new-project-btn').click();
  await page.locator('#modal-input').fill('仅内存项目');
  await page.locator('#modal-confirm').click();
  await expect(page.locator('#lab-storage-warning')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('cyberchat.v1'))).toBe('{坏的原始数据');
});

test('存储读取被拒绝时不尝试覆盖未知数据', async ({ page }) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    (window as any).__writes = [];
    Storage.prototype.getItem = function (key) {
      if (key === 'cyberchat.v1' || key === 'cyberlab.annotations.v1' || key === 'cyberlab.import.transaction.v1') {
        throw new DOMException('blocked', 'SecurityError');
      }
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      (window as any).__writes.push(key);
      return set.call(this, key, value);
    };
  });
  await page.goto('/');
  await expect(page.locator('#lab-storage-warning')).toBeVisible();
  await page.locator('#new-project-btn').click();
  await page.locator('#modal-input').fill('内存中的项目');
  await page.locator('#modal-confirm').click();
  const writes = await page.evaluate(() => (window as any).__writes);
  expect(writes).not.toContain('cyberchat.v1');
  expect(writes).not.toContain('cyberlab.annotations.v1');
});

test('其他标签页更新后陈旧页面不会覆盖对话', async ({ page, context }) => {
  await page.goto('/');
  const other = await context.newPage();
  await other.setViewportSize({ width: 1440, height: 900 });
  await other.goto('/');
  await other.locator('#new-project-btn').click();
  await other.locator('#modal-input').fill('另一个标签页的数据');
  await other.locator('#modal-confirm').click();
  const latest = await other.evaluate(() => localStorage.getItem('cyberchat.v1'));

  await page.locator('#new-project-btn').click();
  await page.locator('#modal-input').fill('陈旧页面的项目');
  await page.locator('#modal-confirm').click();
  await expect(page.locator('#lab-storage-warning')).toContainText('其他标签页');
  expect(await page.evaluate(() => localStorage.getItem('cyberchat.v1'))).toBe(latest);
  expect(latest).toContain('另一个标签页的数据');
  await other.close();
});

test('协议写入失败时不会显示已保存', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'cyberchat.v1' && (window as any).__denyChat) {
        throw new DOMException('synthetic quota', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
  });
  await page.goto('/');
  await page.clock.install();
  await page.evaluate(() => { (window as any).__denyChat = true; });
  await page.locator('#sys-input').fill('仅在内存中的协议');
  await page.clock.fastForward(400);
  await expect(page.locator('#sys-save-state')).toContainText('未保存');
  await expect(page.locator('#lab-storage-warning')).toBeVisible();
  await page.clock.fastForward(2000);
  await expect(page.locator('#sys-save-state')).toContainText('未保存');
});

test('4000 字协议可发送，4001 字未保存编辑不可发送', async ({ page }) => {
  const requests: any[] = [];
  await page.route('**/api/chat', async (route) => {
    requests.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'data: {"delta":"ok"}\n\ndata: [DONE]\n\n' });
  });
  await page.goto('/');
  await page.locator('label.switch').click();
  await page.locator('#sys-input').fill('a'.repeat(4000));
  await expect(page.locator('#sys-count')).toHaveText('4000 / 4000');
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('cyberchat.v1') || '{}').projects[0].systemPrompt.text.length)).toBe(4000);
  await page.getByLabel('输入消息').fill('有效协议');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#lab-run-state')).toHaveText('本次观测已完成');
  expect(requests[0].systemPrompt).toHaveLength(4000);
  await page.locator('#sys-input').fill('b'.repeat(4001));
  await expect(page.locator('#sys-warn')).toBeVisible();
  await page.getByLabel('输入消息').fill('无效协议');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#messages')).toContainText('超过 4000 字');
  expect(requests).toHaveLength(1);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cyberchat.v1') || '{}').projects[0].systemPrompt.text);
  expect(saved).toHaveLength(4000);
});

test('窄视口模拟 200% 缩放时输入和主要控件可达', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 450 });
  await page.goto('/');
  await expect(page.getByLabel('输入消息')).toBeVisible();
  await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();
  const sizes = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.width);
  await page.getByRole('button', { name: '打开观测台' }).click();
  await expect(page.getByRole('complementary', { name: '实验观测台' })).toBeVisible();
});
