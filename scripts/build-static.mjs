import { cp, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(projectRoot, 'dist');

async function rejectSymlinks(sourcePath) {
  const info = await lstat(sourcePath);
  if (info.isSymbolicLink()) {
    throw new Error(`静态资源不允许符号链接：${path.relative(projectRoot, sourcePath)}`);
  }
  if (!info.isDirectory()) return;
  for (const entry of await readdir(sourcePath)) {
    await rejectSymlinks(path.join(sourcePath, entry));
  }
}

for (const file of ['index.html', 'style.css', 'app.js']) {
  await rejectSymlinks(path.join(projectRoot, file));
}
for (const directory of ['scripts/core', 'scripts/ui', 'styles']) {
  await rejectSymlinks(path.join(projectRoot, directory));
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const file of ['index.html', 'style.css', 'app.js']) {
  await cp(path.join(projectRoot, file), path.join(outputDirectory, file));
}

for (const directory of ['scripts/core', 'scripts/ui', 'styles']) {
  await cp(
    path.join(projectRoot, directory),
    path.join(outputDirectory, directory),
    { recursive: true },
  );
}

console.log('CYBER//LAB 静态文件已构建到 dist/');
