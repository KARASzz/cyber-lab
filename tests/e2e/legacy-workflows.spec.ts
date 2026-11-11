import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * 旧行为浏览器回归基线（Phase A）。
 * 目标：在模块解耦与视觉重构之前，锁定现有 NEON//CHAT 的可观察行为，
 * 重构后这些断言必须继续通过（视觉/结构类断言在 Phase B 迁移到 workbench.spec.ts）。
 *
 * 所有 /api/chat 一律用 page.route mock，静态服务器不实现聊天接口。
 */

const SSE_HEADERS = { 'Content-Type': 'text/event-stream; charset=utf-8' };

test.beforeEach(async ({ page }) => {
  await page.route('**/api/chat', (route) => route.abort('blockedbyclient'));
});

/** 让 /api/chat 返回一段固定的 SSE 流。 */
async function mockStream(page: Page, deltas: string[], opts: { error?: string } = {}) {
  await page.route('**/api/chat', async (route: Route) => {
    let body = '';
    for (const d of deltas) body += `data: ${JSON.stringify({ delta: d })}\n\n`;
    if (opts.error) body += `data: ${JSON.stringify({ error: opts.error })}\n\n`;
    body += 'data: [DONE]\n\n';
    await route.fulfill({ status: 200, headers: SSE_HEADERS, body });
  });
}

async function openLibrary(page: Page) {
  const menu = page.locator('#menu-btn');
  if (await menu.isVisible() && await menu.getAttribute('aria-expanded') !== 'true') {
    await menu.click();
  }
}

test('首次加载创建默认项目与会话', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#project-list .project-card')).toHaveCount(1);
  await expect(page.locator('#project-list .project-name').first()).toHaveText('默认项目');
  // 空状态可见，消息区隐藏
  await expect(page.locator('#empty-state')).toBeVisible();
});

test('发送消息并渲染流式回复', async ({ page }) => {
  await mockStream(page, ['基线', '回复']);
  await page.goto('/');
  await page.getByLabel('输入消息').fill('验证基线');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#messages')).toContainText('验证基线');
  await expect(page.locator('#messages')).toContainText('基线回复');
});

test('实验卡先填写内容，不直接发起请求', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/chat', async (route) => { calls += 1; await route.abort(); });
  await page.goto('/');
  const card = page.locator('#suggestions .suggestion').first();
  const prompt = await card.getAttribute('data-prompt');
  await card.click();
  await expect(page.getByLabel('输入消息')).toHaveValue(prompt || '');
  expect(calls).toBe(0);
});

test('新建/切换/重命名/删除项目', async ({ page }) => {
  await page.goto('/');
  await openLibrary(page);
  await page.locator('#new-project-btn').click();
  await page.locator('#modal-input').fill('前端重构');
  await page.locator('#modal-confirm').click();
  await expect(page.locator('#project-list .project-card')).toHaveCount(2);
  await expect(page.locator('#head-project')).toContainText('前端重构');

  await openLibrary(page);
  await page.locator('[data-action="rename-project"]').first().click();
  await page.locator('#modal-input').fill('前端重构 V2');
  await page.locator('#modal-confirm').click();
  await expect(page.locator('#project-list')).toContainText('前端重构 V2');

  const cards = page.locator('#project-list .project-card');
  await cards.nth(1).locator('[data-action="switch-project"]').click();
  await expect(page.locator('#head-project')).toContainText('默认项目');
  await openLibrary(page);
  await cards.nth(0).locator('[data-action="delete-project"]').click();
  await page.locator('#modal-confirm').click();
  await expect(page.locator('#project-list .project-card')).toHaveCount(1);
});

test('新建与删除会话', async ({ page }) => {
  await page.goto('/');
  await page.locator('#new-session-btn').click();
  await openLibrary(page);
  await expect(page.locator('#project-list .session-row')).toHaveCount(2);
  await page.locator('#project-list .session-row').first().locator('[data-action="delete-session"]').click();
  await page.locator('#modal-confirm').click();
  await expect(page.locator('#project-list .session-row')).toHaveCount(1);
});

test('实验可重命名并在刷新后恢复', async ({ page }) => {
  await page.goto('/');
  await openLibrary(page);
  await page.getByRole('button', { name: '重命名实验' }).first().click();
  await expect(page.getByRole('dialog', { name: '重命名实验' })).toBeVisible();
  await page.locator('#modal-input').fill('可复现实验');
  await page.locator('#modal-confirm').click();
  await expect(page.locator('#head-session')).toHaveText('可复现实验');
  await page.reload();
  await expect(page.locator('#head-session')).toHaveText('可复现实验');
});

test('刷新后恢复项目与会话数据', async ({ page }) => {
  await mockStream(page, ['持久', '化回复']);
  await page.goto('/');
  await openLibrary(page);
  await page.locator('#new-project-btn').click();
  await page.locator('#modal-input').fill('持久项目');
  await page.locator('#modal-confirm').click();
  await page.getByLabel('输入消息').fill('记住我');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#messages')).toContainText('持久化回复');

  await page.reload();
  await expect(page.locator('#project-list')).toContainText('持久项目');
  await expect(page.locator('#messages')).toContainText('持久化回复');
});

