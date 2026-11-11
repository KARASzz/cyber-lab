import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STORAGE_KEY,
  PRESETS,
  buildRequestBody,
  createStorage,
  defaultState,
  makeProject,
  matchPresetId,
  normalizeState,
  resolveSystemPrompt,
  trimHistory,
} from '../../scripts/core/state.js';

function workspace(messages = [{ role: 'user', content: '旧对话原文', ts: 1 }]) {
  return {
    version: 1,
    activeProjectId: 'p1',
    projects: [{
      id: 'p1', name: '旧项目', createdAt: 1, updatedAt: 2,
      systemPrompt: { enabled: false, text: '', presetId: null },
      activeSessionId: 's1',
      sessions: [{ id: 's1', title: '旧会话', createdAt: 1, updatedAt: 2, messages }],
    }],
  };
}

for (const raw of ['{broken', 'null', '[]', '{}', '{"projects":[]}', null, undefined, 7]) {
  test(`非法存储结构可恢复默认工作区：${String(raw)}`, () => {
    const result = normalizeState(raw);
    assert.equal(result.version, 1);
    assert.equal(result.projects.length, 1);
    assert.equal(result.activeProjectId, result.projects[0].id);
    assert.equal(result.projects[0].sessions.length, 1);
  });
}

test('旧对话内容与时间保持不变', () => {
  const input = workspace();
  const snapshot = JSON.stringify(input);
  const result = normalizeState(input);
  assert.equal(result.projects[0].sessions[0].messages[0].content, '旧对话原文');
  assert.equal(result.projects[0].sessions[0].messages[0].ts, 1);
  assert.equal(JSON.stringify(input), snapshot);
});

test('重复项目和会话 ID 去重，失效 active ID 回退', () => {
  const input = workspace();
  input.projects.push(structuredClone(input.projects[0]));
  input.projects[0].sessions.push(structuredClone(input.projects[0].sessions[0]));
  input.activeProjectId = 'missing';
  input.projects[0].activeSessionId = 'missing';
  const result = normalizeState(input);
  assert.equal(new Set(result.projects.map((p) => p.id)).size, 2);
  assert.equal(new Set(result.projects[0].sessions.map((s) => s.id)).size, 2);
  assert.equal(result.activeProjectId, result.projects[0].id);
  assert.equal(result.projects[0].activeSessionId, result.projects[0].sessions[0].id);
});

test('旧消息获得稳定 ID，长回复在本地不被截断', () => {
  const content = '旧回答'.repeat(3001);
  const old = workspace([
    { role: 'user', content: '问题', ts: 1 },
    { role: 'assistant', content, ts: 2 },
  ]);
  const first = normalizeState(old);
  const messages = first.projects[0].sessions[0].messages;
  assert.equal(messages[1].content, content);
  assert.ok(messages.every((message) => typeof message.id === 'string' && message.id.length > 0));
  assert.notEqual(messages[0].id, messages[1].id);
  const reloaded = normalizeState(JSON.stringify(first));
  assert.deepEqual(reloaded.projects[0].sessions[0].messages.map((message) => message.id),
    messages.map((message) => message.id));
});

test('重复消息 ID 在会话内重建，不丢失任何正文', () => {
  const old = workspace([
    { id: 'same', role: 'user', content: '第一条', ts: 1 },
    { id: 'same', role: 'assistant', content: '第二条', ts: 2 },
  ] as any);
  const messages = normalizeState(old).projects[0].sessions[0].messages;
  assert.deepEqual(messages.map((message) => message.content), ['第一条', '第二条']);
  assert.equal(new Set(messages.map((message) => message.id)).size, 2);
  assert.equal(messages[0].id, 'same');
});

test('跨项目的重复实验 ID 被安全重建且选中引用跟随', () => {
  const old = workspace();
  const second = structuredClone(old.projects[0]);
  second.id = 'p2';
  second.sessions.unshift({ id: 'other', title: '另一个实验', createdAt: 1, updatedAt: 1, messages: [] });
  second.activeSessionId = 's1';
  old.projects.push(second);
  const result = normalizeState(old);
  assert.notEqual(result.projects[0].sessions[0].id, result.projects[1].sessions[1].id);
  assert.equal(result.projects[1].activeSessionId, result.projects[1].sessions[1].id);
});

test('非字符串、空白和非法角色消息不会变成有效历史', () => {
  const input = workspace([
    { role: 'user', content: '', ts: 1 },
    { role: 'assistant', content: ' \n ', ts: 1 },
    { role: 'system', content: '不合法', ts: 1 },
    { role: 'user', content: 123 as unknown as string, ts: 1 },
    { role: 'user', content: '<img src=x onerror=alert(1)>', ts: 2 },
  ]);
  const messages = normalizeState(input).projects[0].sessions[0].messages;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, '<img src=x onerror=alert(1)>');
});

test('旧数据超过新容量时仍保留全部消息与完整正文', () => {
  const input = workspace(Array.from({ length: 201 }, (_, i) => ({
    role: 'user', content: i === 200 ? '字'.repeat(8001) : String(i), ts: i + 1,
  })));
  const messages = normalizeState(input).projects[0].sessions[0].messages;
  assert.equal(messages.length, 201);
  assert.equal(messages[0].content, '0');
  assert.equal(messages.at(-1).content.length, 8001);
});

