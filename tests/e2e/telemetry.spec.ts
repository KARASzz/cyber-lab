import { expect, test } from '@playwright/test';

const requestId = '12345678-1234-4567-8abc-123456789abc';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('从响应头与实际流记录路径、模型、计时和字符数，刷新后恢复', async ({ page }) => {
  await page.route('**/api/chat', (route) => route.fulfill({
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'X-Request-Id': requestId,
      'X-AI-Route': 'gateway',
      'X-AI-Model': '@makers/deepseek-v4.1-flash',
    },
    body: 'data: {"delta":""}\n\ndata: {"delta":"你😊"}\n\ndata: [DONE]\n\n',
  }));
  await page.goto('/');
  await page.getByLabel('输入消息').fill('测量测试');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#lab-run-state')).toHaveText('本次观测已完成');
  await expect(page.locator('#lab-metric-model')).toHaveText('@makers/deepseek-v4.1-flash');
  await expect(page.locator('#lab-metric-route')).toContainText('gateway');
  await expect(page.locator('#lab-metric-request-id')).toHaveText(requestId);
  await expect(page.locator('#lab-metric-headers')).toContainText('ms');
  await expect(page.locator('#lab-metric-first-token')).toContainText('ms');
  await expect(page.locator('#lab-metric-duration')).toContainText('ms');
  await expect(page.locator('#lab-metric-characters')).toHaveText('3');
  await expect(page.locator('#lab-metric-history')).toHaveText('1');
  await expect(page.locator('#lab-metric-prompt')).toHaveText('0');
  const stored = await page.evaluate(() => {
    const chat = JSON.parse(localStorage.getItem('cyberchat.v1') || '{}');
    const project = chat.projects[0];
    const session = project.sessions.find((item: any) => item.id === project.activeSessionId);
    const messageId = session.messages.at(-1).id;
    const extensions = JSON.parse(localStorage.getItem('cyberlab.annotations.v1') || '{}');
    return extensions.sessions[session.id].runs[messageId];
  });
  expect(stored.outcome).toBe('complete');
  expect(stored.route).toBe('gateway');
  expect(stored.characters).toBe(3);
  await page.reload();
  await expect(page.locator('#lab-metric-route')).toContainText('gateway');
  await expect(page.locator('#lab-metric-first-token')).toContainText('ms');
});

test('未提供响应头时不虚构路径、模型和请求 ID', async ({ page }) => {
  await page.route('**/api/chat', (route) => route.fulfill({
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
    body: 'data: {"delta":"结果"}\n\ndata: [DONE]\n\n',
  }));
  await page.goto('/');
  await page.getByLabel('输入消息').fill('无响应头');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#lab-run-state')).toHaveText('本次观测已完成');
  await expect(page.locator('#lab-metric-model')).toHaveText('未提供');
  await expect(page.locator('#lab-metric-route')).toHaveText('未提供');
  await expect(page.locator('#lab-metric-request-id')).toHaveText('未提供');
});

test('流内错误保留部分内容，但不会伪报完成', async ({ page }) => {
  await page.route('**/api/chat', (route) => route.fulfill({
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
    body: 'data: {"delta":"部分内容"}\n\ndata: {"error":"合成错误"}\n\ndata: [DONE]\n\n',
  }));
  await page.goto('/');
  await page.getByLabel('输入消息').fill('错误测试');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#lab-run-state')).toHaveText('本次观测失败');
  await expect(page.locator('#messages')).toContainText('部分内容');
  await expect(page.locator('#messages')).toContainText('合成错误');
});

test('非流式错误体不会被误当作助手回复', async ({ page }) => {
  await page.addInitScript(() => {
    window.fetch = async () => ({
      ok: true, status: 200, headers: new Headers(), body: null,
      text: async () => JSON.stringify({ error: '合成网关错误' }),
    } as Response);
  });
  await page.goto('/');
  await page.getByLabel('输入消息').fill('非流式错误');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#lab-run-state')).toHaveText('本次观测失败');
  await expect(page.locator('#messages .error')).toContainText('合成网关错误');
  await expect(page.locator('#messages .assistant:not(.error)')).toHaveCount(0);
});

test('诊断复制不包含对话或协议正文', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.route('**/api/chat', (route) => route.fulfill({
    status: 200, headers: { 'Content-Type': 'text/event-stream', 'X-AI-Route': 'agent' },
    body: 'data: {"delta":"合成保密回答"}\n\ndata: [DONE]\n\n',
  }));
  await page.goto('/');
  await page.getByLabel('输入消息').fill('合成保密问题');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#lab-run-state')).toHaveText('本次观测已完成');
  await page.locator('#lab-copy-diagnostic').click();
  const diagnostic = await page.evaluate(() => navigator.clipboard.readText());
  expect(diagnostic).toContain('agent');
  expect(diagnostic).not.toContain('合成保密问题');
  expect(diagnostic).not.toContain('合成保密回答');
});
