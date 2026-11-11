import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as telemetry from '../../scripts/core/telemetry.js';
import { createSSEParser, extractDelta } from '../../scripts/core/chat-protocol.js';

const { createRunTelemetry } = telemetry;

test('自定义模型 ID 可真实观测，明显凭据形态不进入诊断', () => {
  const valid = telemetry.normalizeRunTelemetry({ outcome: 'complete', characters: 1, model: 'openai/gpt-4o' });
  assert.equal(valid.model, 'openai/gpt-4o');
  const future = telemetry.normalizeRunTelemetry({ outcome: 'complete', characters: 1, model: '@makers/future-model' });
  assert.equal(future.model, '@makers/future-model');
  const unsafe = telemetry.normalizeRunTelemetry({ outcome: 'complete', characters: 1, model: '@makers/sk-confidential' });
  assert.equal(unsafe.model, null);
  const withNewline = telemetry.normalizeRunTelemetry({ outcome: 'complete', characters: 1, model: '@makers/hy3\n' });
  assert.equal(withNewline.model, null);
});

test('新运行处于 connecting，尚无响应、首 token 或结束计时', () => {
  const run = createRunTelemetry(() => 100);
  assert.equal(run.state, 'connecting');
  assert.deepEqual(run.snapshot(), {
    state: 'connecting',
    outcome: null,
    timeToHeadersMs: null,
    timeToFirstTokenMs: null,
    durationMs: null,
    characters: 0,
    historyMessages: null,
    systemPromptCharacters: null,
    statusCode: null,
    route: 'unknown',
    requestId: null,
    model: null,
    errorCategory: null,
  });
});

test('响应头计时只记录第一次，且不把连接阶段提前标为流式', () => {
  let now = 100;
  const run = createRunTelemetry(() => now);
  assert.equal(typeof run.markHeaders, 'function');
  now = 145.5;
  run.markHeaders();
  assert.equal(run.state, 'connecting');
  assert.equal(run.snapshot().timeToHeadersMs, 45.5);
  now = 200;
  run.markHeaders();
  assert.equal(run.snapshot().timeToHeadersMs, 45.5);
});

test('空心跳不触发 streaming，首个非空 delta 计时不可覆盖', () => {
  let now = 100;
  const run = createRunTelemetry(() => now);
  assert.equal(typeof run.markToken, 'function');
  now = 130;
  run.markToken('');
  assert.equal(run.state, 'connecting');
  assert.equal(run.snapshot().timeToFirstTokenMs, null);
  assert.equal(run.snapshot().characters, 0);
  now = 150.25;
  run.markToken(' ');
  assert.equal(run.state, 'streaming');
  assert.equal(run.snapshot().timeToFirstTokenMs, 50.25);
  now = 190;
  run.markToken('好🧪');
  assert.equal(run.snapshot().timeToFirstTokenMs, 50.25);
  assert.equal(run.snapshot().characters, 4);
});

test('有内容的正常结束记录完成状态与真实总耗时', () => {
  let now = 10;
  const run = createRunTelemetry(() => now);
  assert.equal(typeof run.finish, 'function');
  now = 22;
  run.markHeaders();
  now = 35;
  run.markToken('结果');
  now = 70.5;
  const result = run.finish('complete');
  assert.equal(run.state, 'complete');
  assert.equal(result.state, 'complete');
  assert.equal(result.outcome, 'complete');
  assert.equal(result.timeToHeadersMs, 12);
  assert.equal(result.timeToFirstTokenMs, 25);
  assert.equal(result.durationMs, 60.5);
});

test('停止、超时和失败一经结束就不可被迟到事件或完成回调覆盖', () => {
  for (const outcome of ['stopped', 'timeout', 'error']) {
    let now = 0;
    const run = createRunTelemetry(() => now);
    now = 5;
    run.markToken('部分回答');
    now = 10;
    const first = run.finish(outcome);
    now = 20;
    run.markHeaders();
    run.markToken('迟到的内容');
    const repeated = run.finish('complete');
    assert.equal(run.state, outcome);
    assert.equal(first.outcome, outcome);
    assert.equal(first.durationMs, 10);
    assert.deepEqual(repeated, first);
    assert.notEqual(repeated, first);
  }
});

