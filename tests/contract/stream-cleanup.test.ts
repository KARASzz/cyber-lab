import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { onRequest as agentRequest } from '../../agents/chat/index.ts';
import { onRequestPost } from '../../cloud-functions/api/chat.js';

const env = {
  AI_GATEWAY_API_KEY: 'synthetic-fixture-only',
  AI_GATEWAY_BASE_URL: 'https://gateway.invalid/v1',
  AI_GATEWAY_MODEL: 'fixture-observed-model',
};
const body = { messages: [{ role: 'user', content: '测试' }] };
const encoder = new TextEncoder();
const headers = { 'Content-Type': 'text/event-stream; charset=utf-8' };

function agentContext(signal?: AbortSignal) {
  return { request: { body, signal, headers: {} }, env };
}

function directContext(signal?: AbortSignal) {
  return { request: { body, signal, headers: {} }, env };
}

function mockStream(t: TestContext, frame: string) {
  let cancelled = false;
  let receivedSignal: AbortSignal | null = null;
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    receivedSignal = init?.signal as AbortSignal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame));
        receivedSignal?.addEventListener('abort', () => {
          try { controller.error(new DOMException('aborted', 'AbortError')); } catch { /* closed */ }
        }, { once: true });
      },
      cancel() { cancelled = true; },
    });
    return new Response(stream, { headers });
  });
  return {
    get cancelled() { return cancelled; },
    get signal() { return receivedSignal; },
  };
}

test('客户端在代理等待首响应时中止后，不启动网关降级请求', async (t) => {
  const controller = new AbortController();
  let calls = 0;
  let markStarted: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    if (calls > 1) return new Response('data: [DONE]\n\n', { headers });
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      markStarted();
    });
  });
  const request = new Request('https://workbench.invalid/api/chat', {
    method: 'POST', body: JSON.stringify(body), signal: controller.signal,
  });
  const result = onRequestPost({ request, env });
  await started;
  controller.abort();
  const response = await result;
  if (response.body) await response.body.cancel().catch(() => {});
  assert.equal(calls, 1, '用户取消后不得重新启动网关');
});

test('已中止的请求不会发起任何网关调用', async (t) => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('data: [DONE]\n\n', { headers });
  });
  const response = await onRequestPost(directContext(controller.signal));
  if (response.body) await response.body.cancel().catch(() => {});
  assert.equal(calls, 0);
});

test('Agent 读到 DONE 后取消仍打开的上游流', async (t) => {
  const mock = mockStream(t, 'data: [DONE]\n\n');
  const response = await agentRequest(agentContext());
  assert.match(await response.text(), /data: \[DONE\]/);
  assert.equal(mock.cancelled, true);
});

test('直连读到 DONE 后取消仍打开的上游流', async (t) => {
  const mock = mockStream(t, 'data: [DONE]\n\n');
  const response = await onRequestPost(directContext());
  assert.match(await response.text(), /data: \[DONE\]/);
  assert.equal(mock.cancelled, true);
});

test('Agent 下游取消传播到网关', async (t) => {
  const mock = mockStream(t, 'data: {"choices":[{"delta":{"content":"第一段"}}]}\n\n');
  const response = await agentRequest(agentContext());
  const reader = response.body!.getReader();
  const chunk = await reader.read();
  assert.match(new TextDecoder().decode(chunk.value), /第一段/);
  await reader.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mock.signal?.aborted, true);
});

test('多行 SSE 网关消息在两条路径均能组装', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response([
    'data: {"choices":[\n',
    'data: {"delta":{"content":"多行观测"}}]}\n\n',
    'data: [DONE]\n\n',
  ].join(''), { headers }));
  const agent = await agentRequest(agentContext());
  const direct = await onRequestPost(directContext());
  assert.equal(await agent.text(), 'data: {"delta":"多行观测"}\n\ndata: [DONE]\n\n');
  assert.equal(await direct.text(), 'data: {"delta":"多行观测"}\n\ndata: [DONE]\n\n');
});

