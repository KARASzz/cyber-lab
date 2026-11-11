import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { chatGenerator, validateAndNormalize } from '../../agents/_chat.ts';
import { onRequest as agentRequest } from '../../agents/chat/index.ts';
import { onRequestPost } from '../../cloud-functions/api/chat.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/chat-contract.json', import.meta.url), 'utf8'));
const env = {
  AI_GATEWAY_API_KEY: 'fixture-key-not-a-secret',
  AI_GATEWAY_BASE_URL: 'https://gateway.invalid/v1',
  AI_GATEWAY_MODEL: 'fixture-model',
};
const gatewayBody = 'data: {"choices":[{"delta":{"content":"观测结果"}}]}\n\ndata: [DONE]\n\n';
const sseHeaders = { 'Content-Type': 'text/event-stream; charset=utf-8' };

function mockGateway(t: TestContext) {
  const calls: Array<{ url: string; body: Record<string, any> }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(gatewayBody, { headers: sseHeaders });
  });
  return calls;
}

function directContext(body: unknown) {
  // 没有 origin 的平台预解析请求会直接走网关，fetch 始终由每个测试替换。
  return { request: { body, headers: {}, signal: new AbortController().signal }, env };
}

async function generated(body: unknown) {
  let result = '';
  for await (const frame of chatGenerator(body, env)) result += frame;
  return result;
}

const invalidCases = [
  ...fixture.badBodies.map((body: string, i: number) => ({ name: `非法请求体 ${i + 1}`, body })),
  { name: '空白 content', body: { messages: fixture.messages.blankContent } },
  { name: '非法 role', body: { messages: fixture.messages.invalidRole } },
  { name: '非字符串 content', body: { messages: fixture.messages.nonStringContent } },
  { name: '非对象消息', body: { messages: [null] } },
  { name: '61 条消息', body: { messages: Array.from({ length: 61 }, () => ({ role: 'user', content: '字' })) } },
  { name: '累计 60001 字', body: { messages: Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: '字'.repeat(i === 7 ? 4001 : 8000) })) } },
  { name: '4001 字协议', body: { messages: fixture.messages.singleUser, systemPrompt: '字'.repeat(4001) } },
];

for (const { name, body } of invalidCases) {
  test(`两条 HTTP 入口均拒绝且不调用上游：${name}`, async (t) => {
    const calls = mockGateway(t);
    const agent = await agentRequest({ request: { body }, env });
    const direct = await onRequestPost(directContext(body));
    assert.equal(agent.status, 400);
    assert.equal(direct.status, 400);
    assert.equal(typeof (await agent.json()).error, 'string');
    assert.equal(typeof (await direct.json()).error, 'string');
    assert.equal(calls.length, 0);
  });
}

const validCases = [
  { name: '单轮无协议', body: { messages: fixture.messages.singleUser } },
  { name: '多轮含协议', body: { messages: fixture.messages.multiTurn, systemPrompt: fixture.systemPrompt.valid } },
  { name: '纯空白协议', body: { messages: fixture.messages.singleUser, systemPrompt: fixture.systemPrompt.whitespaceOnly } },
  { name: '非字符串协议兼容忽略', body: { messages: fixture.messages.singleUser, systemPrompt: 7 } },
  { name: '正好 4000 字协议', body: { messages: fixture.messages.singleUser, systemPrompt: ` ${'字'.repeat(4000)}\n` } },
  { name: '正好 60 条消息', body: { messages: Array.from({ length: 60 }, () => ({ role: 'user', content: '字' })) } },
  { name: '正好累计 60000 字', body: { messages: Array.from({ length: 8 }, (_, i) => ({ role: 'user', content: '字'.repeat(i === 7 ? 4000 : 8000) })) } },
  { name: '单条先截断至 8000 字', body: { messages: [{ role: 'user', content: '字'.repeat(8001) }] } },
];

for (const { name, body } of validCases) {
  test(`两条路径发给网关的请求完全一致：${name}`, async (t) => {
    const calls = mockGateway(t);
    const agentOutput = await generated(body);
    const direct = await onRequestPost(directContext(body));
    const directOutput = await direct.text();
    assert.equal(direct.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://gateway.invalid/v1/chat/completions');
    assert.deepEqual(calls[0], calls[1]);
    assert.equal(calls[0].body.model, 'fixture-model');
    assert.equal(calls[0].body.stream, true);
    assert.equal(agentOutput, 'data: {"delta":"观测结果"}\n\ndata: [DONE]\n\n');
    assert.equal(directOutput, agentOutput);
    const normalized = validateAndNormalize(body);
    assert.ok(!('error' in normalized));
    if ('error' in normalized) return;
    const messages = calls[0].body.messages;
    assert.deepEqual(messages.slice(normalized.systemPrompt ? 2 : 1), normalized.messages);
    assert.equal(messages[0].role, 'system');
    if (normalized.systemPrompt) {
      assert.equal(messages[1].role, 'system');
      assert.equal(messages[1].content, `【项目系统指令 · 优先级更高】\n${normalized.systemPrompt}`);
    }
  });
}

for (const status of [401, 404, 500]) {
  test(`回环 HTTP ${status} 降级到直连且不重复输出`, async (t) => {
    const urls: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      urls.push(String(url));
      return urls.length === 1
        ? new Response('loopback unavailable', { status })
        : new Response(gatewayBody, { headers: sseHeaders });
    });
    const response = await onRequestPost({
      request: new Request('https://workbench.invalid/api/chat', {
        method: 'POST', body: JSON.stringify({ messages: fixture.messages.singleUser }),
      }), env,
    });
    assert.equal(await response.text(), 'data: {"delta":"观测结果"}\n\ndata: [DONE]\n\n');
    assert.deepEqual(urls, ['https://workbench.invalid/chat', 'https://gateway.invalid/v1/chat/completions']);
  });
}

test('2xx 非 SSE 回环响应也会降级', async (t) => {
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    count += 1;
    return count === 1
      ? new Response('<html>not a stream</html>', { headers: { 'Content-Type': 'text/html' } })
      : new Response(gatewayBody, { headers: sseHeaders });
  });
  const response = await onRequestPost({
    request: new Request('https://workbench.invalid/api/chat', {
      method: 'POST', body: JSON.stringify({ messages: fixture.messages.singleUser }),
    }), env,
  });
  assert.match(await response.text(), /观测结果/);
  assert.equal(count, 2);
});

test('有效 Agent SSE 主路径不触发直连重试', async (t) => {
  const expected = 'data: {"delta":"主路径"}\n\ndata: [DONE]\n\n';
  let count = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    count += 1;
    return new Response(expected, { headers: sseHeaders });
  });
  const response = await onRequestPost({
    request: new Request('https://workbench.invalid/api/chat', {
      method: 'POST', body: JSON.stringify({ messages: fixture.messages.singleUser }),
    }), env,
  });
  assert.equal(await response.text(), expected);
  assert.equal(count, 1);
});