test('系统指令抽屉：启用、预设套用与开关', async ({ page }) => {
  await page.goto('/');
  await page.locator('#sys-badge').click();
  await expect(page.locator('#sys-panel')).toBeVisible();
  // 套用首个预设
  await page.locator('#preset-list .preset').first().click();
  await expect(page.locator('#sys-enabled')).toBeChecked();
  await expect(page.locator('#sys-count')).not.toHaveText('0 / 4000');
  await page.locator('#sys-done').click();
  if (await page.evaluate(() => window.innerWidth < 1280)) {
    await expect(page.locator('#sys-panel')).toBeHidden();
  } else {
    await expect(page.locator('#sys-panel')).toBeVisible();
  }
  await expect(page.locator('#sys-badge')).toHaveClass(/is-on/);
});

test('启用系统指令时请求体携带 systemPrompt，关闭时不携带', async ({ page }) => {
  const bodies: any[] = [];
  await page.route('**/api/chat', async (route: Route) => {
    bodies.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, headers: SSE_HEADERS, body: 'data: {"delta":"ok"}\n\ndata: [DONE]\n\n' });
  });
  await page.goto('/');
  // 关闭态发送
  await page.getByLabel('输入消息').fill('第一条');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#messages')).toContainText('ok');
  expect(Object.prototype.hasOwnProperty.call(bodies[0], 'systemPrompt')).toBe(false);

  // 启用系统指令
  await page.locator('#sys-badge').click();
  await page.locator('label.switch').click();
  await expect(page.locator('#sys-enabled')).toBeChecked();
  await page.locator('#sys-input').fill('你是测试助手');
  await page.locator('#sys-done').click();
  await page.getByLabel('输入消息').fill('第二条');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1].systemPrompt).toBe('你是测试助手');
});

test('系统指令 4000 字通过、4001 字拦截', async ({ page }) => {
  await page.goto('/');
  await page.locator('#sys-badge').click();
  const input = page.locator('#sys-input');

  await input.fill('a'.repeat(4000));
  await expect(page.locator('#sys-count')).toHaveText('4000 / 4000');
  await expect(page.locator('#sys-warn')).toBeHidden();

  await input.fill('a'.repeat(4001));
  await expect(page.locator('#sys-count')).toHaveText('4001 / 4000');
  await expect(page.locator('#sys-warn')).toBeVisible();
});

test('无 DONE 的流在 EOF 时保留收到的文本', async ({ page }) => {
  await page.route('**/api/chat', async (route: Route) => {
    await route.fulfill({
      status: 200,
      headers: SSE_HEADERS,
      body: 'data: {"delta":"已收到部分"}\n\n',
    });
  });
  await page.goto('/');
  await page.getByLabel('输入消息').fill('开始生成');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#messages')).toContainText('已收到部分');
});

test('在途请求可点击停止，界面回到可输入态', async ({ page }) => {
  let release: () => void;
  let started: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const intercepted = new Promise<void>((resolve) => { started = resolve; });
  await page.route('**/api/chat', async (route) => {
    started();
    await hold;
    await route.abort().catch(() => {});
  });
  try {
    await page.goto('/');
    await page.getByLabel('输入消息').fill('长任务');
    await page.getByRole('button', { name: '发送消息' }).click();
    await intercepted;
    const stopBtn = page.getByRole('button', { name: '停止生成' });
    await expect(stopBtn).toBeVisible();
    await stopBtn.click();
    await expect(page.getByRole('button', { name: '发送消息' })).toBeVisible();
    await expect(page.getByLabel('输入消息')).toBeEnabled();
    await expect(page.locator('#messages')).toContainText('已停止生成');
  } finally {
    release();
  }
});

test('流式收到部分结果后停止会传播取消并保留中断结果', async ({ page }) => {
  await page.addInitScript(() => {
    window.fetch = (_input, init) => {
      let upstream: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          upstream = controller;
          controller.enqueue(new TextEncoder().encode('data: {"delta":"中止前内容"}\n\n'));
        },
      });
      init?.signal?.addEventListener('abort', () => {
        (window as any).__observedAbort = true;
        try { upstream.error(new DOMException('aborted', 'AbortError')); } catch { /* 已关闭 */ }
      }, { once: true });
      return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
    };
  });
  await page.goto('/');
  await page.getByLabel('输入消息').fill('流式停止测试');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#messages')).toContainText('中止前内容');
  await page.getByRole('button', { name: '停止生成' }).click();
  await expect(page.locator('#messages .msg.stopped')).toContainText('中止前内容');
  expect(await page.evaluate(() => (window as any).__observedAbort)).toBe(true);
  await page.reload();
  await expect(page.locator('#messages .stopped-tag')).toBeVisible();
  await expect(page.locator('#messages')).toContainText('中止前内容');
});

