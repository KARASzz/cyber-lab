import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ChatError,
  createSSEParser,
  deliverDelta,
  extractDelta,
  isSelfContained,
  looksLikeMarkup,
} from '../../scripts/core/chat-protocol.js';

const encoder = new TextEncoder();
const frames = [
  ': heartbeat\n\n',
  'event: message\nid: 1\nretry: 1000\n',
  'data: {"delta":"你"}\n\n',
  'data: {"delta":""}\n\n',
  'data: {"delta":"好🧪"}\r\n\r\n',
  'data: [DONE]\n\n',
  'data: {"delta":"不应出现"}\n\n',
].join('');
const expected = [{ delta: '你' }, { delta: '' }, { delta: '好🧪' }];

function collect(chunks: Uint8Array[]) {
  const events: unknown[] = [];
  const parser = createSSEParser((event: string) => events.push(JSON.parse(event)), null);
  for (const chunk of chunks) parser.feed(chunk);
  parser.finish();
  return { events, parser };
}

test('完整 SSE 忽略注释和非 data 字段，保留空 delta 心跳', () => {
  const result = collect([encoder.encode(frames)]);
  assert.deepEqual(result.events, expected);
  assert.equal(result.parser.finished, true);
});

test('逐字节分块可恢复 UTF-8 中文及 emoji', () => {
  const bytes = encoder.encode(frames);
  const result = collect(Array.from(bytes, (byte) => new Uint8Array([byte])));
  assert.deepEqual(result.events, expected);
  assert.equal(result.parser.finished, true);
});

test('每一个可能的二段切分均产生相同事件', () => {
  const bytes = encoder.encode(frames);
  for (let i = 0; i <= bytes.length; i += 1) {
    const { events, parser } = collect([bytes.slice(0, i), bytes.slice(i)]);
    assert.deepEqual(events, expected, `切分字节 ${i}`);
    assert.equal(parser.finished, true);
  }
});

test('未完成的多行 data 在空行时合并', () => {
  const result = collect([encoder.encode('data: {"delta":\r\ndata: "多行"}\r\n\r\ndata: [DONE]\r\n')]);
  assert.deepEqual(result.events, [{ delta: '多行' }]);
  assert.equal(result.parser.finished, true);
});

test('EOF 处理没有末尾换行的最后一帧', () => {
  const result = collect([encoder.encode('data: {"delta":"最后一帧"}')]);
  assert.deepEqual(result.events, [{ delta: '最后一帧' }]);
  assert.equal(result.parser.finished, false);
  result.parser.finish();
  assert.equal(result.events.length, 1);
});

test('DONE 后继续 feed 或 finish 不会重复输出', () => {
  const result = collect([encoder.encode('data: {"delta":"一次"}\n\ndata: [DONE]\n\n')]);
  result.parser.feed(encoder.encode('data: {"delta":"第二次"}\n\n'));
  result.parser.finish();
  assert.deepEqual(result.events, [{ delta: '一次' }]);
});

test('原始 chunk 到达通知不会把半帧当作已完成事件', () => {
  let chunks = 0;
  const events: string[] = [];
  const parser = createSSEParser((event: string) => events.push(event), () => { chunks += 1; });
  parser.feed(encoder.encode('data: {"delta":'));
  assert.equal(chunks, 1);
  assert.equal(events.length, 0);
  parser.feed(encoder.encode('"完整"}\n\n'));
  assert.equal(chunks, 2);
  assert.deepEqual(events, ['{"delta":"完整"}']);
});

test('流内错误原样交给调用者，回调错误不会被吞掉', () => {
  const failure = new ChatError('服务返回错误', '网关失败');
  const parser = createSSEParser((event: string) => {
    assert.deepEqual(JSON.parse(event), { error: '网关失败' });
    throw failure;
  }, null);
  assert.throws(() => parser.feed(encoder.encode('data: {"error":"网关失败"}\n\n')), (err) => err === failure);
});

const deltaCases = [
  { delta: '文本' },
  { delta: { content: '文本' } },
  { delta: { text: '文本' } },
  { content: '文本' },
  { text: '文本' },
  { answer: '文本' },
  { response: '文本' },
  { message: '文本' },
  { choices: [{ delta: '文本' }] },
  { choices: [{ delta: { content: '文本' } }] },
  { choices: [{ text: '文本' }] },
  { choices: [{ message: { content: '文本' } }] },
];

test('兼容已有 delta 字段形态，但不把对象转成文本', () => {
  for (const value of deltaCases) assert.equal(extractDelta(value), '文本');
  for (const value of [null, 1, [], {}, { delta: {} }, { choices: [] }]) {
    assert.equal(extractDelta(value), '');
  }
  assert.equal(extractDelta({ delta: '', text: '不是心跳内容' }), '');
});

test('世代或会话不匹配时增量既不入内存也不渲染', () => {
  const rendered: string[] = [];
  const ctx = { gen: 3, sessionId: 'old', content: '', append: (d: string) => rendered.push(d) };
  assert.equal(deliverDelta(ctx, '跨世代', 4, 'old'), false);
  assert.equal(deliverDelta(ctx, '跨会话', 3, 'new'), false);
  assert.equal(deliverDelta(ctx, '', 3, 'old'), false);
  assert.equal(ctx.content, '');
  assert.deepEqual(rendered, []);
  assert.equal(deliverDelta(ctx, '有效', 3, 'old'), true);
  assert.equal(ctx.content, '有效');
  assert.deepEqual(rendered, ['有效']);
});

test('自包含帧判定不把半 JSON 当成完整 JSON', () => {
  assert.equal(isSelfContained('{"delta":"x"}'), true);
  assert.equal(isSelfContained('[DONE]'), true);
  assert.equal(isSelfContained('{"delta":'), false);
  assert.equal(isSelfContained('{bad}'), false);
  assert.equal(looksLikeMarkup('<html>错误页</html>'), true);
  assert.equal(looksLikeMarkup('正常文字'), false);
});
