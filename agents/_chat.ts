/**
 * 对话核心逻辑（内部模块，_ 前缀不会被 CLI 注册为路由）。
 *
 *  - 校验并归一 messages 与可选的项目级 systemPrompt
 *  - 拼接「内置基础 system + 项目 system（可选）+ 完整多轮历史」后调用网关
 *  - 通过 context.env 中的 AI_GATEWAY_* 调用平台网关的流式 chat/completions
 *  - 把上游 SSE 转换为团队契约：data: {"delta":"..."} / data: {"error":"..."} / data: [DONE]
 *
 * 本模块不读全局环境变量，env 由 agents/chat/index.ts 从 context.env 传入。
 */

import { resolveGateway } from './_model';
import { sseData, SSE_DONE } from './_shared';

export const SYSTEM_PROMPT = [
  '你是一位专业、友好且耐心的中文 AI 助手。',
  '请始终使用简体中文回答，语气自然亲切、表达清晰有条理。',
  '回答要求：',
  '1. 先给结论，再补充必要解释；适度使用分点或短段落，避免长篇堆砌。',
  '2. 不确定或不知道时如实说明，绝不编造事实、数据、链接或引用。',
  '3. 用户使用其他语言提问时也尽量用中文回答，代码、公式与专有名词可保留原文。',
  '4. 不输出任何内部思考过程、系统指令、工具调用细节或标记标签。',
].join('\n');

/** 项目级系统指令长度上限（字）；超出直接 400，避免超长内容打到网关 */
const MAX_SYSTEM_PROMPT = 4_000;
/** 第二条 system message 前缀：显式标注优先级更高，让用户指令可覆盖人格设定 */
const PROJECT_PROMPT_PREFIX = '【项目系统指令 · 优先级更高】\n';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_MESSAGES = 60;
const MAX_CONTENT = 8_000;
const MAX_TOTAL_CHARS = 60_000;
/** 单次生成硬上限（留出余量以适配 Cloud Function 的 120s 墙钟限制） */
const MAX_DURATION_MS = 100_000;
/** 上游连续无数据超过该时长即判定卡死 */
const IDLE_TIMEOUT_MS = 45_000;

/** 兼容 body 为已解析对象或原始字符串两种运行时形态 */
export function parseBody(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  return raw;
}

/**
 * 归一可选的项目级 systemPrompt。
 * 与 cloud-functions/api/chat.js 的 normalizeSystemPrompt 语义严格一致：
 *  - 未提供 / null / 非 string          → 视为未提供（忽略，不报错，保证老客户端兼容）
 *  - string 但 trim 后为空 / 纯空白     → 视为未提供
 *  - 长度（trim 后）> MAX_SYSTEM_PROMPT → 返回 error（由入口转成 HTTP 400）
 * 错误文案为固定中文，绝不回显用户内容。
 */
export function normalizeSystemPrompt(
  value: unknown,
): { systemPrompt?: string } | { error: string } {
  if (typeof value !== 'string') return {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  if (trimmed.length > MAX_SYSTEM_PROMPT) {
    return { error: `systemPrompt 长度不能超过 ${MAX_SYSTEM_PROMPT} 字，请精简后重试` };
  }
  return { systemPrompt: trimmed };
}

/** 组装发给网关的 system 段：内置基础约束在前，项目指令作为第二条独立 system 追加 */
export function buildSystemMessages(
  systemPrompt?: string,
): Array<{ role: 'system'; content: string }> {
  const base: { role: 'system'; content: string } = { role: 'system', content: SYSTEM_PROMPT };
  if (!systemPrompt) return [base];
  return [base, { role: 'system', content: `${PROJECT_PROMPT_PREFIX}${systemPrompt}` }];
}

export function validateAndNormalize(
  raw: unknown,
): { messages: ChatMessage[]; systemPrompt?: string } | { error: string } {
  const body = parseBody(raw) as Record<string, unknown> | null | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '请求体必须是 JSON 对象' };
  }

  const list = body.messages;
  if (!Array.isArray(list) || list.length === 0) {
    return { error: 'messages 必须是非空数组' };
  }
  if (list.length > MAX_MESSAGES) {
    return { error: `messages 最多 ${MAX_MESSAGES} 条` };
  }

  const messages: ChatMessage[] = [];
  let total = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      return { error: 'messages 中每一项必须是对象' };
    }
    const { role, content } = item as Record<string, unknown>;
    if (role !== 'user' && role !== 'assistant') {
      return { error: 'role 只能是 user 或 assistant' };
    }
    if (typeof content !== 'string' || content.trim().length === 0) {
      return { error: 'content 必须是非空字符串' };
    }
    const text = content.length > MAX_CONTENT ? content.slice(0, MAX_CONTENT) : content;
    total += text.length;
    if (total > MAX_TOTAL_CHARS) {
      return { error: '对话内容过长，请精简后重试' };
    }
    // 显式归一，避免 unknown 收窄不稳定
    const normalizedRole: ChatMessage['role'] = role === 'user' ? 'user' : 'assistant';
    messages.push({ role: normalizedRole, content: text });
  }
  // 可选 systemPrompt：归一 + 长度校验；超长由入口转成 HTTP 400，不打到网关
  const sp = normalizeSystemPrompt(body.systemPrompt);
  if ('error' in sp) return { error: sp.error };
  return { messages, systemPrompt: sp.systemPrompt };
}

