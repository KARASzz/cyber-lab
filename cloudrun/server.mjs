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

export async function startServer(environment = process.env) {
  const { pool, connector } = await createDatabasePool(environment);
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
