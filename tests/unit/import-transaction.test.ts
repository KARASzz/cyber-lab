import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STORAGE_KEY } from '../../scripts/core/state.js';
import { LAB_STORAGE_KEY } from '../../scripts/core/lab-data.js';
import * as transaction from '../../scripts/core/import-transaction.js';

function fakeStore() {
  const map = new Map<string, string>([
    [STORAGE_KEY, '{"original":"旧对话"}'],
    [LAB_STORAGE_KEY, '{"original":"旧笔记"}'],
  ]);
  let writes = 0;
  let failAt = 0;
  let failAllAfter = 0;
  return {
    map,
    getItem(key: string) { return map.get(key) ?? null; },
    setItem(key: string, value: string) {
      writes += 1;
      if (writes === failAt || (failAllAfter && writes >= failAllAfter)) throw new Error('synthetic quota');
      map.set(key, value);
    },
    removeItem(key: string) { map.delete(key); },
    setFailure(at: number, persistent = false) { failAt = at; failAllAfter = persistent ? at : 0; },
    clearFailure() { failAt = 0; failAllAfter = 0; },
  };
}

const candidate = { chat: { version: 1, projects: [{ id: '新项目' }] }, annotations: { version: 1, sessions: {} } };

test('成功导入同时持久化两个新状态并清理事务记录', () => {
  assert.equal(typeof (transaction as any).commitImportTransaction, 'function');
  const store = fakeStore();
  const result = (transaction as any).commitImportTransaction(store, candidate);
  assert.equal(result.ok, true);
  assert.equal(store.getItem(STORAGE_KEY), JSON.stringify(candidate.chat));
  assert.equal(store.getItem(LAB_STORAGE_KEY), JSON.stringify(candidate.annotations));
  assert.equal(store.getItem((transaction as any).IMPORT_TRANSACTION_KEY), null);
});

for (const failureAt of [1, 2, 3]) {
  test(`第 ${failureAt} 次写入失败时不覆盖原对话和笔记`, () => {
    const store = fakeStore();
    store.setFailure(failureAt);
    const result = (transaction as any).commitImportTransaction(store, candidate);
    assert.equal(result.ok, false);
    assert.equal(store.getItem(STORAGE_KEY), '{"original":"旧对话"}');
    assert.equal(store.getItem(LAB_STORAGE_KEY), '{"original":"旧笔记"}');
  });
}

test('回滚暂时失败时保留事务记录，恢复可用后还原原数据', () => {
  const store = fakeStore();
  store.setFailure(3, true);
  const result = (transaction as any).commitImportTransaction(store, candidate);
  assert.equal(result.ok, false);
  assert.ok(store.getItem((transaction as any).IMPORT_TRANSACTION_KEY));
  store.clearFailure();
  const recovered = (transaction as any).recoverImportTransaction(store);
  assert.equal(recovered.ok, true);
  assert.equal(store.getItem(STORAGE_KEY), '{"original":"旧对话"}');
  assert.equal(store.getItem(LAB_STORAGE_KEY), '{"original":"旧笔记"}');
  assert.equal(store.getItem((transaction as any).IMPORT_TRANSACTION_KEY), null);
});

test('检测到其他标签页修改后拒绝使用旧快照导入', () => {
  const store = fakeStore();
  const expected = { chat: store.getItem(STORAGE_KEY), annotations: store.getItem(LAB_STORAGE_KEY) };
  store.setItem(STORAGE_KEY, '{"otherTab":"新的对话"}');
  const result = (transaction as any).commitImportTransaction(store, candidate, expected);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'conflict');
  assert.equal(store.getItem(STORAGE_KEY), '{"otherTab":"新的对话"}');
  assert.equal(store.getItem(LAB_STORAGE_KEY), '{"original":"旧笔记"}');
  assert.equal(store.getItem((transaction as any).IMPORT_TRANSACTION_KEY), null);
});

test('损坏或冲突的事务记录不会覆盖现有数据', () => {
  const store = fakeStore();
  store.map.set((transaction as any).IMPORT_TRANSACTION_KEY, '{损坏');
  const recovered = (transaction as any).recoverImportTransaction(store);
  assert.equal(recovered.ok, false);
  assert.equal(store.getItem(STORAGE_KEY), '{"original":"旧对话"}');
  assert.equal(store.getItem(LAB_STORAGE_KEY), '{"original":"旧笔记"}');
  assert.equal(store.getItem((transaction as any).IMPORT_TRANSACTION_KEY), '{损坏');
});