test('无内容或仅空白结束不伪报 complete，缺失首 token 保持 null', () => {
  let now = 100;
  const empty = createRunTelemetry(() => now);
  now = 130;
  const result = empty.finish('complete');
  assert.equal(result.outcome, 'error');
  assert.equal(result.state, 'error');
  assert.equal(result.errorCategory, 'empty_response');
  assert.equal(result.timeToFirstTokenMs, null);
  assert.equal(result.durationMs, 30);

  const whitespace = createRunTelemetry(() => now);
  now = 135;
  whitespace.markToken(' \n');
  now = 140;
  const blankResult = whitespace.finish('complete');
  assert.equal(blankResult.outcome, 'error');
  assert.equal(blankResult.errorCategory, 'empty_response');
  assert.equal(blankResult.timeToFirstTokenMs, 5);
  assert.equal(blankResult.characters, 2);
});

test('只记录首个响应头中的安全状态、路径、模型和 UUID', () => {
  let now = 0;
  const run = createRunTelemetry(() => now);
  now = 10;
  run.markHeaders({
    statusCode: 200,
    route: 'gateway',
    model: '@makers/deepseek-v4.1-flash',
    requestId: 'ABCDEF01-2345-4ABC-8DEF-0123456789AB',
  });
  now = 20;
  run.markHeaders({ statusCode: 500, route: 'agent', model: '@makers/hy3' });
  const snapshot = run.snapshot();
  assert.equal(snapshot.timeToHeadersMs, 10);
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.route, 'gateway');
  assert.equal(snapshot.model, '@makers/deepseek-v4.1-flash');
  assert.equal(snapshot.requestId, 'abcdef01-2345-4abc-8def-0123456789ab');

  const missing = createRunTelemetry(() => now);
  missing.markHeaders({ statusCode: 400 });
  missing.markHeaders({ statusCode: 200, route: 'agent', model: '@makers/hy3' });
  assert.equal(missing.snapshot().statusCode, 400);
  assert.equal(missing.snapshot().route, 'unknown');
  assert.equal(missing.snapshot().model, null);
});

test('非法响应元数据、URL、凭据及未核准模型不会进入运行记录', () => {
  const hostile = {
    statusCode: '200',
    route: 'agent Bearer confidential',
    requestId: 'https://gateway.invalid/?token=confidential',
    model: '@makers/sk-confidential',
    messages: [{ content: 'secret message' }],
    systemPrompt: 'secret instruction',
  };
  const run = createRunTelemetry(() => 0);
  run.markHeaders(hostile);
  const snapshot = run.snapshot();
  assert.equal(snapshot.statusCode, null);
  assert.equal(snapshot.route, 'unknown');
  assert.equal(snapshot.requestId, null);
  assert.equal(snapshot.model, null);
  assert.doesNotMatch(JSON.stringify(snapshot), /confidential|gateway\.invalid|secret message|secret instruction/);
});

test('已知及后续有效模型标识均可如实记录', () => {
  const models = [
    '@makers/hy3', '@makers/hy3-preview', '@makers/deepseek-v4-pro',
    '@makers/deepseek-v4-flash', '@makers/deepseek-v4.1-flash', '@makers/minimax-m3',
    '@makers/minimax-m2.7', '@makers/kimi-k2.6',
  ];
  for (const model of models) {
    const run = createRunTelemetry(() => 0);
    run.markHeaders({ model });
    assert.equal(run.snapshot().model, model);
  }
  const unknown = createRunTelemetry(() => 0);
  unknown.markHeaders({ model: '@makers/unrecognized' });
  assert.equal(unknown.snapshot().model, '@makers/unrecognized');
});

test('缺损或非对象响应元数据安全退化为缺失值', () => {
  for (const meta of [null, undefined, '正文', 1, [], true]) {
    const run = createRunTelemetry(() => 0);
    assert.doesNotThrow(() => run.markHeaders(meta));
    const snapshot = run.snapshot();
    assert.equal(snapshot.statusCode, null);
    assert.equal(snapshot.route, 'unknown');
    assert.equal(snapshot.model, null);
    assert.equal(snapshot.requestId, null);
  }
});

test('不读取响应元数据中的继承属性或 getter', () => {
  let invoked = false;
  const meta = Object.create({
    route: 'agent',
    model: '@makers/hy3',
    requestId: 'abcdef01-2345-4abc-8def-0123456789ab',
  });
  Object.defineProperty(meta, 'statusCode', {
    get() { invoked = true; return 200; },
    enumerable: true,
  });
  const run = createRunTelemetry(() => 0);
  run.markHeaders(meta);
  assert.equal(invoked, false);
  assert.equal(run.snapshot().statusCode, null);
  assert.equal(run.snapshot().route, 'unknown');
  assert.equal(run.snapshot().model, null);
  assert.equal(run.snapshot().requestId, null);
});

