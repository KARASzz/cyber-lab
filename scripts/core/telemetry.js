const MODEL_ID = /^(?:@?[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CATEGORIES = new Set(['http', 'network', 'stream', 'abort', 'timeout', 'empty_response', 'unknown']);

function ownValue(value, name) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const property = Object.getOwnPropertyDescriptor(value, name);
    return property && 'value' in property ? property.value : undefined;
  } catch (_) {
    return undefined;
  }
}

function normalizeStatusCode(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value : null;
}

function normalizeRoute(value) {
  return value === 'agent' || value === 'gateway' ? value : 'unknown';
}

function normalizeRequestId(value) {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

function normalizeModel(value) {
  if (typeof value !== 'string' || value.length > 128 || !MODEL_ID.test(value)) return null;
  if (value.split('/').some((part) => /^(?:sk[-_]|token[-_]|secret[-_]|api[-_]?key[-_])/i.test(part))) return null;
  return value;
}

function normalizeCount(value, maximum) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? (value === 0 ? 0 : value) : null;
}

function normalizeErrorCategory(value) {
  return typeof value === 'string' && ERROR_CATEGORIES.has(value) ? value : null;
}

function normalizeDuration(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? (value === 0 ? 0 : value) : null;
}

function normalizeOutcome(value) {
  return ['complete', 'stopped', 'timeout', 'error'].includes(value) ? value : null;
}

/* 用于持久化与读取损坏的运行记录；未知字段不会被复制。 */
export function normalizeRunTelemetry(raw) {
  let outcome = normalizeOutcome(ownValue(raw, 'outcome'));
  const statusCode = normalizeStatusCode(ownValue(raw, 'statusCode'));
  const characters = normalizeCount(ownValue(raw, 'characters'), Number.MAX_SAFE_INTEGER);
  const durationMs = normalizeDuration(ownValue(raw, 'durationMs'));
  let timeToHeadersMs = normalizeDuration(ownValue(raw, 'timeToHeadersMs'));
  let timeToFirstTokenMs = normalizeDuration(ownValue(raw, 'timeToFirstTokenMs'));
  if (durationMs !== null && timeToHeadersMs !== null && timeToHeadersMs > durationMs) {
    timeToHeadersMs = null;
  }
  if (durationMs !== null && timeToFirstTokenMs !== null && timeToFirstTokenMs > durationMs) {
    timeToFirstTokenMs = null;
  }
  if (timeToHeadersMs !== null && timeToFirstTokenMs !== null && timeToFirstTokenMs < timeToHeadersMs) {
    timeToFirstTokenMs = null;
  }
  let errorCategory = normalizeErrorCategory(ownValue(raw, 'errorCategory'));
  if (outcome === 'complete' && statusCode !== null && (statusCode < 200 || statusCode >= 300)) {
    outcome = 'error';
    errorCategory = 'http';
  } else if (outcome === 'complete' && characters === 0) {
    outcome = 'error';
    errorCategory = 'empty_response';
  } else if (outcome === 'complete' || outcome === 'stopped') errorCategory = null;
  else if (outcome === 'timeout') errorCategory = 'timeout';
  else if (outcome === 'error' && errorCategory === null) errorCategory = 'unknown';
  return {
    outcome: outcome,
    timeToHeadersMs: timeToHeadersMs,
    timeToFirstTokenMs: timeToFirstTokenMs,
    durationMs: durationMs,
    characters: characters,
    historyMessages: normalizeCount(ownValue(raw, 'historyMessages'), 60),
    systemPromptCharacters: normalizeCount(ownValue(raw, 'systemPromptCharacters'), 4000),
    statusCode: statusCode,
    route: normalizeRoute(ownValue(raw, 'route')),
    requestId: normalizeRequestId(ownValue(raw, 'requestId')),
    model: normalizeModel(ownValue(raw, 'model')),
    errorCategory: errorCategory,
  };
}