for (const path of ['agent', 'gateway']) {
  test(`${path} 等待网关响应超时后发送错误和 DONE`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    let markStarted: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      (init?.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      markStarted();
    }));
    const response = path === 'agent' ? await agentRequest(agentContext()) : await onRequestPost(directContext());
    await started;
    const output = response.text();
    t.mock.timers.tick(45_000);
    const result = await output;
    assert.match(result, /超时/);
    assert.match(result, /\[DONE\]/);
  });
}

test('Agent 已中止的请求不会调用网关', async (t) => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return new Response(); });
  const response = await agentRequest(agentContext(controller.signal));
  await response.text();
  assert.equal(calls, 0);
});

test('代理响应被取消时中止并释放 Agent 上游', async (t) => {
  let signal: AbortSignal | undefined;
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    signal = init?.signal as AbortSignal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode('data: {"delta":"部分"}\n\n')); },
      cancel() { cancelled = true; },
    }), { headers });
  });
  const response = await onRequestPost({ request: new Request('https://workbench.invalid/api/chat', {
    method: 'POST', body: JSON.stringify(body),
  }), env });
  const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /部分/);
  await reader.cancel();
  assert.equal(signal?.aborted, true);
  assert.equal(cancelled, true);
});

test('校验错误有请求 ID 但不虚构模型和路径', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return new Response(); });
  const response = await onRequestPost({ request: { body: { messages: [] }, headers: {} }, env });
  assert.equal(response.status, 400);
  assert.match(response.headers.get('X-Request-Id') || '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(response.headers.get('X-AI-Model'), null);
  assert.equal(response.headers.get('X-AI-Route'), null);
  assert.equal(calls, 0);
});

test('代理串联 Agent 时透传实际 Agent 模型和同一请求 ID', async (t) => {
  const agentEnv = { ...env, AI_GATEWAY_MODEL: '@makers/hy3' };
  let gatewayModel = '';
  let forwardedRequestId = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/chat')) {
      const requestHeaders = new Headers(init?.headers);
      forwardedRequestId = requestHeaders.get('X-Request-Id') || '';
      return agentRequest({ request: { body: JSON.parse(String(init?.body)), headers: requestHeaders, signal: init?.signal }, env: agentEnv });
    }
    gatewayModel = JSON.parse(String(init?.body)).model;
    return new Response('data: {"choices":[{"delta":{"content":"真实路径"}}]}\n\ndata: [DONE]\n\n', { headers });
  });
  const response = await onRequestPost({ request: new Request('https://workbench.invalid/api/chat', {
    method: 'POST', body: JSON.stringify(body),
  }), env });
  assert.match(await response.text(), /真实路径/);
  assert.equal(response.headers.get('X-AI-Route'), 'agent');
  assert.equal(response.headers.get('X-AI-Model'), '@makers/hy3');
  assert.equal(response.headers.get('X-AI-Model'), gatewayModel);
  assert.equal(response.headers.get('X-Request-Id'), forwardedRequestId);
});

test('Agent 缺失网关配置时，代理可安全降级而不重复推理', async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    if (String(url).endsWith('/chat')) {
      return agentRequest({ request: { body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) }, env: {} });
    }
    return new Response('data: {"choices":[{"delta":{"content":"降级成功"}}]}\n\ndata: [DONE]\n\n', { headers });
  });
  const response = await onRequestPost({ request: new Request('https://workbench.invalid/api/chat', {
    method: 'POST', body: JSON.stringify(body),
  }), env });
  assert.match(await response.text(), /降级成功/);
  assert.equal(response.headers.get('X-AI-Route'), 'gateway');
  assert.equal(urls.length, 2);
});

test('代理以大小写无关方式识别 SSE，避免重复请求', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('data: {"delta":"主路径"}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'Text/Event-Stream; charset=utf-8' } });
  });
  const response = await onRequestPost({ request: new Request('https://workbench.invalid/api/chat', {
    method: 'POST', body: JSON.stringify(body),
  }), env });
  assert.match(await response.text(), /主路径/);
  assert.equal(response.headers.get('X-AI-Route'), 'agent');
  assert.equal(calls, 1);
});