test('失效时钟的首值保持缺失，后续重复标记不得覆盖', () => {
  let now = 100;
  const run = createRunTelemetry(() => now);
  now = Number.NaN;
  run.markHeaders({ statusCode: 200, route: 'agent' });
  assert.equal(run.snapshot().timeToHeadersMs, null);
  now = 120;
  run.markHeaders({ statusCode: 500, route: 'gateway' });
  now = Number.POSITIVE_INFINITY;
  run.markToken('一');
  now = 150;
  run.markToken('二');
  now = 190;
  const result = run.finish('complete');
  assert.equal(result.timeToHeadersMs, null);
  assert.equal(result.timeToFirstTokenMs, null);
  assert.equal(result.durationMs, 90);
  assert.equal(result.statusCode, 200);
  assert.equal(result.route, 'agent');
  assert.equal(result.characters, 2);
});

test('时钟倒退或抛错不制造负耗时，也不影响请求状态', () => {
  let now = 100;
  const run = createRunTelemetry(() => now);
  now = 120;
  run.markHeaders();
  now = 110;
  run.markToken('有效内容');
  now = 130;
  const result = run.finish('complete');
  assert.equal(result.timeToHeadersMs, 20);
  assert.equal(result.timeToFirstTokenMs, null);
  assert.equal(result.durationMs, 30);

  let shouldThrow = false;
  let value = 1;
  const broken = createRunTelemetry(() => {
    if (shouldThrow) throw new Error('不可用时钟');
    return value;
  });
  shouldThrow = true;
  assert.doesNotThrow(() => broken.markHeaders());
  shouldThrow = false;
  value = 5;
  broken.markHeaders({ statusCode: 200 });
  const stopped = broken.finish('stopped');
  assert.equal(stopped.timeToHeadersMs, null);
  assert.equal(stopped.statusCode, null);
  assert.equal(stopped.durationMs, 4);
});

test('已开始接收内容后不能再补造首响应头计时', () => {
  let now = 0;
  const run = createRunTelemetry(() => now);
  now = 5;
  run.markToken('内容');
  now = 15;
  run.markHeaders({ statusCode: 200, route: 'agent' });
  assert.equal(run.snapshot().timeToHeadersMs, null);
  assert.equal(run.snapshot().statusCode, null);
  assert.equal(run.snapshot().route, 'unknown');
  assert.equal(run.snapshot().timeToFirstTokenMs, 5);
});

test('HTTP 失败记录固定错误类别与请求统计，不保存错误正文', () => {
  let now = 0;
  const run = createRunTelemetry(() => now);
  now = 2;
  run.markHeaders({ statusCode: 400 });
  now = 4;
  const result = run.finish('error', {
    errorCategory: 'http',
    historyMessages: 4,
    systemPromptCharacters: 98,
    error: 'secret body and Bearer confidential',
  });
  assert.equal(result.outcome, 'error');
  assert.equal(result.errorCategory, 'http');
  assert.equal(result.historyMessages, 4);
  assert.equal(result.systemPromptCharacters, 98);
  assert.equal(result.timeToFirstTokenMs, null);
  assert.doesNotMatch(JSON.stringify(result), /secret body|confidential/);
});

test('未知终态和错误正文不能冒充合法状态或错误类别', () => {
  for (const bad of [undefined, null, '', 'connecting', 'streaming', 'offline', 'Bearer confidential', {}]) {
    const run = createRunTelemetry(() => 0);
    run.markToken('内容');
    const result = run.finish(bad, { errorCategory: 'secret error body' });
    assert.equal(result.outcome, 'error');
    assert.equal(result.state, 'error');
    assert.equal(result.errorCategory, 'unknown');
    assert.doesNotMatch(JSON.stringify(result), /confidential|secret error body/);
  }
});

test('停止不是错误，超时具有固定类别', () => {
  const stopped = createRunTelemetry(() => 0).finish('stopped', { errorCategory: 'http' });
  const timedOut = createRunTelemetry(() => 0).finish('timeout', { errorCategory: 'network' });
  assert.equal(stopped.outcome, 'stopped');
  assert.equal(stopped.errorCategory, null);
  assert.equal(timedOut.outcome, 'timeout');
  assert.equal(timedOut.errorCategory, 'timeout');
});

