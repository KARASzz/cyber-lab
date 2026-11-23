import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHttpServer, formatWikiContent } from '../../cloudrun/server.mjs';

test('formatWikiContent generates compliant markdown for karas-knowledge wiki', () => {
  const content = formatWikiContent({
    title: '推理计算测试实验',
    sessionId: 'sess-123',
    category: '大模型二三事',
    tags: ['AI/ML', '测试时计算'],
    notes: '这是本次实验的核心结论。',
    messages: [
      { role: 'user', content: '如何评估推理预算？' },
      { role: 'assistant', content: '应综合衡量延迟、Token 消耗与准确率。' },
    ],
    runs: {
      msg1: {
        model: 'deepseek-v4.1',
        timeToFirstTokenMs: 240,
        durationMs: 1200,
        characters: 450,
      },
    },
  });

  assert.match(content, /^---\ntitle: 推理计算测试实验/);
  assert.match(content, /type: note/);
  assert.match(content, /sources: \[cyber-lab\/session-sess-123\]/);
  assert.match(content, /tags: \[.*AI\/ML.*实验记录.*\]/);
  assert.match(content, /## 实验结论与洞察\n这是本次实验的核心结论。/);
  assert.match(content, /### 👤 实验员\n如何评估推理预算？/);
  assert.match(content, /### 🤖 实验助手\n应综合衡量延迟、Token 消耗与准确率。/);
  assert.match(content, /## 运行遥测数据/);
  assert.match(content, /deepseek-v4\.1/);
});

test('HTTP /api/lab/* endpoints work with database mock and proper validation', async () => {
  let committed = false;
  let queries = [];

  const mockClient = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql === 'COMMIT') committed = true;
      return { rows: [] };
    },
    release: () => {},
  };

  const mockPool = {
    connect: async () => mockClient,
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('FROM lab_projects')) {
        return {
          rows: [
            {
              id: 'p1',
              name: '测试项目',
              system_prompt: { enabled: true, text: '指令', presetId: 'coder' },
              active_session_id: 's1',
              created_at: 1000,
              updated_at: 2000,
            },
          ],
        };
      }
      if (sql.includes('FROM lab_sessions') && !sql.includes('WHERE id = $1')) {
        return {
          rows: [
            {
              id: 's1',
              project_id: 'p1',
              title: '会话1',
              messages: [{ role: 'user', content: '你好' }],
              created_at: 1000,
              updated_at: 2000,
            },
          ],
        };
      }
      if (sql.includes('FROM lab_annotations') && !sql.includes('WHERE session_id = $1')) {
        return {
          rows: [
            {
              session_id: 's1',
              tags: ['AI'],
              notes: '笔记1',
              runs: {},
              wiki_path: 'entities/experiment-s1.md',
              wiki_synced_at: new Date('2026-11-23T12:00:00Z'),
              updated_at: 2000,
            },
          ],
        };
      }
      if (sql.includes('FROM lab_sessions WHERE id = $1')) {
        return {
          rows: [
            {
              id: 's1',
              title: '会话1',
              messages: [{ role: 'user', content: '测试问题' }],
            },
          ],
        };
      }
      if (sql.includes('FROM lab_annotations WHERE session_id = $1')) {
        return {
          rows: [
            {
              tags: ['AI/ML'],
              notes: '提炼笔记',
              runs: {},
            },
          ],
        };
      }
      return { rows: [] };
    },
  };

  const server = createHttpServer({
    environment: { DB_NAME: 'postgres' },
    databasePool: mockPool,
    staticDirectory: process.cwd(),
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. GET /api/lab/workspace
    const wsRes = await fetch(`${baseUrl}/api/lab/workspace`);
    assert.equal(wsRes.status, 200);
    const wsData = await wsRes.json();
    assert.equal(wsData.status, 'ok');
    assert.equal(wsData.workspace.projects.length, 1);
    assert.equal(wsData.workspace.projects[0].name, '测试项目');
    assert.equal(wsData.annotations.sessions.s1.notes, '笔记1');
    assert.equal(wsData.annotations.sessions.s1.wikiPath, 'entities/experiment-s1.md');

    // 2. POST /api/lab/sync
    const syncRes = await fetch(`${baseUrl}/api/lab/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace: {
          projects: [
            {
              id: 'p1',
              name: '新项目名',
              systemPrompt: { enabled: false, text: '' },
              activeSessionId: 's1',
              createdAt: 1000,
              updatedAt: 3000,
              sessions: [
                {
                  id: 's1',
                  title: '新会话标题',
                  messages: [{ role: 'user', content: '测试同步' }],
                  createdAt: 1000,
                  updatedAt: 3000,
                },
              ],
            },
          ],
        },
        annotations: {
          sessions: {
            s1: {
              tags: ['同步标签'],
              notes: '同步笔记',
              runs: {},
              updatedAt: 3000,
            },
          },
        },
      }),
    });
    assert.equal(syncRes.status, 200);
    assert.equal(committed, true);

    // 3. POST /api/lab/promote-to-wiki
    const promoteRes = await fetch(`${baseUrl}/api/lab/promote-to-wiki`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: 's1',
        title: '测试沉淀文章',
        category: '学习笔记',
        tags: ['AI/ML', '自动化测试'],
      }),
    });
    assert.equal(promoteRes.status, 200);
    const promoteData = await promoteRes.json();
    assert.equal(promoteData.status, 'ok');
    assert.equal(promoteData.wikiPath, 'entities/experiment-s1.md');

    // 4. POST /api/lab/promote-to-wiki 缺少必填字段返回 400
    const badPromoteRes = await fetch(`${baseUrl}/api/lab/promote-to-wiki`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    });
    assert.equal(badPromoteRes.status, 400);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
