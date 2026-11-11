import assert from 'node:assert/strict';
import { test } from 'node:test';

async function loadLab(): Promise<any> {
  try {
    return await import('../../scripts/core/lab-data.js');
  } catch (error: any) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return {};
  }
}

test('界面设置独立存储，损坏值退化默认而不影响主对话', async () => {
  const { createUiStorage, UI_STORAGE_KEY } = await import('../../scripts/core/lab-data.js');
  assert.equal(typeof createUiStorage, 'function');
  const values = new Map<string, string>([['cyberchat.v1', '原始对话']]);
  const ui = createUiStorage({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  assert.equal(ui.load().state.wrapCode, false);
  assert.equal(ui.save({ version: 1, wrapCode: true }), true);
  assert.equal(ui.load().state.wrapCode, true);
  values.set(UI_STORAGE_KEY, '{损坏');
  const damaged = ui.load();
  assert.equal(damaged.ok, false);
  assert.equal(damaged.state.wrapCode, false);
  assert.equal(values.get('cyberchat.v1'), '原始对话');
});

test('运行状态码和错误类别可在实验扩展存储中往返', async () => {
  const { createAnnotationStorage, updateSessionAnnotation } = await import('../../scripts/core/lab-data.js');
  const values = new Map<string, string>();
  const storage = createAnnotationStorage({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const state = updateSessionAnnotation({ version: 1, sessions: {} }, 'session-a', {
    runs: { 'message-a': { outcome: 'error', statusCode: 502, errorCategory: 'http', route: 'gateway' } },
  });
  assert.equal(storage.save(state), true);
  const restored = storage.load();
  assert.equal(restored.state.sessions['session-a'].runs['message-a'].statusCode, 502);
  assert.equal(restored.state.sessions['session-a'].runs['message-a'].errorCategory, 'http');
});

test('标签去除首尾空白并按大小写无关方式去重', async () => {
  const lab = await loadLab();
  assert.equal(typeof lab.normalizeTags, 'function', '缺少标签归一函数');
  assert.deepEqual(lab.normalizeTags([' 代码 ', '代码', ' TEST ', 'test', '待复核']),
    ['代码', 'TEST', '待复核']);
});

test('标签边界和非法输入返回明确中文错误', async () => {
  const lab = await loadLab();
  assert.equal(typeof lab.normalizeTags, 'function', '缺少标签归一函数');
  const { normalizeTags } = lab;
  assert.deepEqual(normalizeTags(['字'.repeat(20)]), ['字'.repeat(20)]);
  assert.deepEqual(normalizeTags(['a', 'b', 'c', 'd', 'e', 'f', 'A']), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.throws(() => normalizeTags(['字'.repeat(21)]), /20/);
  assert.throws(() => normalizeTags(['a', 'b', 'c', 'd', 'e', 'f', 'g']), /6/);
  assert.throws(() => normalizeTags(['  ']), /标签/);
  assert.throws(() => normalizeTags([{ name: '标签' }]), /标签/);
  assert.throws(() => normalizeTags('标签'), /标签/);
});

const emptyAnnotations = () => ({ version: 1, sessions: {} });

const annotationFixture = () => ({
  version: 1,
  sessions: {
    'session-a': {
      notes: '先观察，再复核。',
      tags: ['代码', '待复核'],
      runs: {
        'message-a': {
          outcome: 'complete', durationMs: 21, characters: 5,
          model: '@makers/example', route: 'agent', requestId: 'request-a',
        },
      },
      updatedAt: 42,
    },
    'session-b': { notes: '独立笔记', tags: [], runs: {} },
  },
});

test('没有扩展数据、坏 JSON 和不兼容版本只重建扩展默认态', async () => {
  const lab = await loadLab();
  assert.equal(typeof lab.normalizeAnnotations, 'function', '缺少扩展数据归一函数');
  const chat = { version: 1, projects: [{ id: 'p1', messages: ['合成对话原文'] }] };
  const before = JSON.stringify(chat);
  for (const raw of [null, undefined, '', '{bad', 'null', '[]', 12, { version: 2, sessions: {} }]) {
    assert.deepEqual(lab.normalizeAnnotations(raw), emptyAnnotations());
  }
  assert.equal(JSON.stringify(chat), before);
});

test('兼容缺少可选字段的旧扩展记录并保留运行信息', async () => {
  const lab = await loadLab();
  assert.equal(typeof lab.normalizeAnnotations, 'function', '缺少扩展数据归一函数');
  const legacy = { version: 1, sessions: { 'old-session': { notes: '笔记', tags: [' 代码 ', '代码'] } } };
  const normalized = lab.normalizeAnnotations(legacy);
  assert.deepEqual(normalized.sessions['old-session'], { notes: '笔记', tags: ['代码'], runs: {} });
  assert.deepEqual(lab.normalizeAnnotations(JSON.stringify(annotationFixture())), annotationFixture());
  assert.deepEqual(legacy.sessions['old-session'].tags, [' 代码 ', '代码']);
});

test('损坏的笔记、标签、运行数据与污染键不会进入扩展默认态', async () => {
  const lab = await loadLab();
  assert.equal(typeof lab.normalizeAnnotations, 'function', '缺少扩展数据归一函数');
  const inputs = [
    { version: 1, sessions: { s1: { notes: '字'.repeat(12001), tags: [], runs: {} } } },
    { version: 1, sessions: { s1: { notes: '笔记', tags: [{ bad: 1 }], runs: {} } } },
    { version: 1, sessions: { s1: { notes: '笔记', tags: [], runs: { m: { route: '伪造路线' } } } } },
    JSON.parse('{"version":1,"sessions":{"__proto__":{"notes":"污染"}}}'),
  ];
  for (const input of inputs) assert.deepEqual(lab.normalizeAnnotations(input), emptyAnnotations());
  assert.equal(({} as any).polluted, undefined);
});

test('扩展存储只读写独立键，首次和正常恢复不改动对话', async () => {
  const lab = await loadLab();
  assert.equal(typeof lab.createAnnotationStorage, 'function', '缺少独立扩展存储');
  const values = new Map([['cyberchat.v1', '{"synthetic":"原样保留"}']]);
  const writes: string[] = [];
  const storage = lab.createAnnotationStorage({
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { writes.push(key); values.set(key, value); },
  });
  assert.deepEqual(storage.load(), { ok: true, state: emptyAnnotations(), fresh: true });
  assert.equal(storage.save(annotationFixture()), true);
  assert.deepEqual(writes, ['cyberlab.annotations.v1']);
  assert.equal(values.get('cyberchat.v1'), '{"synthetic":"原样保留"}');
  assert.deepEqual(storage.load(), { ok: true, state: annotationFixture(), fresh: false });
});

test('坏扩展不会自动覆盖，存储不可用或满额时明确返回失败', async () => {
  const lab = await loadLab();
  assert.equal(typeof lab.createAnnotationStorage, 'function', '缺少独立扩展存储');
  let writes = 0;
  const corrupt = lab.createAnnotationStorage({
    getItem() { return '{bad'; },
    setItem() { writes++; },
  });
  const loaded = corrupt.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.reason, 'corrupt');
  assert.deepEqual(loaded.state, emptyAnnotations());
  assert.equal(writes, 0);
  assert.equal(corrupt.save({ version: 1, sessions: { s1: { notes: '字'.repeat(12001) } } }), false);
  assert.equal(writes, 0);
  assert.equal(lab.createAnnotationStorage(null).load().reason, 'unavailable');
  const blocked = lab.createAnnotationStorage({
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
  });
  assert.equal(blocked.load().reason, 'read-error');
  assert.equal(blocked.save(annotationFixture()), false);
});

test('读取和更新实验扩展都不修改原对象或共享其嵌套数据', async () => {
  const lab = await loadLab();
  assert.equal(typeof lab.getSessionAnnotation, 'function', '缺少扩展记录读取函数');
  assert.equal(typeof lab.updateSessionAnnotation, 'function', '缺少扩展记录更新函数');
  const before = annotationFixture();
  const snapshot = structuredClone(before);
  assert.deepEqual(lab.getSessionAnnotation(before, 'missing'), { notes: '', tags: [], runs: {} });
  const read = lab.getSessionAnnotation(before, 'session-a');
  read.tags.push('只改变副本');
  read.runs['message-a'].model = '只改变副本';
  assert.deepEqual(before, snapshot);
  const updated = lab.updateSessionAnnotation(before, 'session-a', {
    notes: '字'.repeat(12000), tags: [' 实验 ', '实验', '测试'],
  });
  assert.deepEqual(before, snapshot);
  assert.notEqual(updated, before);
  assert.deepEqual(updated.sessions['session-a'].tags, ['实验', '测试']);
  assert.equal(updated.sessions['session-a'].notes.length, 12000);
  assert.ok(updated.sessions['session-a'].updatedAt >= 42);
  assert.equal(updated.sessions['session-a'].runs['message-a'].model, '@makers/example');
  updated.sessions['session-b'].tags.push('不共享');
  assert.deepEqual(before, snapshot);
});

test('扩展更新拒绝超额、非字符串、保留键和未知字段', async () => {
  const lab = await loadLab();
  assert.equal(typeof lab.updateSessionAnnotation, 'function', '缺少扩展记录更新函数');
  const before = annotationFixture();
  const snapshot = JSON.stringify(before);
  assert.throws(() => lab.updateSessionAnnotation(before, 'session-a', { notes: '字'.repeat(12001) }), /12000/);
  assert.throws(() => lab.updateSessionAnnotation(before, 'session-a', { notes: 123 }), /笔记/);
  assert.throws(() => lab.updateSessionAnnotation(before, 'session-a', { extra: true }), /字段/);
  assert.throws(() => lab.updateSessionAnnotation(before, '__proto__', { notes: '危险' }), /ID|标识/);
  assert.throws(() => lab.updateSessionAnnotation(before, 'session-a', { runs: { x: { route: 'faked' } } }), /route|路径/);
  assert.equal(JSON.stringify(before), snapshot);
});