/* 诊断只导出允许的固定字段，不包含内容、系统指令、计数、URL 或凭据。 */
export function toDiagnostic(raw) {
  const run = normalizeRunTelemetry(raw);
  return {
    statusCode: run.statusCode,
    timeToHeadersMs: run.timeToHeadersMs,
    timeToFirstTokenMs: run.timeToFirstTokenMs,
    durationMs: run.durationMs,
    route: run.route,
    requestId: run.requestId,
    model: run.model,
    errorCategory: run.errorCategory,
  };
}

/*
 * 每个请求创建独立实例：先 markHeaders({ statusCode, route, requestId, model })，
 * 每次成功交付 delta 后调用 markToken(delta)，最后调用 finish(outcome, details)。
 * details 只读取 historyMessages、systemPromptCharacters 和固定 errorCategory。
 * markToken 不保留文本，characters 按 JS 字符串长度（UTF-16 代码单元）统计。
 * 中止/超时应在触发中断时立即 finish；首个终态和首个测量不可覆盖。
 */
export function createRunTelemetry(now = () => performance.now()) {
  function readClock() {
    try {
      const value = now();
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch (_) {
      return null;
    }
  }

  const startedAt = readClock();
  let lastClock = startedAt;
  function elapsed() {
    if (startedAt === null) return null;
    const value = readClock();
    if (value === null || value < lastClock) return null;
    const difference = normalizeDuration(value - startedAt);
    if (difference === null) return null;
    lastClock = value;
    return difference;
  }

  let headersMarked = false;
  let tokenMarked = false;
  let timeToHeadersMs = null;
  let timeToFirstTokenMs = null;
  let durationMs = null;
  let state = 'connecting';
  let outcome = null;
  let characters = 0;
  let hasContent = false;
  let errorCategory = null;
  let historyMessages = null;
  let systemPromptCharacters = null;
  let statusCode = null;
  let route = 'unknown';
  let requestId = null;
  let model = null;

  function snapshot() {
    return {
      state: state,
      outcome: outcome,
      timeToHeadersMs: timeToHeadersMs,
      timeToFirstTokenMs: timeToFirstTokenMs,
      durationMs: durationMs,
      characters: characters,
      historyMessages: historyMessages,
      systemPromptCharacters: systemPromptCharacters,
      statusCode: statusCode,
      route: route,
      requestId: requestId,
      model: model,
      errorCategory: errorCategory,
    };
  }

  return {
    get state() { return state; },
    markHeaders(meta = {}) {
      if (outcome !== null || headersMarked || tokenMarked) return;
      headersMarked = true;
      timeToHeadersMs = elapsed();
      statusCode = normalizeStatusCode(ownValue(meta, 'statusCode'));
      route = normalizeRoute(ownValue(meta, 'route'));
      requestId = normalizeRequestId(ownValue(meta, 'requestId'));
      model = normalizeModel(ownValue(meta, 'model'));
    },
    markToken(delta) {
      if (outcome !== null || typeof delta !== 'string' || delta.length === 0) return;
      if (!tokenMarked) {
        tokenMarked = true;
        timeToFirstTokenMs = elapsed();
      }
      characters += delta.length;
      if (/\S/.test(delta)) hasContent = true;
      state = 'streaming';
    },
    finish(finalState, details = {}) {
      if (outcome !== null) return snapshot();
      durationMs = elapsed();
      historyMessages = normalizeCount(ownValue(details, 'historyMessages'), 60);
      systemPromptCharacters = normalizeCount(ownValue(details, 'systemPromptCharacters'), 4000);
      if (!['complete', 'stopped', 'timeout', 'error'].includes(finalState)) {
        finalState = 'error';
        errorCategory = 'unknown';
      } else if (finalState === 'complete' && statusCode !== null && (statusCode < 200 || statusCode >= 300)) {
        finalState = 'error';
        errorCategory = 'http';
      } else if (finalState === 'complete' && !hasContent) {
        finalState = 'error';
        errorCategory = 'empty_response';
      } else if (finalState === 'timeout') {
        errorCategory = 'timeout';
      } else if (finalState === 'error') {
        errorCategory = normalizeErrorCategory(ownValue(details, 'errorCategory')) || 'unknown';
      }
      state = finalState;
      outcome = finalState;
      return snapshot();
    },
    snapshot: snapshot,
  };
}
