import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as lab from '../../scripts/core/lab-data.js';

function workspace() {
  return {
    version: 1,
    activeProjectId: 'current-project',
    projects: [{
      id: 'current-project', name: '当前项目', createdAt: 1000, updatedAt: 2000,
      systemPrompt: { enabled: false, text: '', presetId: null },
      activeSessionId: 'current-session',
      sessions: [{
        id: 'current-session', title: '当前实验', createdAt: 1000, updatedAt: 2000,
        messages: [{ id: 'current-message', role: 'user', content: '现有对话', ts: 1000 }],
      }],
    }],
  };
}

function imported() {
  const chat = {
    version: 1,
    activeProjectId: 'old-project',
    projects: [{
      id: 'old-project', name: '旧项目', createdAt: 3000, updatedAt: 4000,
      systemPrompt: { enabled: true, text: '保持原始协议', presetId: null },
      activeSessionId: 'old-session',
      sessions: [{
        id: 'old-session', title: '标题 [实验]', createdAt: 3000, updatedAt: 4000,
        messages: [
          { id: 'old-user', role: 'user', content: '<img src=x onerror=alert(1)>', ts: 3000 },
          { id: 'old-answer', role: 'assistant', content: '结果\n```js\nconsole.log(1)\n```', ts: 4000 },
        ],
      }],
    }],
  };
  const annotations = { version: 1, sessions: {
    'old-session': { notes: '保留笔记', tags: ['代码'], runs: {
      'old-answer': { outcome: 'complete', characters: 6, route: 'agent' },
    } },
  } };
  return { format: 'cyberlab.backup', version: 1, exportedAt: '2026-11-11T00:00:00.000Z', chat, annotations };
}

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
function inspect(value: unknown) {
  const text = JSON.stringify(value);
  return (lab as any).inspectWorkspaceBackup(text, bytes(text));
}

