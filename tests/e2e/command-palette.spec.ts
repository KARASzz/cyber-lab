import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/chat', (route) => route.abort('blockedbyclient'));
  await page.addInitScript(() => {
    localStorage.setItem('cyberchat.v1', JSON.stringify({
      version: 1, activeProjectId: 'p1', projects: [{
        id: 'p1', name: '项目甲', createdAt: 1, updatedAt: 2,
        systemPrompt: { enabled: false, text: '', presetId: null }, activeSessionId: 's1',
        sessions: [
          { id: 's1', title: '第一个实验', createdAt: 1, updatedAt: 2, messages: [] },
          { id: 's2', title: '检索目标', createdAt: 1, updatedAt: 3,
            messages: [{ id: 'm1', role: 'user', content: '包含隐藏关键词的消息 <img src=x onerror="window.__searchXss=1"> 检索文本', ts: 1 }] },
        ],
      }],
    }));
    localStorage.setItem('cyberlab.annotations.v1', JSON.stringify({ version: 1, sessions: {
      s2: { notes: '笔记里的搜索线索', tags: ['待复核'], runs: {} },
    } }));
  });
});

test('快捷键打开搜索，按消息命中并跳回原实验', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.getByRole('dialog', { name: '命令与搜索' });
  await expect(dialog).toBeVisible();
  const input = page.locator('#lab-command-input');
  await expect(input).toBeFocused();
  await input.fill('隐藏关键词');
  await expect(page.locator('#lab-command-list')).toContainText('项目甲');
  await expect(page.locator('#lab-command-list')).toContainText('检索目标');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#head-session')).toHaveText('检索目标');
  await expect(page.locator('#messages')).toContainText('隐藏关键词');
});

test('命令可用键盘执行，无在途请求时停止项不可执行', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /打开命令与搜索/ }).click();
  await expect(page.locator('#lab-command-list')).toContainText('停止当前生成');
  await expect(page.locator('#lab-command-list [aria-disabled="true"]')).toContainText('停止当前生成');
  await page.locator('#lab-command-input').fill('新建项目');
  await expect(page.locator('#lab-command-list')).toContainText('新建项目');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: '新建项目' })).toBeVisible();
  await page.locator('#modal-input').fill('命令创建');
  await page.locator('#modal-confirm').click();
  await expect(page.locator('#head-project')).toContainText('命令创建');
});

test('搜索结果纯文本展示，不执行消息内 HTML', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('ControlOrMeta+k');
  await page.locator('#lab-command-input').fill('检索文本');
  await expect(page.locator('#lab-command-list')).toContainText('检索文本');
  await expect(page.locator('#lab-command-list img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__searchXss)).toBeUndefined();
});

test('中文输入法组合时 Enter 不执行命令', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('ControlOrMeta+k');
  const input = page.locator('#lab-command-input');
  await input.fill('新建项目');
  await expect(page.locator('#lab-command-list')).toContainText('新建项目');
  await input.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter', keyCode: 229, isComposing: true, bubbles: true,
  })));
  await expect(page.getByRole('dialog', { name: '命令与搜索' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '新建项目' })).toBeHidden();
});
