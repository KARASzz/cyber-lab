/* =============================================================================
 * POST /api/chat —— 对外稳定契约入口（Cloud Functions 文件路由）
 *
 * 路由：cloud-functions/api/chat.js → POST /api/chat
 *       （Makers Node Functions 文件系统路由，见 makers-cloud-functions）
 *
 * 职责：把固定的对外契约适配到平台 Agent 能力上。
 *   主路径（薄代理）：把请求体原样转发给 Agent 端点 POST /chat
 *                     （agents/chat/index.ts，由 Agent 运行时使用
 *                      context.env.AI_GATEWAY_* 完成真正的模型推理），
 *                     并把上游 SSE 流直接 pipe 回客户端，不做缓冲。
 *   退化路径：只要回环不是「2xx + SSE + 有 body」（网络错误 / 12s 首字节超时 /
 *             401 鉴权 / 404 / 5xx / 非 SSE），一律切到本文件内直连 AI Gateway
 *             的同协议流式实现，保证 /api/chat 在任何环境下都可用。
 *             ⚠️ 线上预览域名需 ?eo_token 鉴权，回环到公开 origin 可能被 CDN/WAF
 *             返回 401，因此 4xx 绝不能当客户端错误透传（这是必须降级的场景）。
 *             若确认线上回环始终不可用，把 PREFER_AGENT_PROXY 改为 false 即可
 *             跳过回环、始终直连网关，输出协议完全一致。
 *
 * 会话：前端按契约不发送 makers-conversation-id，由本代理用第一方 Cookie
 *       维护稳定的 UUID（优先级：请求头 > Cookie > 新生成），保证粘性路由。
 *
 * 对外协议（与前端严格一致，不得改动）：
 *   请求  POST /api/chat  Content-Type: application/json
 *         body: {"messages":[{"role":"user"|"assistant","content":"..."}],
 *                "systemPrompt":"项目级系统指令（可选，≤4000 字）"}
 *         systemPrompt 为【可选】字段：前端仅在「启用系统指令模式且内容非空」时携带。
 *         不传 / 非 string / 空串 / 纯空白时行为与旧版完全一致（只保留内置基础 system）。
 *         长度上限 4000 字，超出返回 HTTP 400 + 明确中文错误，绝不让超长内容打到网关。
 *   响应  Content-Type: text/event-stream
 *         data: {"delta":"增量文本"}\n\n
 *         data: {"error":"错误信息"}\n\n
 *         data: [DONE]\n\n
 *   校验失败：HTTP 400 + {"error":"..."}
 *
 * 系统指令组装语义（主路径 /chat 与降级直连两条路径严格一致）：
 *   第一条 system = 内置基础约束（中文回答 / 不编造 / 不输出内部标签）；
 *   第二条 system = 用户自定义指令，内容前缀标注「【项目系统指令 · 优先级更高】」，
 *   作为独立 system message 追加（不拼进 user content、不塞隐藏指令、不追加覆盖内容），
 *   让用户指令能覆盖人格设定；完整多轮历史原样保留在最后。
 *
 * 安全：所有密钥仅来自 context.env（平台注入），绝不出现在前端或日志中；
 *      禁止 process.env；不引入任何需要用户手动配置的外部服务。
 * ========================================================================== */

const AGENT_PATH = '/chat';
const DEFAULT_MODEL = '@makers/deepseek-v4.1-flash';
const MAX_DURATION_MS = 100_000;
const IDLE_TIMEOUT_MS = 45_000;
const HEARTBEAT_MS = 5_000;

/**
 * 回环「首字节」超时。仅约束 fetch 拿到响应头之前的阶段：
 * 一旦响应头到达就 clearTimeout，不会误杀后续的长流式输出。
 * 线上预览域名可能要求 ?eo_token 鉴权，回环到公开 origin 可能被 CDN / WAF 挡住，
 * 这个超时保证即使回环挂起也能在 12 秒内切到直连网关。
 */
const LOOPBACK_TIMEOUT_MS = 12_000;