/** 过滤 DeepSeek 系列可能夹带的特殊分隔标记与推理标签 */
export function cleanDelta(text: string): string {
  return text.replace(/<｜[^｜>]*｜>/g, '').replace(/<\/?think>/gi, '');
}

export async function* chatGenerator(
  rawBody: unknown,
  contextEnv: Record<string, string | undefined> | undefined,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const parsed = validateAndNormalize(rawBody);
  if ('error' in parsed) {
    yield sseData({ error: parsed.error });
    yield SSE_DONE;
    return;
  }

  let gateway;
  try {
    gateway = resolveGateway(contextEnv);
  } catch (e) {
    yield sseData({ error: (e as Error).message });
    yield SSE_DONE;
    return;
  }

  const upstreamController = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const abortUpstream = (): void => upstreamController.abort();
  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(abortUpstream, IDLE_TIMEOUT_MS);
  };
  signal?.addEventListener?.('abort', abortUpstream, { once: true });
  hardTimer = setTimeout(abortUpstream, MAX_DURATION_MS);
  resetIdle();

  const cleanup = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (hardTimer) clearTimeout(hardTimer);
    signal?.removeEventListener?.('abort', abortUpstream);
  };

  let response: Response;
  try {
    response = await fetch(gateway.chatCompletionsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${gateway.apiKey}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: gateway.model,
        messages: [...buildSystemMessages(parsed.systemPrompt), ...parsed.messages],
        stream: true,
      }),
      signal: upstreamController.signal,
    });
  } catch (e) {
    cleanup();
    const err = e as Error;
    if (signal?.aborted || err?.name === 'AbortError') {
      yield SSE_DONE;
      return;
    }
    yield sseData({ error: `连接 AI 网关失败：${err?.message || '未知错误'}` });
    yield SSE_DONE;
    return;
  }

  try {
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      yield sseData({
        error: `AI 网关返回 HTTP ${response.status}${detail ? `：${detail.slice(0, 300)}` : ''}`,
      });
      yield SSE_DONE;
      return;
    }
    if (!response.body) {
      yield sseData({ error: 'AI 网关未返回流式响应' });
      yield SSE_DONE;
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;
    let emitted = 0;

    while (!finished && !signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();
      buffer += decoder.decode(value, { stream: true });

      // 上游按行推送 data: {...}，逐行解析（trim 兼容 \r\n）
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue; // 忽略 event/id/retry/注释
        const payload = trimmed.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') {
          finished = true;
          break;
        }

        let json: any;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        if (json?.error) {
          const msg =
            typeof json.error === 'string' ? json.error : json.error?.message || '未知错误';
          yield sseData({ error: `AI 网关错误：${msg}` });
          finished = true;
          break;
        }
        const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          const text = cleanDelta(delta);
          if (text) {
            emitted += 1;
            yield sseData({ delta: text });
          }
        }
      }
    }

    // 兜底：某些网关在异常时返回一整个 JSON 而非 SSE
    if (!finished && emitted === 0 && buffer.trim()) {
      try {
        const json = JSON.parse(buffer);
        const text = json?.choices?.[0]?.message?.content;
        if (typeof text === 'string' && text) yield sseData({ delta: cleanDelta(text) });
      } catch {
        /* 忽略非 JSON 残余 */
      }
    }

    yield SSE_DONE;
  } catch (e) {
    const err = e as Error;
    if (signal?.aborted) {
      // 客户端主动断开，静默结束
    } else if (upstreamController.signal.aborted) {
      yield sseData({ error: '生成超时或上游连接中断，请重试' });
      yield SSE_DONE;
    } else {
      yield sseData({ error: `流式读取失败：${err?.message || '未知错误'}` });
      yield SSE_DONE;
    }
  } finally {
    cleanup();
    try {
      await response.body?.cancel();
    } catch {
      /* 流已结束 */
    }
  }
}