test('非 2xx 响应不能因为有数据而被标记为成功', () => {
  const run = createRunTelemetry(() => 0);
  run.markHeaders({ statusCode: 503 });
  run.markToken('异常页面内容');
  const result = run.finish('complete');
  assert.equal(result.outcome, 'error');
  assert.equal(result.errorCategory, 'http');
  assert.equal(result.statusCode, 503);
});

test('可序列化运行记录按字段白名单归一化并丢弃未知字段', () => {
  assert.equal(typeof telemetry.normalizeRunTelemetry, 'function');
  const normalized = telemetry.normalizeRunTelemetry({
    outcome: 'error',
    timeToHeadersMs: 3.5,
    timeToFirstTokenMs: 5.25,
    durationMs: 10,
    characters: 4,
    historyMessages: 2,
    systemPromptCharacters: 0,
    statusCode: 200,
    route: 'agent',
    requestId: 'ABCDEF01-2345-4ABC-8DEF-0123456789AB',
    model: '@makers/hy3',
    errorCategory: 'stream',
    messages: ['secret body'],
    systemPrompt: 'secret instruction',
    url: 'https://gateway.invalid/?token=confidential',
  });
  assert.deepEqual(normalized, {
    outcome: 'error',
    timeToHeadersMs: 3.5,
    timeToFirstTokenMs: 5.25,
    durationMs: 10,
    characters: 4,
    historyMessages: 2,
    systemPromptCharacters: 0,
    statusCode: 200,
    route: 'agent',
    requestId: 'abcdef01-2345-4abc-8def-0123456789ab',
    model: '@makers/hy3',
    errorCategory: 'stream',
  });
});

test('损坏记录中不可能的时序降为 null，不伪造计时', () => {
  const pastEnd = telemetry.normalizeRunTelemetry({
    outcome: 'complete', durationMs: 10, timeToHeadersMs: 11, timeToFirstTokenMs: 12,
  });
  assert.equal(pastEnd.durationMs, 10);
  assert.equal(pastEnd.timeToHeadersMs, null);
  assert.equal(pastEnd.timeToFirstTokenMs, null);

  const backwards = telemetry.normalizeRunTelemetry({
    outcome: 'complete', durationMs: 20, timeToHeadersMs: 10, timeToFirstTokenMs: 9,
  });
  assert.equal(backwards.timeToHeadersMs, 10);
  assert.equal(backwards.timeToFirstTokenMs, null);
});

test('损坏或超界字段安全归一，零值与最大合法值保留', () => {
  const bad = telemetry.normalizeRunTelemetry({
    outcome: 'Bearer confidential',
    timeToHeadersMs: Number.NaN,
    timeToFirstTokenMs: -1,
    durationMs: Number.POSITIVE_INFINITY,
    characters: -1,
    historyMessages: 61,
    systemPromptCharacters: 4001,
    statusCode: '200',
    route: 'agent/secret',
    requestId: 'https://gateway.invalid/?token=confidential',
    model: '@makers/sk-confidential',
    errorCategory: 'Authorization: confidential',
  });
  assert.deepEqual(bad, {
    outcome: null,
    timeToHeadersMs: null,
    timeToFirstTokenMs: null,
    durationMs: null,
    characters: null,
    historyMessages: null,
    systemPromptCharacters: null,
    statusCode: null,
    route: 'unknown',
    requestId: null,
    model: null,
    errorCategory: null,
  });
  const bounds = telemetry.normalizeRunTelemetry({
    outcome: 'stopped', timeToHeadersMs: 0, timeToFirstTokenMs: 0, durationMs: 0,
    characters: 0, historyMessages: 60, systemPromptCharacters: 4000, statusCode: 599,
    route: 'gateway', errorCategory: 'http',
  });
  assert.equal(bounds.timeToHeadersMs, 0);
  assert.equal(bounds.timeToFirstTokenMs, 0);
  assert.equal(bounds.durationMs, 0);
  assert.equal(bounds.characters, 0);
  assert.equal(bounds.historyMessages, 60);
  assert.equal(bounds.systemPromptCharacters, 4000);
  assert.equal(bounds.statusCode, 599);
  assert.equal(bounds.route, 'gateway');
  assert.equal(bounds.errorCategory, null);
});

