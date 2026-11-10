/**
 * 平台 Agent 端点：POST /chat
 *
 * 由 Makers Agent 运行时自动扫描注册（agents/<name>/index.ts → POST /<name>），
 * 无需手写 .edgeone/agent-node/config.json。
 *
 * 真正的模型推理走平台自动注入的 AI Gateway（context.env.AI_GATEWAY_*），
 * 不含任何第三方 SDK / API Key，也不读取 process.env。
 *
 * 对外稳定契约入口是 POST /api/chat（cloud-functions/api/chat.js 薄代理），
 * 该代理会把请求转发到本端点；本端点也可被直接调用，便于联调。
 */

import { chatGenerator, validateAndNormalize } from '../_chat';
import { createSSEResponse, jsonResponse } from '../_shared';

export async function onRequest(context: any): Promise<Response> {
  const rawBody = context?.request?.body ?? {};
  const signal = context?.request?.signal as AbortSignal | undefined;
  // ⭐ 环境变量只能从 context.env 读取，禁止 process.env
  const env = (context?.env ?? {}) as Record<string, string | undefined>;

  // 参数校验前置：HTTP 400 + JSON（契约允许用非 2xx 表示错误）
  const check = validateAndNormalize(rawBody);
  if ('error' in check) {
    return jsonResponse({ error: check.error }, 400);
  }

  return createSSEResponse((sig) => chatGenerator(rawBody, env, sig), signal);
}