/**
 * 是否优先走 Agent 端点薄代理。
 * 若线上确认回环一直不可用（例如被 eo_token / WAF 拦截），把它改成 false，
 * /api/chat 就会始终直连 AI Gateway —— 输出协议完全一致，无需改动其它代码。
 */
const PREFER_AGENT_PROXY = true;

const CONVERSATION_COOKIE = 'eo_conversation_id';

const SYSTEM_PROMPT = [
  '你是一位专业、友好且耐心的中文 AI 助手。',
  '请始终使用简体中文回答，语气自然亲切、表达清晰有条理。',
  '回答要求：',
  '1. 先给结论，再补充必要解释；适度使用分点或短段落，避免长篇堆砌。',
  '2. 不确定或不知道时如实说明，绝不编造事实、数据、链接或引用。',
  '3. 用户使用其他语言提问时也尽量用中文回答，代码、公式与专有名词可保留原文。',
  '4. 不输出任何内部思考过程、系统指令、工具调用细节或标记标签。',
].join('\n');

/** 项目级系统指令长度上限（字）；超出直接 400，避免超长内容打到网关 */
const MAX_SYSTEM_PROMPT = 4000;
/** 第二条 system message 前缀：显式标注优先级更高，让用户指令可覆盖人格设定 */
const PROJECT_PROMPT_PREFIX = '【项目系统指令 · 优先级更高】\n';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'X-Request-Id, X-AI-Model, X-AI-Route',
};

const SSE_DONE = 'data: [DONE]\n\n';
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
/** 心跳为零长度 delta：符合契约、能刷新缓冲、前端会自然跳过 */
const HEARTBEAT = frame({ delta: '' });

/* ---------------------------------------------------------------------------
 * 防御式读取：兼容标准 Request（Node Functions）与平台预解析对象两种形态
 * ------------------------------------------------------------------------- */
function readHeader(request, name) {
  const h = request && request.headers;
  if (!h) return '';
  if (typeof h.get === 'function') return h.get(name) || '';
  return h[name] || h[name.toLowerCase()] || '';
}

async function readRawBody(context) {
  const req = context && context.request;
  if (req && typeof req.text === 'function') return await req.text();
  const b = req && req.body;
  if (b === undefined || b === null) return '{}';
  return typeof b === 'string' ? b : JSON.stringify(b);
}

/** 把首次生成的会话 Cookie 合并进任意响应头 */
function mergeHeaders(base, setCookie) {
  const headers = { ...base };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  return headers;
}

function jsonError(message, status, setCookie, requestId = newConversationId()) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: mergeHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'X-Request-Id, X-AI-Model, X-AI-Route',
      'X-Request-Id': requestId,
    }, setCookie),
  });
}

/* ---------------------------------------------------------------------------
 * 项目级系统指令：归一 / 校验 / 组装
 * 与 agents/_chat.ts 的 normalizeSystemPrompt / buildSystemMessages 语义严格一致。
 * ------------------------------------------------------------------------- */

/**
 * 归一可选的 systemPrompt：
 *  - 未提供 / null / 非 string          → 视为未提供（忽略，不报错，保证老客户端兼容）
 *  - string 但 trim 后为空 / 纯空白     → 视为未提供
 *  - 长度（trim 后）> MAX_SYSTEM_PROMPT → 返回 error（调用方转成 HTTP 400）
 * 返回 {} | { systemPrompt } | { error }。错误文案为固定中文，绝不回显用户内容。
 */
