/* 仅测试用：注册 ESM 解析钩子，让 agents/*.ts 内部的无扩展名相对导入可被解析。
 * 用法：node --import ./tests/support/register.mjs --experimental-strip-types --test ...
 * 生产代码不受影响。 */
import { register } from 'node:module';

register('./ts-resolve-hook.mjs', import.meta.url);
