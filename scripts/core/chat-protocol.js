/* ============================================================
 * scripts/core/chat-protocol.js —— SSE 流协议纯函数核心（DOM 无关）
 *
 * 从 app.js 迁移而来，算法与常量保持不变。
 * 负责：SSE 帧解析（跨 chunk / 拆 UTF-8 / CRLF / 心跳 / 多行 data / [DONE]）、
 *       delta 提取、可自包含 JSON 判定、增量写入漏斗（世代 + 会话双校验）。
 *
 * 对外协议（与 cloud-functions/api/chat.js、agents/_chat.ts 严格一致）：
 *   data: {"delta":"增量"} / data: {"error":"..."} / data: [DONE]
 *   空 delta 是心跳，不显示为内容，但会重置 stall 计时。
 * ============================================================ */

const Decoder = (typeof TextDecoder !== 'undefined') ? TextDecoder : null;

export class ChatError extends Error {
  constructor(title, detail) {
    super(detail || title);
    this.name = 'ChatError';
    this.title = title;
    this.detail = detail || '';
  }
}

export function looksLikeMarkup(payload) {
  return /^(<|\{|\[|\s*<!DOCTYPE|\[object )/i.test(payload);
}

/* 兼容 delta / delta.content / delta.text / content / text /
   answer / response / message / choices[0].delta.content 等形态 */
export function extractDelta(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const d = obj.delta;
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object') {
    if (typeof d.content === 'string') return d.content;
    if (typeof d.text === 'string') return d.text;
  }
  const keys = ['content', 'text', 'answer', 'response', 'message'];
  for (let i = 0; i < keys.length; i++) {
    if (typeof obj[keys[i]] === 'string') return obj[keys[i]];
  }
  const choices = obj.choices;
  if (Array.isArray(choices) && choices[0]) {
    const c = choices[0];
    if (typeof c.delta === 'string') return c.delta;
    if (c.delta && typeof c.delta.content === 'string') return c.delta.content;
    if (typeof c.text === 'string') return c.text;
    if (c.message && typeof c.message.content === 'string') return c.message.content;
  }
  return '';
}

export function isSelfContained(payload) {
  if (payload === '[DONE]') return true;
  const first = payload.charAt(0);
  const last = payload.charAt(payload.length - 1);
  if ((first === '{' && last === '}') || (first === '[' && last === ']')) {
    try { JSON.parse(payload); return true; } catch (_) { return false; }
  }
  return false;
}

/* ----------------------------------------------------------
 * SSE 解析器（自研，不用 EventSource）
 *   - 跨 chunk 半行留在 buffer；TextDecoder 流式解码处理 UTF-8 拆字
 *   - CRLF 归一；忽略空行 / ':' 心跳注释 / event/id/retry 非 data 字段
 *   - 单行完整 JSON 立即处理（逐字实时渲染）；多行 data 空行后合并
 *   - [DONE] 立即置 finished，之后所有事件一律忽略
 * -------------------------------------------------------- */
export function createSSEParser(onEvent, onChunk) {
  const decoder = Decoder ? new Decoder('utf-8') : null;
  let buffer = '';
  let dataLines = [];
  let finished = false;

  function emit(raw) {
    if (finished) return;
    const payload = String(raw).trim();
    if (!payload) return;
    if (payload === '[DONE]') { finished = true; return; }
    onEvent(payload);
  }

  function flush() {
    if (!dataLines.length) return;
    const joined = dataLines.join('\n');
    dataLines = [];
    emit(joined);
  }

  function handleLine(line) {
    if (line === '') { flush(); return; }
    if (line.charAt(0) === ':') return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.charAt(0) === ' ') value = value.slice(1);
    if (field !== 'data') return;
    const trimmed = value.trim();
    if (trimmed && !dataLines.length && isSelfContained(trimmed)) {
      emit(trimmed);
    } else {
      dataLines.push(value);
    }
  }

  function appendDecoded(chunk, end) {
    if (decoder) return decoder.decode(chunk, { stream: !end });
    /* 极端降级：无 TextDecoder 时按 latin1 拼接（仅用于非浏览器测试宿主） */
    if (typeof chunk === 'string') return chunk;
    let s = '';
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  return {
    get finished() { return finished; },
    feed: function (chunk) {
      if (onChunk) onChunk();
      buffer += appendDecoded(chunk, false);
      let idx;
      while (!finished && (idx = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, idx).replace(/\r$/, ''));
        buffer = buffer.slice(idx + 1);
      }
      if (finished) buffer = '';
    },
    finish: function () {
      buffer += decoder ? decoder.decode() : '';
      if (!finished) {
        if (buffer.length) handleLine(buffer.replace(/\r$/, ''));
        flush();
      }
      buffer = '';
    },
  };
}

/* 唯一的增量写入漏斗：世代 + 会话 id 双重校验。
   切换项目/会话后旧请求的所有增量在此被丢弃，绝不回写到新会话。 */
export function deliverDelta(ctx, delta, generation, activeSessionId) {
  if (!ctx || ctx.gen !== generation || ctx.sessionId !== activeSessionId) return false;
  if (!delta) return false;
  const d = String(delta);
  ctx.content += d;
  if (typeof ctx.append === 'function') ctx.append(d);
  return true;
}
