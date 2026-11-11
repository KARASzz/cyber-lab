import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as lab from '../../scripts/core/lab-data.js';

const message = (content: string) => ({ role: 'user', content, ts: 1 });
const session = (id: string, title: string, updatedAt: number, content = '其他内容') => ({
  id, title, createdAt: 1, updatedAt, messages: [message(content)],
});
const project = (id: string, name: string, sessions: any[]) => ({
  id, name, createdAt: 1, updatedAt: 1,
  systemPrompt: { enabled: false, text: '', presetId: null },
  activeSessionId: sessions[0]?.id ?? '', sessions,
});

function fixture() {
  const sessions = [
    session('exact-old', 'Target', 10),
    session('exact-new', 'TARGET', 20),
    session('prefix', 'Target 方案', 30),
    session('contains', '我的 Target 记录', 40),
    session('tag', '标签命中', 50),
    session('note', '笔记命中', 60),
    session('message', '消息命中', 70, `${'前'.repeat(130)} target ${'后'.repeat(130)}`),
    session('none', '不匹配', 80),
  ];
  return {
    chat: { version: 1, activeProjectId: 'p1', projects: [project('p1', '合成项目', sessions)] },
    annotations: {
      version: 1,
      sessions: {
        tag: { notes: '', tags: ['target'], runs: {} },
        note: { notes: '这是 TARGET 笔记', tags: [], runs: {} },
      },
    },
  };
}

test('全局搜索按精确、前缀、包含、标签、笔记、消息和时间排序', () => {
  assert.equal(typeof (lab as any).searchWorkspace, 'function', '缺少工作区搜索函数');
  const data = fixture();
  const snapshot = JSON.stringify(data);
  const result = (lab as any).searchWorkspace(data, '  tArGeT  ', { limit: 50 });
  assert.deepEqual(result.map((item: any) => item.sessionId),
    ['exact-new', 'exact-old', 'prefix', 'contains', 'tag', 'note', 'message']);
  assert.deepEqual(result.map((item: any) => item.match),
    ['title-exact', 'title-exact', 'title-prefix', 'title-substring', 'tag', 'note', 'message']);
  assert.equal(result[0].projectId, 'p1');
  assert.equal(result[0].projectName, '合成项目');
  assert.equal(result[0].sessionTitle, 'TARGET');
  assert.equal(JSON.stringify(data), snapshot);
});

test('项目名也可搜索并返回可跳转的项目和实验路径', () => {
  assert.equal(typeof (lab as any).searchWorkspace, 'function', '缺少工作区搜索函数');
  const data = fixture();
  const result = (lab as any).searchWorkspace(data, '合成', {});
  assert.equal(result.length, 8);
  assert.ok(result.every((item: any) => item.projectId === 'p1' && item.match === 'title-prefix'));
  assert.ok(result.every((item: any) => item.projectName === '合成项目' && item.sessionId));
});

test('空查询按最近实验返回，限制不会超过 50', () => {
  assert.equal(typeof (lab as any).searchWorkspace, 'function', '缺少工作区搜索函数');
  const sessions = Array.from({ length: 60 }, (_, i) => session(`s${i}`, `实验${i}`, i + 1));
  const data = {
    chat: { version: 1, activeProjectId: 'p', projects: [project('p', '项目', sessions)] },
    annotations: { version: 1, sessions: { s0: { notes: '', tags: [], runs: {}, updatedAt: 100 } } },
  };
  const result = (lab as any).searchWorkspace(data, ' ', { limit: 500 });
  assert.equal(result.length, 50);
  assert.equal(result[0].sessionId, 's0');
  assert.equal(result[1].sessionId, 's59');
  assert.ok(result.every((item: any) => item.match === 'recent'));
  assert.equal((lab as any).searchWorkspace(data, '', { limit: 2 }).length, 2);
  assert.deepEqual((lab as any).searchWorkspace(data, '', { limit: 0 }), []);
});

test('消息片段围绕命中点且不超过 120 字符，按纯文本返回', () => {
  assert.equal(typeof (lab as any).searchWorkspace, 'function', '缺少工作区搜索函数');
  const result = (lab as any).searchWorkspace(fixture(), 'target', { limit: 50 });
  const found = result.find((item: any) => item.sessionId === 'message');
  assert.ok(found.snippet.length <= 120);
  assert.match(found.snippet.toLowerCase(), /target/);
  assert.ok(found.snippet.includes('前') && found.snippet.includes('后'));
  const data = fixture();
  data.chat.projects[0].sessions[6].messages[0].content = '<img src=x onerror=alert(1)> needle';
  const xss = (lab as any).searchWorkspace(data, 'needle', {}).find((item: any) => item.sessionId === 'message');
  assert.ok(xss.snippet.includes('<img src=x onerror=alert(1)>'));
});

test('扩展数据损坏不阻止搜索对话，错误查询和限制给出中文错误', () => {
  assert.equal(typeof (lab as any).searchWorkspace, 'function', '缺少工作区搜索函数');
  const data: any = fixture();
  data.annotations = '{bad';
  const result = (lab as any).searchWorkspace(data, 'target', {});
  assert.ok(result.some((item: any) => item.sessionId === 'message'));
  assert.ok(!result.some((item: any) => item.sessionId === 'tag'));
  assert.throws(() => (lab as any).searchWorkspace(data, null, {}), /查询|搜索/);
  assert.throws(() => (lab as any).searchWorkspace(data, '', { limit: -1 }), /数量|limit|限制/);
});
