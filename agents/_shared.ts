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

/** 构造一帧 SSE data 事件 */
export function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 心跳帧：空 delta，前端 appendDelta 会直接跳过，但会重置 stall 计时器 */
export const SSE_HEARTBEAT = sseData({ delta: '' });

/** 非流式错误响应（参数校验失败等，HTTP 非 2xx） */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
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
): Response {
  const encoder = new TextEncoder();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const enqueue = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      heartbeatTimer = setInterval(() => {
        if (!signal?.aborted) enqueue(SSE_HEARTBEAT);
      }, 5_000);

      try {
        for await (const chunk of generator(signal)) {
          if (signal?.aborted) break;
          enqueue(chunk);
        }
      } catch (err) {
        const e = err as Error;
        if (!signal?.aborted && e?.name !== 'AbortError') {
          enqueue(sseData({ error: `生成失败：${e?.message || '未知错误'}` }));
          enqueue(SSE_DONE);
        }
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* 流已关闭 */
          }
        }
      }
    },
    cancel() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
