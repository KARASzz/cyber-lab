/**
 * Agent 运行时共享工具：SSE 帧构造、响应头、流式响应封装。
 *
 * 约定：
 *  - 本文件不读取任何全局环境变量；env 由入口从 context.env 取出后作为参数传入业务模块。
 *  - 严格遵循团队约定的对外协议：data: {"delta":"..."} / data: {"error":"..."} / data: [DONE]
 *  - 心跳使用零长度 delta 帧（而非平台默认的 {"type":"ping"}），
 *    这样既保持连接活跃、关闭代理缓冲，又不会污染前端的 data 通道。
 */

export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export const SSE_DONE = 'data: [DONE]\n\n';

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL_ID = /^(?:@?[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function requestIdFrom(value: unknown): string {
  if (typeof value === 'string' && value.trim() === value && REQUEST_ID.test(value)) return value;
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function safeModelHeader(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 128 || value.trim() !== value || !MODEL_ID.test(value)) return null;
  if (value.split('/').some((part) => /^(?:sk[-_]|token[-_]|secret[-_]|api[-_]?key[-_])/i.test(part))) return null;
  return value;
}

/** 构造一帧 SSE data 事件 */
export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 心跳帧：空 delta，前端 appendDelta 会直接跳过，但会重置 stall 计时器 */
export const SSE_HEARTBEAT = sseData({ delta: '' });

export function createGatewaySSEParser(onEvent: (payload: string) => void) {
  const decoder = new TextDecoder();
  let buffer = '';
  let lines: string[] = [];
  let finished = false;

  function flush(): void {
    if (!lines.length || finished) return;
    const payload = lines.join('\n').trim();
    lines = [];
    if (!payload) return;
    if (payload === '[DONE]') { finished = true; return; }
    onEvent(payload);
  }

  function line(value: string): void {
    if (!value) { flush(); return; }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'data') lines.push(content);
  }

  function process(end: boolean): void {
    while (!finished) {
      const index = buffer.search(/[\r\n]/);
      if (index < 0 || (!end && buffer[index] === '\r' && index === buffer.length - 1)) break;
      const length = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
      line(buffer.slice(0, index));
      buffer = buffer.slice(index + length);
    }
    if (end && !finished) {
      if (buffer) line(buffer);
      buffer = '';
      flush();
    }
  }

  return {
    get finished(): boolean { return finished; },
    feed(chunk: Uint8Array): void { if (!finished) { buffer += decoder.decode(chunk, { stream: true }); process(false); } },
    finish(): void { if (!finished) { buffer += decoder.decode(); process(true); } },
  };
}

/** 非流式错误响应（参数校验失败等，HTTP 非 2xx） */
export function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'X-Request-Id, X-AI-Model, X-AI-Route',
      ...extraHeaders,
    },
  });
}

/**
 * 把一个异步生成器包装成 SSE Response。
 *  - 5 秒心跳保活
 *  - 全程监听 signal，客户端断开时静默退出
 *  - 生成器内部异常不会击穿流，会转成 error 帧并正常收尾
 */
export function createSSEResponse(
  generator: (signal?: AbortSignal) => AsyncGenerator<string>,
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {},
): Response {
  const encoder = new TextEncoder();
  const streamAbort = new AbortController();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const abort = (): void => streamAbort.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener?.('abort', abort, { once: true });

  const cleanup = (): void => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    signal?.removeEventListener?.('abort', abort);
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
          abort();
        }
      };
      if (!streamAbort.signal.aborted) {
        heartbeatTimer = setInterval(() => {
          if (!streamAbort.signal.aborted) enqueue(SSE_HEARTBEAT);
        }, 5_000);
      }
      try {
        if (!streamAbort.signal.aborted) {
          for await (const chunk of generator(streamAbort.signal)) {
            if (streamAbort.signal.aborted) break;
            enqueue(chunk);
          }
        }
      } catch (err) {
        const e = err as Error;
        if (!streamAbort.signal.aborted && e?.name !== 'AbortError') {
          enqueue(sseData({ error: '生成失败，请重试' }));
          enqueue(SSE_DONE);
        }
      } finally {
        cleanup();
        if (!closed) {
          closed = true;
          try { controller.close(); } catch { /* 已关闭 */ }
        }
      }
    },
    cancel() {
      closed = true;
      abort();
      cleanup();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { ...SSE_HEADERS, 'Access-Control-Expose-Headers': 'X-Request-Id, X-AI-Model, X-AI-Route', ...extraHeaders },
  });
}