test('网络错误显示错误气泡并可重试', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/chat', async (route: Route) => {
    calls += 1;
    if (calls === 1) {
      await route.fulfill({ status: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '上游炸了' }) });
    } else {
      await route.fulfill({ status: 200, headers: SSE_HEADERS, body: 'data: {"delta":"重试成功"}\n\ndata: [DONE]\n\n' });
    }
  });
  await page.goto('/');
  await page.getByLabel('输入消息').fill('触发错误');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#messages')).toContainText('上游炸了');
  await page.getByRole('button', { name: /重试/ }).click();
  await expect(page.locator('#messages')).toContainText('重试成功');
});

test('重试保留已中止的观测，并使用原问题上下文', async ({ page }) => {
  const requests: any[] = [];
  await page.route('**/api/chat', async (route) => {
    requests.push(JSON.parse(route.request().postData() || '{}'));
    const body = requests.length === 1
      ? 'data: {"delta":"部分观测"}\n\ndata: {"error":"合成错误"}\n\ndata: [DONE]\n\n'
      : 'data: {"delta":"重试结果"}\n\ndata: [DONE]\n\n';
    await route.fulfill({ status: 200, headers: SSE_HEADERS, body });
  });
  await page.goto('/');
  await page.getByLabel('输入消息').fill('原始问题');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#messages')).toContainText('部分观测');
  await page.getByRole('button', { name: /重试/ }).click();
  await expect(page.locator('#messages')).toContainText('重试结果');
  await expect(page.locator('#messages')).toContainText('部分观测');
  expect(requests).toHaveLength(2);
  expect(requests[1].messages).toEqual([{ role: 'user', content: '原始问题' }]);
  await page.reload();
  await expect(page.locator('#messages')).toContainText('部分观测');
  await expect(page.locator('#messages')).toContainText('重试结果');
});

test('移动端抽屉可开关', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const menu = page.locator('#menu-btn');
  await menu.click();
  await expect(page.locator('body')).toHaveClass(/sidebar-open/);
  await page.locator('#sidebar-close').click();
  await expect(page.locator('body')).not.toHaveClass(/sidebar-open/);
});

test('中文输入法组合期间 Enter 不发送', async ({ page }) => {
  await mockStream(page, ['不应触发']);
  await page.goto('/');
  const input = page.getByLabel('输入消息');
  await input.fill('拼');
  // 模拟组合输入中的 Enter（keyCode 229 / isComposing）
  await input.evaluate((el) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true }));
  });
  // 组合期间不应发送：消息区仍为空状态
  await expect(page.locator('#empty-state')).toBeVisible();
  // 正常 Enter 发送
  await input.press('Enter');
  await expect(page.locator('#messages')).toContainText('不应触发');
});

test('不可信的用户与助手文本不会创建 HTML 元素', async ({ page }) => {
  const payload = '<img src=x onerror="window.__xss=1">';
  await mockStream(page, [payload, '\n```html\n<script>window.__xss=2</script>\n```']);
  await page.goto('/');
  await page.getByLabel('输入消息').fill(payload);
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#messages')).toContainText(payload);
  await expect(page.locator('#messages img')).toHaveCount(0);
  await expect(page.locator('#messages script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
});

test('切换实验时保留旧会话部分回复，不把迟到增量写入新会话', async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith('/api/chat')) return originalFetch(input, init);
      let upstream: ReadableStreamDefaultController<Uint8Array>;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          upstream = controller;
          controller.enqueue(encoder.encode('data: {"delta":"旧会话片段"}\n\n'));
        },
      });
      (window as any).__releaseLate = () => {
        try { upstream.enqueue(encoder.encode('data: {"delta":"迟到内容"}\n\ndata: [DONE]\n\n')); } catch { /* 已中止 */ }
      };
      init?.signal?.addEventListener('abort', () => {
        try { upstream.error(new DOMException('aborted', 'AbortError')); } catch { /* 已关闭 */ }
      }, { once: true });
      return Promise.resolve(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
    };
  });
  await page.goto('/');
  await page.getByLabel('输入消息').fill('隔离测试');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#messages')).toContainText('旧会话片段');
  await page.locator('#new-session-btn').click();
  await page.evaluate(() => (window as any).__releaseLate());
  await expect(page.locator('#empty-state')).toBeVisible();
  await expect(page.locator('#messages')).not.toContainText('迟到内容');
  await openLibrary(page);
  await page.locator('#project-list [data-action="switch-session"]').filter({ hasText: '隔离测试' }).click();
  await expect(page.locator('#messages')).toContainText('旧会话片段');
  await expect(page.locator('#messages')).not.toContainText('迟到内容');
  await expect(page.locator('#messages .stopped-tag')).toBeVisible();
});

test('字符计数与发送按钮禁用态', async ({ page }) => {
  await page.goto('/');
  const input = page.getByLabel('输入消息');
  const send = page.getByRole('button', { name: '发送消息' });
  await expect(send).toBeDisabled();
  await input.fill('abc');
  await expect(page.locator('#char-count')).toHaveText('3 / 4000');
  await expect(send).toBeEnabled();
});