test('诊断导出仅保留状态码、计时、路径、请求 ID、模型及固定错误类别', () => {
  assert.equal(typeof telemetry.toDiagnostic, 'function');
  const diagnostic = telemetry.toDiagnostic({
    state: 'error', outcome: 'error', statusCode: 502,
    timeToHeadersMs: 11, timeToFirstTokenMs: 15, durationMs: 20,
    route: 'gateway', requestId: 'ABCDEF01-2345-4ABC-8DEF-0123456789AB',
    model: '@makers/deepseek-v4.1-flash', errorCategory: 'stream',
    characters: 4, historyMessages: 2, systemPromptCharacters: 98,
    messages: [{ content: 'secret message' }],
    systemPrompt: 'secret instruction',
    error: 'Bearer confidential',
    url: 'https://gateway.invalid/?token=confidential',
    cookie: 'session=confidential',
  });
  assert.deepEqual(diagnostic, {
    statusCode: 502,
    timeToHeadersMs: 11,
    timeToFirstTokenMs: 15,
    durationMs: 20,
    route: 'gateway',
    requestId: 'abcdef01-2345-4abc-8def-0123456789ab',
    model: '@makers/deepseek-v4.1-flash',
    errorCategory: 'stream',
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|confidential|gateway\.invalid|messages|systemPrompt|characters|historyMessages|cookie|url/i);
});

test('回调形式调用 finish 也能独立结束运行并返回快照', () => {
  const run = createRunTelemetry(() => 10);
  const finish = run.finish;
  let result;
  assert.doesNotThrow(() => { result = finish('stopped'); });
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.durationMs, 0);
  assert.equal(run.state, 'stopped');
});

test('非字符串和缺省 delta 不触发首 token', () => {
  const run = createRunTelemetry(() => 0);
  for (const delta of [undefined, null, 0, false, [], {}, new String('内容')]) {
    run.markToken(delta as any);
  }
  assert.equal(run.state, 'connecting');
  assert.equal(run.snapshot().timeToFirstTokenMs, null);
  assert.equal(run.snapshot().characters, 0);
});

test('并行实验各自记录状态，旧实验结束后的迟到数据不污染新实验', () => {
  let now = 100;
  const oldRun = createRunTelemetry(() => now);
  now = 110;
  const newRun = createRunTelemetry(() => now);
  now = 115;
  oldRun.markHeaders({ statusCode: 200, route: 'agent', model: '@makers/hy3' });
  now = 120;
  newRun.markHeaders({ statusCode: 200, route: 'gateway', model: '@makers/minimax-m3' });
  now = 125;
  oldRun.markToken('旧内容');
  now = 130;
  const oldResult = oldRun.finish('stopped');
  now = 140;
  newRun.markToken('新回复');
  now = 145;
  oldRun.markToken('迟到数据');
  oldRun.finish('complete');
  now = 160;
  const newResult = newRun.finish('complete');

  assert.equal(oldResult.outcome, 'stopped');
  assert.equal(oldResult.durationMs, 30);
  assert.equal(oldResult.timeToFirstTokenMs, 25);
  assert.equal(oldResult.characters, 3);
  assert.equal(oldResult.route, 'agent');
  assert.equal(oldResult.model, '@makers/hy3');
  assert.equal(newResult.outcome, 'complete');
  assert.equal(newResult.durationMs, 50);
  assert.equal(newResult.timeToFirstTokenMs, 30);
  assert.equal(newResult.characters, 3);
  assert.equal(newResult.route, 'gateway');
  assert.equal(newResult.model, '@makers/minimax-m3');

  oldResult.route = 'gateway';
  assert.equal(oldRun.snapshot().route, 'agent');
  assert.equal(oldRun.snapshot().outcome, 'stopped');
});

test('拆分 UTF-8 的 SSE 和空心跳不会提前记录首 token', () => {
  let now = 0;
  const run = createRunTelemetry(() => now);
  now = 10;
  run.markHeaders({ statusCode: 200 });
  const parser = createSSEParser((payload: string) => {
    run.markToken(extractDelta(JSON.parse(payload)));
  }, null);
  const encoder = new TextEncoder();
  now = 15;
  parser.feed(encoder.encode('data: {"delta":""}\n\n'));
  assert.equal(run.state, 'connecting');
  const frame = encoder.encode('data: {"delta":"你好🧪"}\n\ndata: [DONE]\n\n');
  const split = frame.indexOf(0xe4) + 1;
  assert.ok(split > 1);
  now = 20;
  parser.feed(frame.slice(0, split));
  assert.equal(run.snapshot().timeToFirstTokenMs, null);
  now = 30;
  parser.feed(frame.slice(split));
  parser.finish();
  now = 50;
  const result = run.finish('complete');
  assert.equal(result.timeToHeadersMs, 10);
  assert.equal(result.timeToFirstTokenMs, 30);
  assert.equal(result.durationMs, 50);
  assert.equal(result.characters, 4);
});