test('新项目含独立的默认会话和关闭的协议', () => {
  const a = makeProject('A');
  const b = makeProject('B');
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.activeSessionId, b.activeSessionId);
  assert.equal(a.activeSessionId, a.sessions[0].id);
  assert.deepEqual(a.systemPrompt, { enabled: false, text: '', presetId: null });
});

test('存储首次读取与保存使用原 cyberchat.v1 键', () => {
  const values = new Map<string, string>();
  const storage = createStorage({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const first = storage.load();
  assert.equal(first.ok, true);
  assert.equal(first.fresh, true);
  assert.equal(storage.save(first.state), true);
  assert.equal(values.has(STORAGE_KEY), true);
  const restored = storage.load();
  assert.equal(restored.fresh, false);
  assert.deepEqual(restored.state, first.state);
});

test('存储不可用或读取失败返回明确失败状态', () => {
  assert.equal(createStorage(null).load().ok, false);
  const broken = createStorage({
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
  });
  assert.equal(broken.load().ok, false);
  assert.equal(broken.save(defaultState()), false);
});

test('损坏或无法读取的主存储不会被默认状态覆盖', () => {
  let raw = '{损坏的原文';
  const corrupt = createStorage({
    getItem: () => raw,
    setItem: (_key: string, value: string) => { raw = value; },
  });
  const loaded = corrupt.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.reason, 'corrupt');
  assert.equal(corrupt.save(loaded.state), false);
  assert.equal(raw, '{损坏的原文');

  let writes = 0;
  const unreadable = createStorage({
    getItem() { throw new Error('SecurityError'); },
    setItem() { writes += 1; },
  });
  assert.equal(unreadable.load().ok, false);
  assert.equal(unreadable.save(defaultState()), false);
  assert.equal(writes, 0);
});

test('保存失败不修改传入数据', () => {
  const data = workspace();
  const snapshot = JSON.stringify(data);
  const storage = createStorage({
    getItem: () => null,
    setItem() { throw new Error('QuotaExceededError'); },
  });
  assert.equal(storage.save(data), false);
  assert.equal(JSON.stringify(data), snapshot);
});

test('历史最多 40 条并保持时间顺序与首条 user', () => {
  const history = Array.from({ length: 61 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: String(i),
  }));
  const result = trimHistory(history);
  assert.equal(result.length, 39);
  assert.equal(result[0].role, 'user');
  assert.equal(result.at(-1).content, '60');
  assert.deepEqual(result.map((m) => Number(m.content)), Array.from({ length: 39 }, (_, i) => i + 22));
});

test('40 条历史全部保留，41 条仅丢弃最早一条', () => {
  const history = Array.from({ length: 41 }, (_, i) => ({ role: 'user', content: String(i) }));
  assert.deepEqual(trimHistory(history.slice(0, 40)).map((m) => m.content),
    history.slice(0, 40).map((m) => m.content));
  assert.deepEqual(trimHistory(history).map((m) => m.content),
    history.slice(1).map((m) => m.content));
});

test('历史累计最多 50000 字且每条最多 8000 字', () => {
  const result = trimHistory(Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user', content: String(i).padEnd(9000, 'x'),
  })));
  assert.ok(result.reduce((sum, m) => sum + m.content.length, 0) <= 50000);
  assert.ok(result.every((m) => m.content.length <= 8000));
  assert.equal(result[0].role, 'user');
  assert.ok(result.at(-1).content.startsWith('11'));
});

test('历史累计 50000 字不会多删有效消息', () => {
  const history = Array.from({ length: 7 }, (_, i) => ({
    role: 'user', content: 'x'.repeat(i === 6 ? 2000 : 8000),
  }));
  const result = trimHistory(history);
  assert.equal(result.length, 7);
  assert.equal(result.reduce((sum, m) => sum + m.content.length, 0), 50000);
});

for (const value of [undefined, null, '', ' \n\t ']) {
  test(`空协议字段不出现在请求体：${String(value)}`, () => {
    const result = buildRequestBody([{ role: 'user', content: '测试', ts: 1 }], value);
    assert.deepEqual(result, { messages: [{ role: 'user', content: '测试' }] });
    assert.equal(Object.hasOwn(result, 'systemPrompt'), false);
  });
}

test('协议按 trim 后的 4000/4001 边界校验', () => {
  const valid = resolveSystemPrompt({ systemPrompt: { enabled: true, text: ` ${'字'.repeat(4000)}\n` } });
  assert.equal(valid.error, '');
  assert.equal(valid.value.length, 4000);
  const invalid = resolveSystemPrompt({ systemPrompt: { enabled: true, text: '字'.repeat(4001) } });
  assert.equal(invalid.value, null);
  assert.match(invalid.error, /4000/);
  assert.deepEqual(resolveSystemPrompt({ systemPrompt: { enabled: false, text: '字'.repeat(4001) } }),
    { value: null, error: '' });
});

test('每个预设能通过完整文本匹配恢复，自定义文本不冒充预设', () => {
  for (const preset of PRESETS) assert.equal(matchPresetId(preset.text), preset.id);
  assert.equal(matchPresetId('自定义实验协议'), null);
});