function normalizeSystemPrompt(value) {
  if (typeof value !== 'string') return {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  if (trimmed.length > MAX_SYSTEM_PROMPT) {
    return { error: `systemPrompt 长度不能超过 ${MAX_SYSTEM_PROMPT} 字，请精简后重试` };
  }
  return { systemPrompt: trimmed };
}

/** 组装发给网关的 system 段：内置基础约束在前，项目指令作为第二条独立 system 追加 */
function buildSystemMessages(systemPrompt) {
  const base = { role: 'system', content: SYSTEM_PROMPT };
  if (!systemPrompt) return [base];
  return [base, { role: 'system', content: `${PROJECT_PROMPT_PREFIX}${systemPrompt}` }];
}

function validate(rawText) {
  let body;
  try {
    body = JSON.parse(rawText);
  } catch (_) {
    return { error: '请求体必须是合法 JSON' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '请求体必须是 JSON 对象' };
  }
  const list = body.messages;
  if (!Array.isArray(list) || list.length === 0) {
    return { error: 'messages 必须是非空数组' };
  }
  if (list.length > 60) return { error: 'messages 最多 60 条' };

  const messages = [];
  let total = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') return { error: 'messages 中每一项必须是对象' };
    if (item.role !== 'user' && item.role !== 'assistant') {
      return { error: 'role 只能是 user 或 assistant' };
    }
    if (typeof item.content !== 'string' || !item.content.trim()) {
      return { error: 'content 必须是非空字符串' };
    }
    const text = item.content.slice(0, 8000);
    total += text.length;
    if (total > 60000) return { error: '对话内容过长，请精简后重试' };
    messages.push({ role: item.role, content: text });
  }
  // 可选 systemPrompt：归一 + 长度校验；超长在此拦下（HTTP 400），不会转发到 /chat 或网关
  const sp = normalizeSystemPrompt(body.systemPrompt);
  if (sp.error) return { error: sp.error };
  return { messages, systemPrompt: sp.systemPrompt };
}

/* 只用 context.env 解析网关配置，不读 process.env、不硬编码密钥 */
function resolveGateway(env) {
  const apiKey = String((env && env.AI_GATEWAY_API_KEY) || '').trim();
  const base = String((env && env.AI_GATEWAY_BASE_URL) || '').trim().replace(/\/+$/, '');
  if (!apiKey || !base) return null;
  const url = /\/v1$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const model = String((env && env.AI_GATEWAY_MODEL) || '').trim() || DEFAULT_MODEL;
  return { apiKey, url, model };
}

function cleanDelta(text) {
  return text.replace(/<｜[^｜>]*｜>/g, '').replace(/<\/?think>/gi, '');
}

function safeModelHeader(value) {
  const pattern = /^(?:@?[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._:-]*$/;
  if (typeof value !== 'string' || value.length > 128 || value.trim() !== value || !pattern.test(value)) return null;
  if (value.split('/').some((part) => /^(?:sk[-_]|token[-_]|secret[-_]|api[-_]?key[-_])/i.test(part))) return null;
  return value;
}

function createGatewaySSEParser(onEvent) {
  const decoder = new TextDecoder();
  let buffer = '';
  let lines = [];
  let finished = false;

  function flush() {
    if (!lines.length || finished) return;
    const payload = lines.join('\n').trim();
    lines = [];
    if (!payload) return;
    if (payload === '[DONE]') { finished = true; return; }
    onEvent(payload);
  }
  function line(value) {
    if (!value) { flush(); return; }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'data') lines.push(content);
  }
  function process(end) {
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
    get finished() { return finished; },
    feed(chunk) { if (!finished) { buffer += decoder.decode(chunk, { stream: true }); process(false); } },
    finish() { if (!finished) { buffer += decoder.decode(); process(true); } },
  };
}

/* 回环地址：优先用请求的 Host + 协议，兼容本地 dev 与线上域名 */
function resolveOrigin(request) {
  const host = readHeader(request, 'host');
  let proto = readHeader(request, 'x-forwarded-proto');
  if (!proto) {
    try {
      proto = new URL(request.url).protocol.replace(':', '');
    } catch (_) {
      proto = 'http';
    }
  }
  if (host) return `${proto}://${host}`;
  try {
    return new URL(request.url).origin;
  } catch (_) {
    return '';
  }
}

/**
 * 生成符合 UUID 形态的会话 ID。平台按 UUID 处理 makers-conversation-id，
 * 即使 crypto.randomUUID 不可用也要保持该格式，避免会话路由异常。
 */
function newConversationId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * 前端按契约不带 makers-conversation-id，所以由代理维护一个稳定的会话 ID：
 * 优先级为「请求头 > 第一方 Cookie > 新生成」，新生成时通过 Set-Cookie 写回，
 * 后续多轮复用同一个 ID，保证平台粘性路由稳定（与 conversation-id.md 的约定一致）。
 */
