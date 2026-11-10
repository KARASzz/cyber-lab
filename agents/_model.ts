/**
 * AI Gateway 配置解析。
 *
 * 铁律：所有值都来自调用方传入的 context.env（平台运行时注入），
 * 本模块绝不读取 process.env，也不硬编码任何第三方 API Key / 域名。
 * 部署时 CLI 会依据 .env.example 自动注入 AI_GATEWAY_*，无需用户配置。
 */

/** 平台默认模型；允许通过 AI_GATEWAY_MODEL 覆盖 */
export const DEFAULT_MODEL = '@makers/deepseek-v4.1-flash';

export interface GatewayConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** /v1/chat/completions 的完整地址 */
  chatCompletionsUrl: string;
}

export function resolveGateway(
  contextEnv: Record<string, string | undefined> | undefined,
): GatewayConfig {
  const env = contextEnv ?? {};
  const apiKey = String(env.AI_GATEWAY_API_KEY ?? '').trim();
  const rawBase = String(env.AI_GATEWAY_BASE_URL ?? '').trim();

  const missing: string[] = [];
  if (!apiKey) missing.push('AI_GATEWAY_API_KEY');
  if (!rawBase) missing.push('AI_GATEWAY_BASE_URL');
  if (missing.length) {
    throw new Error(
      `缺少平台注入的环境变量：${missing.join('、')}。请确认 .env.example 已声明 AI_GATEWAY_*，且部署时已由平台自动注入（本项目不需要任何第三方 API Key）。`,
    );
  }

  const baseUrl = rawBase.replace(/\/+$/, '');
  // 兼容网关地址本身已带 /v1 的情况
  const chatCompletionsUrl = /\/v1$/i.test(baseUrl)
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/v1/chat/completions`;

  return {
    apiKey,
    baseUrl,
    model: String(env.AI_GATEWAY_MODEL ?? '').trim() || DEFAULT_MODEL,
    chatCompletionsUrl,
  };
}
