/* 仅测试用的极简静态文件服务器。
 * 只负责按扩展名把项目根目录下的静态文件通过 http 提供给 Playwright 加载；
 * 不包含任何生产逻辑，也不处理 /api/chat（聊天接口由 Playwright route mock 拦截）。
 * 端口 0 表示由系统分配空闲端口，通过返回的 server.address().port 读取。 */

import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * 启动静态服务器。
 * @param {object} [options]
 * @param {string} [options.root] 要服务的根目录，默认为本文件所在仓库根目录
 * @param {number} [options.port] 监听端口，默认 0（系统分配）
 * @returns {Promise<{ url: string, close: () => Promise<void>, server: import('node:http').Server }>}
 */
export async function startStaticServer(options = {}) {
  const here = fileURLToPath(import.meta.url);
  // tests/support/static-server.mjs → 上溯三级到仓库根目录
  const repoRoot = resolve(here, '..', '..', '..');
  const root = await realpath(options.root ? resolve(options.root) : repoRoot);
  const port = options.port ?? 0;

  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let rel = normalize(urlPath).replace(/^([/\\])+/, '');
      if (rel === '' || rel === '.') rel = 'index.html';

      const isRootAsset = ['index.html', 'app.js', 'style.css'].includes(rel);
      const isModule = /^scripts\/(?:[\w-]+\/)*[\w-]+\.js$/.test(rel);
      const isStyle = /^styles\/(?:[\w-]+\/)*[\w-]+\.css$/.test(rel);
      if (!isRootAsset && !isModule && !isStyle) throw new Error('Not found');

      const target = await realpath(join(root, rel));
      if (!target.startsWith(root + sep) || !(await stat(target)).isFile()) {
        throw new Error('Not found');
      }
      const body = await readFile(target);
      const type = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    server,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

// 允许以 `node tests/support/static-server.mjs [port]` 直接运行，便于本地手动预览测试环境
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || 0);
  startStaticServer({ port }).then(({ url }) => {
    process.stdout.write(`static server listening on ${url}\n`);
  });
}