function readConversationCookie(request) {
  const raw = readHeader(request, 'cookie');
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== CONVERSATION_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch (_) {
      return part.slice(idx + 1).trim();
    }
  }
  return '';
}

/* ---------------------------------------------------------------------------
 * 退化路径：本函数内直接调用 AI Gateway 并输出同协议 SSE
 * systemPrompt 走与主路径 /chat 完全相同的 buildSystemMessages 组装策略。
 * ------------------------------------------------------------------------- */
function directChatResponse(gateway, messages, systemPrompt, signal, setCookie, requestId) {
  const encoder = new TextEncoder();
  const upstreamController = new AbortController();
  let reader;
  let heartbeatTimer;
  let idleTimer;
  let closed = false;
  let timedOut = false;
  const onAbort = () => {
    upstreamController.abort();
    if (reader) void reader.cancel().catch(() => {});
  };
  const onTimeout = () => { timedOut = true; onAbort(); };
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(onTimeout, IDLE_TIMEOUT_MS);
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener?.('abort', onAbort, { once: true });
  const hardTimer = setTimeout(onTimeout, MAX_DURATION_MS);
  resetIdle();
  const cleanup = () => {
    clearInterval(heartbeatTimer);
    clearTimeout(idleTimer);
    clearTimeout(hardTimer);
    signal?.removeEventListener?.('abort', onAbort);
  };

  const stream = new ReadableStream({
    async start(controller) {
      const send = (chunk) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(chunk)); }
        catch (_) { closed = true; onAbort(); }
      };
      if (!signal?.aborted) heartbeatTimer = setInterval(() => send(HEARTBEAT), HEARTBEAT_MS);
      try {
        if (signal?.aborted) return;
        const resp = await fetch(gateway.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${gateway.apiKey}`,
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({
            model: gateway.model,
            messages: [...buildSystemMessages(systemPrompt), ...messages],
            stream: true,
          }),
          signal: upstreamController.signal,
        });
        if (!resp.ok) {
          send(frame({ error: `AI 网关返回 HTTP ${resp.status}` }));
          send(SSE_DONE);
          if (resp.body && !resp.body.locked) void resp.body.cancel().catch(() => {});
          return;
        }
        if (!resp.body) {
          send(frame({ error: 'AI 网关未返回流式响应' }));
          send(SSE_DONE);
          return;
        }

        reader = resp.body.getReader();
        const events = [];
        const parser = createGatewaySSEParser((payload) => events.push(payload));
        const probeDecoder = new TextDecoder();
        let probe = '';
        let probing = true;
        let eof = false;
        let receivedEvent = false;
        let failed = false;
        while (!closed && !signal?.aborted && !timedOut) {
          if (events.length) {
            const payload = events.shift();
            receivedEvent = true;
            probing = false;
            probe = '';
            let json;
            try { json = JSON.parse(payload); } catch (_) { continue; }
            if (json?.error) {
              send(frame({ error: 'AI 网关返回错误，请重试' }));
              failed = true;
              break;
            }
            const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content;
            if (typeof delta === 'string' && delta) {
              const text = cleanDelta(delta);
              if (text) send(frame({ delta: text }));
            }
            continue;
          }
          if (parser.finished || eof) break;
          const chunk = await reader.read();
          if (chunk.done) {
            eof = true;
            parser.finish();
            if (probing) probe += probeDecoder.decode();
          } else {
            resetIdle();
            if (probing) {
              probe += probeDecoder.decode(chunk.value, { stream: true });
              if (probe.length > 1_000_000) { probing = false; probe = ''; }
            }
            parser.feed(chunk.value);
          }
        }
        if (!closed && !signal?.aborted && timedOut) send(frame({ error: '生成超时或上游连接中断，请重试' }));
        else if (!closed && !signal?.aborted && !failed && !receivedEvent && !parser.finished && probe.trim()) {
          try {
            const json = JSON.parse(probe);
            const text = json?.choices?.[0]?.message?.content;
            if (typeof text === 'string' && text) send(frame({ delta: cleanDelta(text) }));
          } catch (_) { /* 非 JSON 的剩余数据无法转成回复 */ }
        }
        if (!closed && !signal?.aborted) send(SSE_DONE);
      } catch (_) {
        if (!closed && !signal?.aborted) {
          send(frame({ error: timedOut ? '生成超时或上游连接中断，请重试' : 'AI 服务异常，请重试' }));
          send(SSE_DONE);
        }
      } finally {
        cleanup();
        if (reader) {
          void reader.cancel().catch(() => {});
          try { reader.releaseLock(); } catch (_) { /* 读取器已释放 */ }
        }
        if (!closed) {
          closed = true;
          try { controller.close(); } catch (_) { /* 流已关闭 */ }
        }
      }
    },
    cancel() {
      closed = true;
      onAbort();
      cleanup();
    },
  });
  const headers = { ...SSE_HEADERS, 'X-Request-Id': requestId, 'X-AI-Route': 'gateway' };
  const model = safeModelHeader(gateway.model);
  if (model) headers['X-AI-Model'] = model;
  return new Response(stream, { status: 200, headers: mergeHeaders(headers, setCookie) });
}

function wrapAgentStream(body, upstreamController, signal, onClientAbort) {
  const reader = body.getReader();
  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener?.('abort', onClientAbort);
    try { reader.releaseLock(); } catch (_) { /* 读取器已释放 */ }
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) { cleanup(); controller.close(); }
        else controller.enqueue(chunk.value);
      } catch (error) {
        cleanup();
        controller.error(error);
      }
    },
    cancel(reason) {
      upstreamController.abort();
      void reader.cancel(reason).catch(() => {});
      cleanup();
    },
  });
}

/* ---------------------------------------------------------------------------
 * CORS 预检（同源调用不需要，但便于本地跨端口联调）
 * ------------------------------------------------------------------------- */
export function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, makers-conversation-id',
      'Access-Control-Expose-Headers': 'X-Request-Id, X-AI-Model, X-AI-Route',
      'Access-Control-Max-Age': '86400',
    },
  });
}

/* ---------------------------------------------------------------------------
 * 主入口：POST /api/chat
 * ------------------------------------------------------------------------- */
export async function onRequestPost(context) {
  const request = context.request;
  const env = (context && context.env) || {};
  const signal = request && request.signal;
  const requestId = newConversationId();
  if (signal?.aborted) return new Response(null, { status: 499, headers: { 'X-Request-Id': requestId } });

  /* ⭐ makers-conversation-id：前端按契约不发送，由代理维护一个稳定的会话 ID。
   * 优先级「请求头 > 第一方 Cookie > 新生成」，新生成时写回 Set-Cookie，
   * 多轮复用同一 ID，保证平台粘性路由稳定。 */
  const headerId = readHeader(request, 'makers-conversation-id');
  const cookieId = readConversationCookie(request);
  const conversationId = headerId || cookieId || newConversationId();
  const setCookie = (!headerId && !cookieId)
    ? `${CONVERSATION_COOKIE}=${encodeURIComponent(conversationId)}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`
    : null;

  let rawText = '{}';
  try {
    rawText = await readRawBody(context);
  } catch (_) {
    return jsonError('无法读取请求体', 400, setCookie, requestId);
  }

  // 参数校验含可选 systemPrompt：超长在此拦下（HTTP 400），不进入主路径也不打到网关
  if (signal?.aborted) return new Response(null, { status: 499, headers: { 'X-Request-Id': requestId } });
  const check = validate(rawText);
  if (check.error) return jsonError(check.error, 400, setCookie, requestId);

  const gateway = resolveGateway(env);

  /* --- 主路径：薄代理转发到平台 Agent 端点 /chat --- */
  let upstream = null;
  let proxyError = null;
  let proxyController = null;
  let onClientAbort = null;
  let loopbackTimedOut = false;
  const origin = PREFER_AGENT_PROXY ? resolveOrigin(request) : '';
  if (origin) {
    const ctrl = new AbortController();
    proxyController = ctrl;
    const timer = setTimeout(() => {
      loopbackTimedOut = true;
      ctrl.abort();
    }, LOOPBACK_TIMEOUT_MS);
    // 客户端「停止生成」时同步中断上游，避免继续推理计费
    onClientAbort = () => ctrl.abort();
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onClientAbort, { once: true });
    }
    try {
      upstream = await fetch(`${origin}${AGENT_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'makers-conversation-id': conversationId,
          'X-Request-Id': requestId,
        },
        // 原样透传（含可选 systemPrompt）；/chat 端点会独立校验并用同一策略组装 system messages
        body: rawText,
        signal: ctrl.signal,
      });
    } catch (err) {
      proxyError = err;
    } finally {
      // 响应头已到达（或已失败）就取消首字节超时，绝不会误杀后续长流式输出
      clearTimeout(timer);
    }
  }

  if (signal?.aborted) {
    if (upstream?.body) void upstream.body.cancel().catch(() => {});
    if (onClientAbort) signal.removeEventListener?.('abort', onClientAbort);
    proxyController?.abort();
    return new Response(null, { status: 499, headers: { 'X-Request-Id': requestId } });
  }

  const upstreamType = upstream ? readHeader({ headers: upstream.headers }, 'content-type') : '';

  // 只有「2xx + SSE + 有 body」才透传；ReadableStream 直连，真正流式、零缓冲
  if (upstream && upstream.ok && upstream.body && upstreamType.toLowerCase().includes('text/event-stream')) {
    const headers = { ...SSE_HEADERS, 'X-Request-Id': requestId, 'X-AI-Route': 'agent' };
    const model = safeModelHeader(readHeader({ headers: upstream.headers }, 'x-ai-model'));
    if (model) headers['X-AI-Model'] = model;
    return new Response(wrapAgentStream(upstream.body, proxyController, signal, onClientAbort), {
      status: 200,
      headers: mergeHeaders(headers, setCookie),
    });
  }

  /* ⚠️ 任何其它响应一律退化到直连网关，不再把 4xx 当作客户端错误透传：
   * 线上预览域名需要 ?eo_token 鉴权，回环到公开 origin 可能被 CDN / WAF 返回
   * 401 / 403；Agent 路由未注册会返回 404 —— 这些都属于「回环不可用」而非用户输入错误。
   * 参数校验已在上面的 validate() 完成，Agent 不会对同一请求再返回 400。 */
  if (upstream && upstream.body) {
    void upstream.body.cancel().catch(() => {});
  }
  if (onClientAbort) signal?.removeEventListener?.('abort', onClientAbort);
  proxyController?.abort();
  if (signal?.aborted) return new Response(null, { status: 499, headers: { 'X-Request-Id': requestId } });
  if (!gateway) {
    const detail = loopbackTimedOut
      ? `回环首字节超过 ${LOOPBACK_TIMEOUT_MS / 1000}s`
      : proxyError
        ? '回环网络错误'
        : upstream
          ? `HTTP ${upstream.status}`
          : (origin ? '回环请求未发出' : '已禁用回环代理');
    return jsonError(
      `AI 服务暂不可用：Agent 端点转发失败（${detail}），且当前运行时未注入 AI_GATEWAY_* 环境变量。请确认 .env.example 已声明并在部署时由平台自动注入。`,
      502,
      setCookie,
      requestId,
    );
  }

  // 降级直连与 /chat 主路径使用同一份归一后的 systemPrompt，保证两条路径语义一致
  return directChatResponse(gateway, check.messages, check.systemPrompt, signal, setCookie, requestId);
}

/** 兜底：非 POST 方法统一返回 405，避免误命中造成困惑 */
export function onRequest(context) {
  // 某些运行时注入的 request 可能不带 method；本路由本身只服务 POST，
  // 因此缺省时按 POST 处理，避免误返回 405。
  const method = (context && context.request && context.request.method) || 'POST';
  if (method === 'OPTIONS') return onRequestOptions();
  if (method !== 'POST') return jsonError('仅支持 POST /api/chat', 405);
  return onRequestPost(context);
}
