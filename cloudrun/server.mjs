import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { onRequest as handleChatRequest } from '../cloud-functions/api/chat.js';
import { Connector } from '@google-cloud/cloud-sql-connector';
import pg from 'pg';

const { Pool } = pg;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staticRoot = path.join(projectRoot, 'dist');
const requestBodyLimit = 1024 * 1024;
const allowedStaticFiles = new Set(['index.html', 'style.css', 'app.js', 'styles/lab.css']);
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
]);

function sendJson(response, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(payload);
}

function requestHeaders(incomingHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incomingHeaders)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > requestBodyLimit) {
      const error = new Error('请求体过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function streamResponse(webResponse, nodeResponse) {
  nodeResponse.statusCode = webResponse.status;
  webResponse.headers.forEach((value, name) => nodeResponse.setHeader(name, value));
  if (!webResponse.body) {
    nodeResponse.end();
    return;
  }

  const reader = webResponse.body.getReader();
  try {
    while (!nodeResponse.destroyed) {
      const result = await reader.read();
      if (result.done) break;
      if (!nodeResponse.write(Buffer.from(result.value))) {
        await new Promise((resolve) => {
          if (nodeResponse.destroyed) {
            resolve();
            return;
          }
          const finishWaiting = () => {
            nodeResponse.removeListener('drain', finishWaiting);
            nodeResponse.removeListener('close', finishWaiting);
            resolve();
          };
          nodeResponse.once('drain', finishWaiting);
          nodeResponse.once('close', finishWaiting);
        });
      }
    }
    if (!nodeResponse.destroyed) nodeResponse.end();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function serveStatic(request, response, rootDirectory) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    sendJson(response, 400, { error: '请求路径无效' });
    return;
  }

  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  if (requestedPath.includes('\\')) {
    sendJson(response, 404, { error: '未找到' });
    return;
  }

  const relativePath = requestedPath.slice(1);
  const isScriptAsset = /^scripts\/(?:core|ui)\/[A-Za-z0-9._-]+\.js$/.test(relativePath);
  if (!allowedStaticFiles.has(relativePath) && !isScriptAsset) {
    sendJson(response, 404, { error: '未找到' });
    return;
  }

  const resolvedRoot = path.resolve(rootDirectory);
  const filePath = path.resolve(resolvedRoot, `.${requestedPath}`);
  if (!filePath.startsWith(`${resolvedRoot}${path.sep}`)) {
    sendJson(response, 404, { error: '未找到' });
    return;
  }

  let resolvedFilePath;
  let fileInfo;
  try {
    const realRoot = await realpath(resolvedRoot);
    resolvedFilePath = await realpath(filePath);
    if (!resolvedFilePath.startsWith(`${realRoot}${path.sep}`)) {
      sendJson(response, 404, { error: '未找到' });
      return;
    }
    fileInfo = await stat(resolvedFilePath);
  } catch {
    sendJson(response, 404, { error: '未找到' });
    return;
  }
  if (!fileInfo.isFile()) {
    sendJson(response, 404, { error: '未找到' });
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  response.writeHead(200, {
    'Content-Type': mimeTypes.get(extension) || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  await new Promise((resolve) => {
    const stream = createReadStream(resolvedFilePath);
    stream.on('error', () => {
      if (response.headersSent) response.destroy();
      else sendJson(response, 500, { error: '无法读取页面资源' });
      resolve();
    });
    response.on('finish', resolve);
    stream.pipe(response);
  });
}

function createChatRequest(request, body, signal) {
  const url = `http://${request.headers.host || 'localhost'}${request.url}`;
  return new Request(url, {
    method: request.method,
    headers: requestHeaders(request.headers),
    ...(body === undefined ? {} : { body, duplex: 'half' }),
    signal,
  });
}

export function formatWikiContent({ title, sessionId, category = '实验记录', tags = [], notes = '', messages = [], runs = {} }) {
  const today = new Date().toISOString().slice(0, 10);
  const cleanTags = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean) : [];
  if (!cleanTags.includes('实验记录')) cleanTags.push('实验记录');

  const frontmatter = [
    '---',
    `title: ${title}`,
    `created: ${today}`,
    `updated: ${today}`,
    'type: note',
    `tags: [${cleanTags.map((t) => JSON.stringify(t)).join(', ')}]`,
    `sources: [cyber-lab/session-${sessionId}]`,
    'confidence: high',
    'contested: false',
    'contradictions: []',
    '---',
  ].join('\n');

  let body = `\n\n# ${title}\n\n## 实验结论与洞察\n${notes.trim() || '（无额外笔记）'}\n\n## 实验对话记录\n`;
  if (Array.isArray(messages) && messages.length > 0) {
    for (const msg of messages) {
      const roleName = msg.role === 'assistant' ? '🤖 实验助手' : '👤 实验员';
      body += `\n### ${roleName}\n${String(msg.content || '').trim()}\n`;
    }
  } else {
    body += '\n（无对话内容）\n';
  }

  const runKeys = Object.keys(runs || {});
  if (runKeys.length > 0) {
    body += '\n## 运行遥测数据\n';
    const latestRun = runs[runKeys[runKeys.length - 1]] || {};
    if (latestRun.model) body += `- **模型**：\`${latestRun.model}\`\n`;
    if (latestRun.timeToFirstTokenMs) body += `- **首 Token 延迟**：${latestRun.timeToFirstTokenMs} ms\n`;
    if (latestRun.durationMs) body += `- **总耗时**：${latestRun.durationMs} ms\n`;
    if (latestRun.characters) body += `- **结果字符数**：${latestRun.characters}\n`;
  }

  return frontmatter + body;
}

export function createHttpServer({
  environment = process.env,
  databasePool = null,
  staticDirectory = staticRoot,
  chatRateLimit = { windowMs: 60_000, maxRequests: 20 },
} = {}) {
  let chatWindowStartedAt = Date.now();
  let chatRequestCount = 0;

  return http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    response.setHeader('X-Content-Type-Options', 'nosniff');

    if (pathname === '/healthz' && (request.method === 'GET' || request.method === 'HEAD')) {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (pathname === '/api/health' && request.method === 'GET') {
      if (!databasePool) {
        sendJson(response, 200, { status: 'ok', database: 'not-configured' });
        return;
      }
      try {
        const result = await databasePool.query('SELECT current_database() AS name');
        const connected = result.rows[0]?.name === environment.DB_NAME;
        sendJson(response, connected ? 200 : 503, {
          status: connected ? 'ok' : 'error',
          database: connected ? 'ok' : 'unavailable',
        });
      } catch {
        sendJson(response, 503, { status: 'error', database: 'unavailable' });
      }
      return;
    }

    if (pathname === '/api/lab/workspace' && request.method === 'GET') {
      if (!databasePool) {
        sendJson(response, 200, { status: 'ok', workspace: null, annotations: null, configured: false });
        return;
      }
      try {
        const [projectsRes, sessionsRes, annotationsRes] = await Promise.all([
          databasePool.query('SELECT id, name, system_prompt, active_session_id, created_at, updated_at FROM lab_projects ORDER BY created_at ASC'),
          databasePool.query('SELECT id, project_id, title, messages, created_at, updated_at FROM lab_sessions ORDER BY created_at ASC'),
          databasePool.query('SELECT session_id, tags, notes, runs, wiki_path, wiki_synced_at, updated_at FROM lab_annotations'),
        ]);

        const sessionsByProject = new Map();
        for (const s of sessionsRes.rows) {
          if (!sessionsByProject.has(s.project_id)) sessionsByProject.set(s.project_id, []);
          sessionsByProject.get(s.project_id).push({
            id: s.id,
            title: s.title,
            createdAt: Number(s.created_at),
            updatedAt: Number(s.updated_at),
            messages: Array.isArray(s.messages) ? s.messages : [],
          });
        }

        const projects = projectsRes.rows.map((p) => ({
          id: p.id,
          name: p.name,
          systemPrompt: p.system_prompt || { enabled: false, text: '', presetId: null },
          activeSessionId: p.active_session_id || '',
          createdAt: Number(p.created_at),
          updatedAt: Number(p.updated_at),
          sessions: sessionsByProject.get(p.id) || [],
        }));

        const annotationsSessions = {};
        for (const a of annotationsRes.rows) {
          annotationsSessions[a.session_id] = {
            tags: Array.isArray(a.tags) ? a.tags : [],
            notes: a.notes || '',
            runs: a.runs || {},
            wikiPath: a.wiki_path || null,
            wikiSyncedAt: a.wiki_synced_at ? new Date(a.wiki_synced_at).toISOString() : null,
            updatedAt: Number(a.updated_at),
          };
        }

        sendJson(response, 200, {
          status: 'ok',
          workspace: {
            activeProjectId: projects[0]?.id || '',
            projects,
          },
          annotations: {
            version: 1,
            sessions: annotationsSessions,
          },
        });
      } catch (error) {
        if (error.code === '42P01') {
          sendJson(response, 200, { status: 'ok', workspace: null, annotations: null, uninitialized: true });
          return;
        }
        sendJson(response, 500, { error: '无法读取工作区数据' });
      }
      return;
    }

    if (pathname === '/api/lab/sync' && request.method === 'POST') {
      if (!databasePool) {
        sendJson(response, 503, { error: '数据库未连接' });
        return;
      }
      let body;
      try {
        body = JSON.parse(await readBody(request));
      } catch {
        sendJson(response, 400, { error: '无效的 JSON 请求体' });
        return;
      }

      const client = await databasePool.connect();
      try {
        await client.query('BEGIN');
        const projects = body?.workspace?.projects;
        if (Array.isArray(projects)) {
          for (const p of projects) {
            if (!p || typeof p.id !== 'string') continue;
            await client.query(
              `INSERT INTO lab_projects (id, name, system_prompt, active_session_id, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (id) DO UPDATE SET
                 name = EXCLUDED.name,
                 system_prompt = EXCLUDED.system_prompt,
                 active_session_id = EXCLUDED.active_session_id,
                 updated_at = EXCLUDED.updated_at;`,
              [
                p.id,
                String(p.name || '').slice(0, 128),
                JSON.stringify(p.systemPrompt || {}),
                p.activeSessionId || null,
                Number(p.createdAt) || Date.now(),
                Number(p.updatedAt) || Date.now(),
              ]
            );
            if (Array.isArray(p.sessions)) {
              for (const s of p.sessions) {
                if (!s || typeof s.id !== 'string') continue;
                await client.query(
                  `INSERT INTO lab_sessions (id, project_id, title, messages, created_at, updated_at)
                   VALUES ($1, $2, $3, $4, $5, $6)
                   ON CONFLICT (id) DO UPDATE SET
                     title = EXCLUDED.title,
                     messages = EXCLUDED.messages,
                     updated_at = EXCLUDED.updated_at;`,
                  [
                    s.id,
                    p.id,
                    String(s.title || '').slice(0, 128),
                    JSON.stringify(Array.isArray(s.messages) ? s.messages : []),
                    Number(s.createdAt) || Date.now(),
                    Number(s.updatedAt) || Date.now(),
                  ]
                );
              }
            }
          }
        }

        const annotations = body?.annotations?.sessions;
        if (annotations && typeof annotations === 'object') {
          for (const [sessionId, ann] of Object.entries(annotations)) {
            if (!ann || typeof ann !== 'object') continue;
            await client.query(
              `INSERT INTO lab_annotations (session_id, tags, notes, runs, wiki_path, wiki_synced_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (session_id) DO UPDATE SET
                 tags = EXCLUDED.tags,
                 notes = EXCLUDED.notes,
                 runs = EXCLUDED.runs,
                 updated_at = EXCLUDED.updated_at;`,
              [
                sessionId,
                JSON.stringify(Array.isArray(ann.tags) ? ann.tags : []),
                String(ann.notes || '').slice(0, 12000),
                JSON.stringify(ann.runs || {}),
                ann.wikiPath || null,
                ann.wikiSyncedAt ? new Date(ann.wikiSyncedAt) : null,
                Number(ann.updatedAt) || Date.now(),
              ]
            );
          }
        }
        await client.query('COMMIT');
        sendJson(response, 200, { status: 'ok', syncedAt: Date.now() });
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (error.code === '42P01') {
          sendJson(response, 503, { error: '数据库表尚未初始化，请先执行 DDL' });
          return;
        }
        sendJson(response, 500, { error: `同步失败：${error.message || '未知错误'}` });
      } finally {
        client.release();
      }
      return;
    }

    if (pathname === '/api/lab/promote-to-wiki' && request.method === 'POST') {
      if (!databasePool) {
        sendJson(response, 503, { error: '数据库未连接' });
        return;
      }
      let body;
      try {
        body = JSON.parse(await readBody(request));
      } catch {
        sendJson(response, 400, { error: '无效的 JSON 请求体' });
        return;
      }

      const { sessionId, title, category = '实验记录', tags = [] } = body || {};
      if (!sessionId || typeof sessionId !== 'string') {
        sendJson(response, 400, { error: '缺少有效的 sessionId' });
        return;
      }
      if (!title || typeof title !== 'string') {
        sendJson(response, 400, { error: '缺少有效的标题' });
        return;
      }

      try {
        const sessionRes = await databasePool.query(
          'SELECT id, title, messages FROM lab_sessions WHERE id = $1',
          [sessionId]
        );
        if (sessionRes.rows.length === 0) {
          sendJson(response, 404, { error: '未找到该实验会话' });
          return;
        }
        const session = sessionRes.rows[0];

        const annRes = await databasePool.query(
          'SELECT tags, notes, runs FROM lab_annotations WHERE session_id = $1',
          [sessionId]
        );
        const ann = annRes.rows[0] || {};
        const effectiveTags = Array.isArray(tags) && tags.length > 0 ? tags : (ann.tags || []);
        const notes = ann.notes || '';
        const content = formatWikiContent({
          title,
          sessionId,
          category,
          tags: effectiveTags,
          notes,
          messages: session.messages || [],
          runs: ann.runs || {},
        });
        const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
        const lineCount = content.split('\n').length;
        const summary = notes.slice(0, 200).replace(/\n/g, ' ') || `${title} 实验记录`;
        const cleanId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
        const wikiPath = `entities/experiment-${cleanId}.md`;

        await databasePool.query(
          `INSERT INTO wiki_pages (path, title, category, type, tags, summary, content, sha256, line_count, outbound_links, created_at, updated_at)
           VALUES ($1, $2, $3, 'note', $4, $5, $6, $7, $8, '[]'::jsonb, NOW(), NOW())
           ON CONFLICT (path) DO UPDATE SET
             title = EXCLUDED.title,
             category = EXCLUDED.category,
             tags = EXCLUDED.tags,
             summary = EXCLUDED.summary,
             content = EXCLUDED.content,
             sha256 = EXCLUDED.sha256,
             line_count = EXCLUDED.line_count,
             updated_at = NOW();`,
          [wikiPath, title, category, JSON.stringify(effectiveTags), summary, content, sha256, lineCount]
        );

        await databasePool.query(
          'UPDATE lab_annotations SET wiki_path = $1, wiki_synced_at = NOW() WHERE session_id = $2',
          [wikiPath, sessionId]
        );

        sendJson(response, 200, {
          status: 'ok',
          wikiPath,
          title,
          category,
        });
      } catch (error) {
        if (error.code === '42P01') {
          sendJson(response, 503, { error: '数据库表尚未初始化，请先执行 DDL' });
          return;
        }
        sendJson(response, 500, { error: `沉淀至 Wiki 失败：${error.message || '未知错误'}` });
      }
      return;
    }

    if (pathname === '/api/chat') {
      if (request.method === 'POST') {
        const now = Date.now();
        if (now - chatWindowStartedAt >= chatRateLimit.windowMs) {
          chatWindowStartedAt = now;
          chatRequestCount = 0;
        }
        if (chatRequestCount >= chatRateLimit.maxRequests) {
          const retryAfter = Math.max(1, Math.ceil((chatRateLimit.windowMs - (now - chatWindowStartedAt)) / 1000));
          response.setHeader('Retry-After', String(retryAfter));
          sendJson(response, 429, { error: '请求过于频繁，请稍后再试' });
          return;
        }
        chatRequestCount += 1;
      }

      const abortController = new AbortController();
      const abortIfDisconnected = () => {
        if (!response.writableEnded) abortController.abort();
      };
      request.once('aborted', abortIfDisconnected);
      response.once('close', abortIfDisconnected);

      try {
        const body = ['GET', 'HEAD', 'OPTIONS'].includes(request.method)
          ? undefined
          : await readBody(request);
        const webRequest = createChatRequest(request, body, abortController.signal);
        const webResponse = await handleChatRequest({ request: webRequest, env: environment });
        await streamResponse(webResponse, response);
      } catch (error) {
        if (response.destroyed || response.writableEnded) return;
        sendJson(response, error.statusCode || 500, {
          error: error.statusCode === 413 ? '请求体过大' : '服务暂不可用',
        });
      } finally {
        request.removeListener('aborted', abortIfDisconnected);
        response.removeListener('close', abortIfDisconnected);
      }
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { error: '仅支持 GET 或 HEAD' });
      return;
    }

    await serveStatic(request, response, staticDirectory);
  });
}

async function createDatabasePool(environment) {
  const { INSTANCE_CONNECTION_NAME, DB_NAME, DB_USER } = environment;
  if (!INSTANCE_CONNECTION_NAME && !DB_NAME && !DB_USER) return { pool: null, connector: null };
  if (!INSTANCE_CONNECTION_NAME || !DB_NAME || !DB_USER) {
    throw new Error('Cloud SQL 配置不完整');
  }

  const connector = new Connector();
  const options = await connector.getOptions({
    instanceConnectionName: INSTANCE_CONNECTION_NAME,
    authType: 'IAM',
  });
  const pool = new Pool({
    ...options,
    database: DB_NAME,
    user: DB_USER,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
  });

  try {
    const result = await pool.query('SELECT current_database() AS name');
    if (result.rows[0]?.name !== DB_NAME) throw new Error('Cloud SQL 数据库不匹配');
  } catch (error) {
    await pool.end();
    connector.close();
    throw error;
  }

  return { pool, connector };
}

export async function ensureTables(pool) {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lab_projects (
          id VARCHAR(64) PRIMARY KEY,
          name VARCHAR(128) NOT NULL,
          system_prompt JSONB DEFAULT '{"enabled": false, "text": "", "presetId": null}'::JSONB,
          active_session_id VARCHAR(64),
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lab_projects_updated_at ON lab_projects(updated_at DESC);

      CREATE TABLE IF NOT EXISTS lab_sessions (
          id VARCHAR(64) PRIMARY KEY,
          project_id VARCHAR(64) NOT NULL REFERENCES lab_projects(id) ON DELETE CASCADE,
          title VARCHAR(128) NOT NULL,
          messages JSONB DEFAULT '[]'::JSONB,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lab_sessions_project ON lab_sessions(project_id);
      CREATE INDEX IF NOT EXISTS idx_lab_sessions_updated_at ON lab_sessions(updated_at DESC);

      CREATE TABLE IF NOT EXISTS lab_annotations (
          session_id VARCHAR(64) PRIMARY KEY REFERENCES lab_sessions(id) ON DELETE CASCADE,
          tags JSONB DEFAULT '[]'::JSONB,
          notes TEXT DEFAULT '',
          runs JSONB DEFAULT '{}'::JSONB,
          wiki_path VARCHAR(256),
          wiki_synced_at TIMESTAMP WITH TIME ZONE,
          updated_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lab_annotations_wiki ON lab_annotations(wiki_path);
    `);
    console.log('CYBER//LAB 数据表结构已确认就绪');
  } catch (error) {
    console.warn(`初始化数据表提示：${error.message}`);
  }
}

export async function startServer(environment = process.env) {
  const { pool, connector } = await createDatabasePool(environment);
  if (pool) {
    await ensureTables(pool);
  }
  const server = createHttpServer({ environment, databasePool: pool });
  const port = Number(environment.PORT || 8080);
  server.requestTimeout = 130_000;
  server.headersTimeout = 65_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
  console.log(`CYBER//LAB Cloud Run 服务已启动，监听端口 ${port}`);

  const shutdown = async () => {
    server.close();
    await pool?.end();
    connector?.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}

const scriptPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === scriptPath) {
  startServer().catch((error) => {
    console.error(`CYBER//LAB 启动失败：${error.message}`);
    process.exitCode = 1;
  });
}
