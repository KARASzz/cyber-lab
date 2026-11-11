import { expect, test } from '@playwright/test';

const response = 'data: {"delta":"观测结果：已验证"}\n\ndata: [DONE]\n\n';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/chat', (route) => route.fulfill({
    status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: response,
  }));
});

test('笔记与标签按实验隔离，刷新恢复，助手回答可追加', async ({ page }) => {
  await page.goto('/');
  await page.locator('#lab-notes').fill('第一项实验的结论');
  await page.locator('#lab-tag-input').fill(' 待复核 ');
  await page.locator('#lab-tag-add').click();
  await expect(page.locator('#lab-tags-list')).toContainText('待复核');
  await page.reload();
  await expect(page.locator('#lab-notes')).toHaveValue('第一项实验的结论');
  await expect(page.locator('#lab-tags-list')).toContainText('待复核');
  await page.getByLabel('输入消息').fill('验证记录');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#messages')).toContainText('观测结果：已验证');
  await page.getByRole('button', { name: '加入实验笔记' }).click();
  await expect(page.locator('#lab-notes')).toHaveValue(/观测结果：已验证/);
  await page.locator('#new-session-btn').click();
  await expect(page.locator('#lab-notes')).toHaveValue('');
  await expect(page.locator('#lab-tags-list')).not.toContainText('待复核');
  await page.locator('#project-list [data-action="switch-session"]').filter({ hasText: '验证记录' }).click();
  await expect(page.locator('#lab-notes')).toHaveValue(/第一项实验的结论/);
  await expect(page.locator('#lab-notes')).toHaveValue(/观测结果：已验证/);
});

test('删除实验只清理对应扩展记录，取消不改变数据', async ({ page }) => {
  await page.goto('/');
  await page.locator('#lab-notes').fill('保留直到确认删除');
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('cyberlab.annotations.v1'))).toContain('保留直到确认删除');
  const id = await page.locator('#project-list .session-row').first().getAttribute('data-session-id');
  await page.locator('#project-list .session-row').first().locator('[data-action="delete-session"]').click();
  await page.locator('#modal-cancel').click();
  expect(await page.evaluate((sessionId) => Object.hasOwn(JSON.parse(localStorage.getItem('cyberlab.annotations.v1') || '{}').sessions, sessionId), id)).toBe(true);
  await page.locator('#project-list .session-row').first().locator('[data-action="delete-session"]').click();
  await page.locator('#modal-confirm').click();
  expect(await page.evaluate((sessionId) => Object.hasOwn(JSON.parse(localStorage.getItem('cyberlab.annotations.v1') || '{}').sessions, sessionId), id)).toBe(false);
});

test('追加笔记写入失败时明确提示仅本次有效', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'cyberlab.annotations.v1' && (window as any).__denyNotes) {
        throw new DOMException('synthetic quota', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
  });
  await page.goto('/');
  await page.getByLabel('输入消息').fill('产生观测');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#messages')).toContainText('观测结果：已验证');
  await page.evaluate(() => { (window as any).__denyNotes = true; });
  await page.getByRole('button', { name: '加入实验笔记' }).click();
  await expect(page.locator('#lab-notes')).toHaveValue(/观测结果：已验证/);
  await expect(page.locator('#lab-note-status')).toContainText('仅本次');
  await expect(page.locator('#lab-announcement')).toContainText('仅本次');
  await expect(page.locator('#lab-storage-warning')).toBeVisible();
});

test('扩展存储损坏时不丢失旧对话，也不覆盖损坏原文', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('cyberchat.v1', JSON.stringify({
      version: 1, activeProjectId: 'p1', projects: [{
        id: 'p1', name: '旧项目', activeSessionId: 's1', createdAt: 1, updatedAt: 1,
        systemPrompt: { enabled: false, text: '', presetId: null },
        sessions: [{ id: 's1', title: '旧实验', createdAt: 1, updatedAt: 1,
          messages: [{ role: 'user', content: '原有对话', ts: 1 }] }],
      }],
    }));
    localStorage.setItem('cyberlab.annotations.v1', '{broken');
  });
  await page.goto('/');
  await expect(page.locator('#messages')).toContainText('原有对话');
  await expect(page.locator('#lab-storage-warning')).toBeVisible();
  await page.locator('#lab-notes').fill('临时笔记');
  await expect(page.locator('#lab-note-status')).toContainText('仅本次');
  expect(await page.evaluate(() => localStorage.getItem('cyberlab.annotations.v1'))).toBe('{broken');
});
