import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startStaticServer } from '../support/static-server.mjs';

test('测试服务器只提供所需前端资源，不暴露隐藏文件或根目录外的符号链接', async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), 'cyber-lab-server-test-'));
  t.after(async () => { await rm(sandbox, { recursive: true, force: true }); });
  const root = join(sandbox, 'site');
  await mkdir(join(root, 'scripts', 'core'), { recursive: true });
  await mkdir(join(root, 'styles'), { recursive: true });
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<main>fixture</main>');
  await writeFile(join(root, 'app.js'), 'export const fixture = true;');
  await writeFile(join(root, 'style.css'), 'body { color: red; }');
  await writeFile(join(root, 'scripts', 'core', 'example.js'), 'export default 1;');
  await writeFile(join(root, 'styles', 'lab.css'), 'main { color: green; }');
  await writeFile(join(root, '.env'), 'synthetic-secret');
  await writeFile(join(root, '.git', 'HEAD'), 'synthetic-git-data');
  await writeFile(join(root, 'notes.txt'), 'not a frontend resource');
  const outside = join(sandbox, 'outside.js');
  await writeFile(outside, 'synthetic-outside-data');
  await symlink(outside, join(root, 'scripts', 'core', 'external.js'));

  const server = await startStaticServer({ root });
  t.after(server.close);
  for (const path of ['/', '/app.js', '/style.css', '/scripts/core/example.js', '/styles/lab.css']) {
    const response = await fetch(server.url + path);
    assert.equal(response.status, 200, path);
  }
  for (const path of ['/.env', '/.git/HEAD', '/notes.txt', '/scripts/core/external.js']) {
    const response = await fetch(server.url + path);
    assert.equal(response.status, 404, path);
    assert.ok(!(await response.text()).includes('synthetic-'), path);
  }
});
