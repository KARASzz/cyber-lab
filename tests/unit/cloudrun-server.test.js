import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createHttpServer } from '../../cloudrun/server.mjs';

test('Cloud Run HTTP server serves the static allowlist and chat contract', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cyber-lab-static-'));
  const outsideFile = path.join(tmpdir(), `${path.basename(root)}-outside.js`);
  await writeFile(path.join(root, 'index.html'), '<main>CYBER//LAB</main>');
  await writeFile(path.join(root, '.env'), 'PRIVATE=hidden');
  await writeFile(outsideFile, 'outside static root');
  await mkdir(path.join(root, 'scripts/core'), { recursive: true });
  await symlink(outsideFile, path.join(root, 'scripts/core/leak.js'));
  const server = createHttpServer({
    environment: {},
    staticDirectory: root,
    chatRateLimit: { windowMs: 60_000, maxRequests: 1 },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /CYBER\/\/LAB/);

    const privateFile = await fetch(`${baseUrl}/.env`);
    assert.equal(privateFile.status, 404);

    const symlinkedFile = await fetch(`${baseUrl}/scripts/core/leak.js`);
    assert.equal(symlinkedFile.status, 404);

    const health = await fetch(`${baseUrl}/api/health`);
    assert.deepEqual(await health.json(), { status: 'ok', database: 'not-configured' });

    const invalidChat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(invalidChat.status, 400);
    assert.equal(typeof (await invalidChat.json()).error, 'string');

    const limitedChat = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(limitedChat.status, 429);
    assert.equal(limitedChat.headers.get('retry-after'), '60');
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(root, { recursive: true, force: true });
    await rm(outsideFile, { force: true });
  }
});
