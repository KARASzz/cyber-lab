/* 仅测试用 ESM 解析钩子：把 agents/*.ts 内部的无扩展名相对导入解析到 .ts/.js。
 * 生产代码不受影响（EdgeOne Makers 用 tsx/deepagents 自行处理扩展名解析）。 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CANDIDATES = ['.ts', '.js', '.mjs', '/index.ts', '/index.js'];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (!(specifier.startsWith('.') || specifier.startsWith('/')) || !context.parentURL) throw err;
    const base = new URL(specifier, context.parentURL);
    for (const ext of CANDIDATES) {
      const candidate = new URL(base.href + ext);
      let p;
      try { p = fileURLToPath(candidate); } catch { continue; }
      if (existsSync(p)) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
    throw err;
  }
}
