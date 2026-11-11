import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const sse = 'data: {"delta":"<img src=x onerror=alert(1)>安全结果"}\n\ndata: [DONE]\n\n';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/chat', (route) => route.fulfill({
    status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: sse,
  }));
});

async function backupDownload(page: import('@playwright/test').Page) {
  await page.locator('#lab-export-json').click();
  await expect(page.getByRole('dialog', { name: '备份当前工作区？' })).toContainText('私密');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#modal-confirm').click(),
  ]);
  const path = await download.path();
  return readFile(path!);
}

test('备份下载后合并导入，保留原选中实验并重建笔记引用', async ({ page }) => {
  await page.goto('/');
  await page.locator('#lab-notes').fill('原始笔记');
  await page.locator('#lab-tag-input').fill('可复现');
  await page.locator('#lab-tag-add').click();
  await page.getByLabel('输入消息').fill('备份测试');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#messages')).toContainText('安全结果');
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('cyberchat.v1') || '{}'));
  const backup = await backupDownload(page);
  const parsed = JSON.parse(backup.toString('utf8'));
  expect(parsed.format).toBe('cyberlab.backup');
  expect(parsed.annotations.sessions[before.projects[0].activeSessionId].notes).toBe('原始笔记');
  await page.locator('#lab-import-open').click();
  await page.locator('#lab-import-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: backup });
  await expect(page.locator('#lab-import-summary')).toContainText('项目 1');
  await expect(page.locator('#lab-import-confirm')).toBeEnabled();
  await page.locator('#lab-import-confirm').click();
  await expect(page.locator('#project-list .project-card')).toHaveCount(2);
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('cyberchat.v1') || '{}'));
  expect(after.activeProjectId).toBe(before.activeProjectId);
  expect(after.projects[1].id).not.toBe(before.projects[0].id);
  expect(after.projects[1].sessions[0].id).not.toBe(before.projects[0].sessions[0].id);
  await page.locator('#project-list .project-card').nth(1).locator('[data-action="switch-project"]').click();
  await expect(page.locator('#lab-notes')).toHaveValue('原始笔记');
  await expect(page.locator('#lab-tags-list')).toContainText('可复现');
  await expect(page.locator('#messages')).toContainText('安全结果');
  await expect(page.locator('#messages img')).toHaveCount(0);
  await page.locator('#lab-notes').fill('导入后继续编辑');
  await expect(page.locator('#lab-note-status')).toContainText('已保存');
  await page.reload();
  await expect(page.locator('#lab-notes')).toHaveValue('导入后继续编辑');
});

test('超限旧实验备份前明确提示不能直接导入', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('cyberchat.v1', JSON.stringify({
      version: 1, activeProjectId: 'p1', projects: [{
        id: 'p1', name: '旧项目', createdAt: 1, updatedAt: 1,
        systemPrompt: { enabled: false, text: '', presetId: null }, activeSessionId: 's1',
        sessions: [{ id: 's1', title: '长实验', createdAt: 1, updatedAt: 1,
          messages: Array.from({ length: 201 }, (_, i) => ({ role: 'user', content: `消息 ${i}`, ts: i + 1 })) }],
      }],
    }));
  });
  await page.goto('/');
  await page.locator('#lab-export-json').click();
  const dialog = page.getByRole('dialog', { name: '备份当前工作区？' });
  await expect(dialog).toContainText('不能直接导入');
  await expect(dialog).toContainText('200');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#modal-confirm').click()]);
  const backup = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(backup.chat.projects[0].sessions[0].messages).toHaveLength(201);
  await expect(page.locator('#lab-announcement')).toContainText('不能直接导入');
});

test('导出 Markdown 前提示隐私，文件包含完整实验内容', async ({ page }) => {
  await page.goto('/');
  await page.locator('#lab-notes').fill('实验结论');
  await page.getByLabel('输入消息').fill('Markdown 测试');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#messages')).toContainText('安全结果');
  await page.locator('#lab-export-md').click();
  await expect(page.getByRole('dialog', { name: '导出当前实验？' })).toContainText('私密');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#modal-confirm').click()]);
  const text = await readFile((await download.path())!, 'utf8');
  expect(text).toContain('Markdown 测试');
  expect(text).toContain('实验结论');
  expect(text).toContain('安全结果');
});