test('代理缺少模型响应头时不使用函数侧配置猜测', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('data: [DONE]\n\n', { headers }));
  const response = await onRequestPost({ request: new Request('https://workbench.invalid/api/chat', {
    method: 'POST', body: JSON.stringify(body),
  }), env });
  await response.text();
  assert.equal(response.headers.get('X-AI-Route'), 'agent');
  assert.equal(response.headers.get('X-AI-Model'), null);
});

test('两条路径的默认模型一致并与发出的网关请求一致', async (t) => {
  const models: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    models.push(JSON.parse(String(init?.body)).model);
    return new Response('data: [DONE]\n\n', { headers });
  });
  const noModel = { AI_GATEWAY_API_KEY: env.AI_GATEWAY_API_KEY, AI_GATEWAY_BASE_URL: env.AI_GATEWAY_BASE_URL };
  const agent = await agentRequest({ request: { body }, env: noModel });
  const direct = await onRequestPost({ request: { body, headers: {} }, env: noModel });
  await agent.text();
  await direct.text();
  assert.deepEqual(models, ['@makers/deepseek-v4.1-flash', '@makers/deepseek-v4.1-flash']);
  assert.equal(agent.headers.get('X-AI-Model'), models[0]);
  assert.equal(direct.headers.get('X-AI-Model'), models[1]);
});

test('两条路径的网关错误不回显上游敏感正文', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('synthetic-secret-body https://gateway.invalid/?token=synthetic', { status: 429 }));
  const agent = await agentRequest(agentContext());
  const direct = await onRequestPost(directContext());
  for (const response of [agent, direct]) {
    const output = await response.text();
    assert.match(output, /HTTP 429/);
    assert.match(output, /\[DONE\]/);
    assert.doesNotMatch(output, /synthetic-secret-body|gateway\.invalid|token=/);
  }
});

test('代理回环首响应超时后降级直连，不重复输出', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let calls = 0;
  let start: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    if (calls > 1) return new Response('data: {"choices":[{"delta":{"content":"降级成功"}}]}\n\ndata: [DONE]\n\n', { headers });
    return new Promise<Response>((_resolve, reject) => {
      (init?.signal as AbortSignal).addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      start();
    });
  });
  const pending = onRequestPost({ request: new Request('https://workbench.invalid/api/chat', {
    method: 'POST', body: JSON.stringify(body),
  }), env });
  await started;
  t.mock.timers.tick(12_000);
  const response = await pending;
  assert.equal(response.headers.get('X-AI-Route'), 'gateway');
  assert.equal(await response.text(), 'data: {"delta":"降级成功"}\n\ndata: [DONE]\n\n');
  assert.equal(calls, 2);
});

test('网关返回完整 JSON 时两条路径保持一致', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: '非流式回复' } }] }), {
    headers: { 'Content-Type': 'application/json' },
  }));
  const agent = await agentRequest(agentContext());
  const direct = await onRequestPost(directContext());
  assert.equal(await agent.text(), 'data: {"delta":"非流式回复"}\n\ndata: [DONE]\n\n');
  assert.equal(await direct.text(), 'data: {"delta":"非流式回复"}\n\ndata: [DONE]\n\n');
});

test('直连响应头准确标识实际请求模型和路径', async (t) => {
  let sentModel = '';
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    sentModel = JSON.parse(String(init?.body)).model;
    return new Response('data: [DONE]\n\n', { headers });
  });
  const response = await onRequestPost(directContext());
  await response.text();
  assert.equal(response.headers.get('X-AI-Route'), 'gateway');
  assert.equal(response.headers.get('X-AI-Model'), sentModel);
  assert.match(response.headers.get('Access-Control-Expose-Headers') || '', /X-Request-Id/i);
});