test('负零归一化为普通零，避免异常快照和诊断', () => {
  const normalized = telemetry.normalizeRunTelemetry({
    timeToHeadersMs: -0, timeToFirstTokenMs: -0, durationMs: -0,
    characters: -0, historyMessages: -0, systemPromptCharacters: -0,
  });
  for (const value of [normalized.timeToHeadersMs, normalized.timeToFirstTokenMs,
    normalized.durationMs, normalized.characters, normalized.historyMessages, normalized.systemPromptCharacters]) {
    assert.equal(Object.is(value, -0), false);
    assert.equal(value, 0);
  }
  let now = 0;
  const run = createRunTelemetry(() => now);
  now = -0;
  assert.equal(Object.is(run.finish('stopped').durationMs, -0), false);
});

test('恢复的记录不能把 HTTP 失败或零字符伪报为完成', () => {
  const httpFailure = telemetry.normalizeRunTelemetry({ outcome: 'complete', statusCode: 503, characters: 7 });
  assert.equal(httpFailure.outcome, 'error');
  assert.equal(httpFailure.errorCategory, 'http');
  const empty = telemetry.normalizeRunTelemetry({ outcome: 'complete', statusCode: 200, characters: 0 });
  assert.equal(empty.outcome, 'error');
  assert.equal(empty.errorCategory, 'empty_response');
  const missing = telemetry.normalizeRunTelemetry({ outcome: 'complete' });
  assert.equal(missing.outcome, 'complete');
  assert.equal(missing.characters, null);
});

test('请求 ID 必须完整匹配 UUID，末尾换行和附加内容均拒绝', () => {
  const id = 'abcdef01-2345-4abc-8def-0123456789ab';
  for (const suffix of ['\n', '\r', '\r\n', String.fromCodePoint(0x2028), '?token=confidential']) {
    const run = createRunTelemetry(() => 0);
    run.markHeaders({ requestId: id + suffix });
    assert.equal(run.snapshot().requestId, null);
  }
});

test('HTTP 状态码和上下文计数只接受合法范围内的整数', () => {
  for (const statusCode of [100, 200, 299, 400, 599]) {
    const run = createRunTelemetry(() => 0);
    run.markHeaders({ statusCode });
    assert.equal(run.snapshot().statusCode, statusCode);
  }
  for (const statusCode of [0, 99, 600, 200.5, NaN, Infinity, '200', null]) {
    const run = createRunTelemetry(() => 0);
    run.markHeaders({ statusCode });
    assert.equal(run.snapshot().statusCode, null);
  }
  const run = createRunTelemetry(() => 0);
  const result = run.finish('stopped', { historyMessages: 61, systemPromptCharacters: 4001 });
  assert.equal(result.historyMessages, null);
  assert.equal(result.systemPromptCharacters, null);
});

test('无法读取的损坏记录不会执行 getter 或泄露异常文本', () => {
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const raw of [null, undefined, 'secret body', [], revoked.proxy]) {
    assert.doesNotThrow(() => {
      const diagnostic = telemetry.toDiagnostic(raw);
      assert.equal(diagnostic.statusCode, null);
      assert.equal(diagnostic.route, 'unknown');
      assert.equal(diagnostic.model, null);
      assert.equal(diagnostic.requestId, null);
      assert.doesNotMatch(JSON.stringify(diagnostic), /secret/);
    });
  }
});

test('默认单调时钟可用于无等待的本地计时', () => {
  const run = createRunTelemetry();
  run.markHeaders({ statusCode: 200 });
  run.markToken('内容');
  const result = run.finish('complete');
  assert.equal(result.outcome, 'complete');
  assert.ok(Number.isFinite(result.timeToHeadersMs));
  assert.ok(Number.isFinite(result.timeToFirstTokenMs));
  assert.ok(Number.isFinite(result.durationMs));
  assert.ok(result.timeToHeadersMs <= result.timeToFirstTokenMs);
  assert.ok(result.timeToFirstTokenMs <= result.durationMs);
});