test('生成期间提示先结束观测，避免导出缺少部分结果', async ({ page }) => {
  await page.addInitScript(() => {
    window.fetch = (_input, init) => {
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(value) { controller = value; value.enqueue(new TextEncoder().encode('data: {"delta":"部分观测"}\n\n')); },
      });
      init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true });
      return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
    };
  });
  await page.goto('/');
  await page.getByLabel('输入消息').fill('进行中的实验');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#messages')).toContainText('部分观测');
  await page.locator('#lab-export-md').click();
  await expect(page.getByRole('dialog', { name: '请先结束当前观测' })).toBeVisible();
  await page.locator('#modal-confirm').click();
  await page.getByRole('button', { name: '停止生成' }).click();
});

test('大文件与取消导入不会改变现有工作区', async ({ page }) => {
  await page.goto('/');
  const before = await page.evaluate(() => localStorage.getItem('cyberchat.v1'));
  await page.locator('#lab-import-open').click();
  await page.locator('#lab-import-file').setInputFiles({ name: 'large.json', mimeType: 'application/json', buffer: Buffer.alloc(5 * 1024 * 1024 + 1, 32) });
  await expect(page.locator('#lab-import-summary')).toContainText('5 MiB');
  await expect(page.locator('#lab-import-confirm')).toBeDisabled();
  await page.locator('#lab-import-cancel').click();
  expect(await page.evaluate(() => localStorage.getItem('cyberchat.v1'))).toBe(before);
});

test('其他标签页更新后拒绝从陈旧状态导入', async ({ page, context }) => {
  await page.goto('/');
  const backup = await backupDownload(page);
  await page.locator('#lab-import-open').click();
  await page.locator('#lab-import-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: backup });
  await expect(page.locator('#lab-import-confirm')).toBeEnabled();

  const other = await context.newPage();
  await other.setViewportSize({ width: 1440, height: 900 });
  await other.goto('/');
  await other.locator('#new-project-btn').click();
  await other.locator('#modal-input').fill('另一个标签页的项目');
  await other.locator('#modal-confirm').click();
  const latest = await other.evaluate(() => localStorage.getItem('cyberchat.v1'));

  await page.locator('#lab-import-confirm').click();
  await expect(page.locator('#lab-import-summary')).toContainText('其他标签页');
  expect(await page.evaluate(() => localStorage.getItem('cyberchat.v1'))).toBe(latest);
  expect(latest).toContain('另一个标签页的项目');
  await other.close();
});

test('导入写入失败时恢复原工作区和笔记，不报成功', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'cyberchat.v1' && (window as any).__failImportWrite) {
        (window as any).__failImportWrite = false;
        throw new DOMException('synthetic quota', 'QuotaExceededError');
      }
      return original.call(this, key, value);
    };
  });
  await page.goto('/');
  await page.locator('#lab-notes').fill('不可丢失的笔记');
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('cyberlab.annotations.v1'))).toContain('不可丢失的笔记');
  const backup = await backupDownload(page);
  const before = await page.evaluate(() => ({ chat: localStorage.getItem('cyberchat.v1'), annotations: localStorage.getItem('cyberlab.annotations.v1') }));
  await page.locator('#lab-import-open').click();
  await page.locator('#lab-import-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: backup });
  await expect(page.locator('#lab-import-confirm')).toBeEnabled();
  await page.evaluate(() => { (window as any).__failImportWrite = true; });
  await page.locator('#lab-import-confirm').click();
  await expect(page.locator('#lab-import-summary')).toContainText('导入未完成');
  const after = await page.evaluate(() => ({ chat: localStorage.getItem('cyberchat.v1'), annotations: localStorage.getItem('cyberlab.annotations.v1'), journal: localStorage.getItem('cyberlab.import.transaction.v1') }));
  expect(after.chat).toBe(before.chat);
  expect(after.annotations).toBe(before.annotations);
  expect(after.journal).toBeNull();
  await expect(page.locator('#project-list .project-card')).toHaveCount(1);
});