test('单实验 Markdown 包含项目、协议、笔记和原样对话', () => {
  assert.equal(typeof (lab as any).serializeSessionMarkdown, 'function');
  const backup = imported();
  const project = backup.chat.projects[0];
  const md = (lab as any).serializeSessionMarkdown(project, project.sessions[0], backup.annotations.sessions['old-session']);
  for (const text of ['旧项目', '标题', 'old-session', '保持原始协议', '保留笔记', '代码', '<img src=x onerror=alert(1)>', 'console.log(1)']) {
    assert.ok(md.includes(text), text);
  }
  assert.match(md, /`{4,}/, '包含嵌套代码围栏时应采用更长的外层围栏');
});

test('大量零散反引号不会让 Markdown 导出栈溢出', () => {
  const backup = imported();
  const session = backup.chat.projects[0].sessions[0];
  session.messages[1].content = '字`'.repeat(150000);
  assert.doesNotThrow(() => (lab as any).serializeSessionMarkdown(backup.chat.projects[0], session, backup.annotations.sessions['old-session']));
});

test('备份复制工作区，后续修改不会改变快照', () => {
  const backup = imported();
  const snapshot = (lab as any).createWorkspaceBackup(backup.chat, backup.annotations, backup.exportedAt);
  assert.equal(snapshot.format, 'cyberlab.backup');
  assert.equal(snapshot.version, 1);
  backup.chat.projects[0].name = '新名字';
  backup.annotations.sessions['old-session'].notes = '被修改';
  assert.equal(snapshot.chat.projects[0].name, '旧项目');
  assert.equal(snapshot.annotations.sessions['old-session'].notes, '保留笔记');
});

test('文件名去除路径、控制字符并限制长度', () => {
  assert.equal(typeof (lab as any).safeFileName, 'function');
  const name = (lab as any).safeFileName(' ../实\\验:*?<>|"%\u0000' + '字'.repeat(100));
  assert.doesNotMatch(name, /[\\/?%*:|"<>\x00-\x1f\x7f]/);
  assert.ok(name.length <= 48);
  assert.ok(name.length > 0);
});

test('合法备份预览统计项目、实验、消息、笔记和标签', () => {
  const result = inspect(imported());
  assert.equal(result.ok, true);
  assert.deepEqual(result.stats, { projects: 1, sessions: 1, messages: 2, notes: 1, tags: 1 });
});

test('错误 JSON、错误格式、版本与 5MiB 超限全部拒绝', () => {
  for (const [text, length] of [
    ['{bad', 4],
    [JSON.stringify({ ...imported(), format: 'other' }), 0],
    [JSON.stringify({ ...imported(), version: 2 }), 0],
    [JSON.stringify(imported()), 5 * 1024 * 1024 + 1],
  ] as Array<[string, number]>) {
    const result = (lab as any).inspectWorkspaceBackup(text, length || bytes(text));
    assert.equal(result.ok, false);
    assert.ok(result.error);
  }
});

test('重复 ID、无效字段、超额与污染键全部拒绝', () => {
  const cases: any[] = [];
  const duplicate = imported();
  duplicate.chat.projects[0].sessions[0].messages[1].id = 'old-user';
  cases.push(duplicate);
  const role = imported();
  (role.chat.projects[0].sessions[0].messages[0] as any).role = 'system';
  cases.push(role);
  const prompt = imported();
  prompt.chat.projects[0].systemPrompt.text = '字'.repeat(4001);
  cases.push(prompt);
  const count = imported();
  count.chat.projects[0].sessions[0].messages = Array.from({ length: 201 }, (_, i) => ({ id: `m${i}`, role: 'user', content: '字', ts: 1 }));
  cases.push(count);
  const polluted = JSON.parse(JSON.stringify(imported()).replace('"notes":"保留笔记"', '"__proto__":{"polluted":true},"notes":"保留笔记"'));
  cases.push(polluted);
  for (const candidate of cases) {
    const result = inspect(candidate);
    assert.equal(result.ok, false);
    assert.ok(result.error);
  }
  assert.equal(({} as any).polluted, undefined);
});

test('导入合并不覆盖当前项目且重建所有引用', () => {
  const current = workspace();
  const currentAnnotations = { version: 1, sessions: {} };
  const backup = imported();
  const oldCurrent = JSON.stringify(current);
  const oldBackup = JSON.stringify(backup);
  let id = 0;
  const result = (lab as any).buildMergedImport(current, currentAnnotations, backup, () => `new-${++id}`);
  assert.equal(result.chat.activeProjectId, 'current-project');
  assert.equal(result.chat.projects.length, 2);
  assert.equal(result.chat.projects[0].name, '当前项目');
  const p = result.chat.projects[1];
  const s = p.sessions[0];
  assert.notEqual(p.id, 'old-project');
  assert.notEqual(s.id, 'old-session');
  assert.equal(p.activeSessionId, s.id);
  assert.notEqual(s.messages[0].id, 'old-user');
  assert.notEqual(s.messages[1].id, 'old-answer');
  assert.equal(result.annotations.sessions[s.id].notes, '保留笔记');
  assert.equal(result.annotations.sessions[s.id].runs[s.messages[1].id].route, 'agent');
  assert.equal(JSON.stringify(current), oldCurrent);
  assert.equal(JSON.stringify(backup), oldBackup);
});

test('导入超过工作区容量或 ID 生成碰撞时不改变已有数据', () => {
  assert.equal(typeof (lab as any).buildMergedImport, 'function');
  const current = workspace();
  current.projects = Array.from({ length: 50 }, (_, i) => ({
    ...structuredClone(current.projects[0]), id: `p${i}`,
  }));
  current.activeProjectId = 'p0';
  const snapshot = JSON.stringify(current);
  assert.throws(() => (lab as any).buildMergedImport(current, { version: 1, sessions: {} }, imported(), () => 'collision'));
  assert.equal(JSON.stringify(current), snapshot);
  assert.throws(() => (lab as any).buildMergedImport(workspace(), { version: 1, sessions: {} }, imported(), () => 'current-project'));
});
