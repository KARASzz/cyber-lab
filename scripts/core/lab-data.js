import { uid, MAX_PROJECTS, MAX_SESSIONS, MAX_STORED_MESSAGES } from './state.js';

/* 实验扩展数据独立于 cyberchat.v1；此模块不访问 DOM 或网络。 */

export const LAB_STORAGE_KEY = 'cyberlab.annotations.v1';
export const UI_STORAGE_KEY = 'cyberlab.ui.v1';
export const MAX_TAGS = 6;
export const MAX_TAG_LENGTH = 20;
export const MAX_NOTE_LENGTH = 12000;
export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;

export class LabDataError extends Error {
  constructor(message, path = '', code = 'invalid') {
    super(path ? `${path}：${message}` : message);
    this.name = 'LabDataError';
    this.path = path;
    this.code = code;
  }
}

export function normalizeTags(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new LabDataError('标签必须是字符串数组');
  const tags = [];
  const seen = new Set();
  for (const valueItem of value) {
    if (typeof valueItem !== 'string') throw new LabDataError('标签必须是字符串');
    const tag = valueItem.trim();
    if (!tag) throw new LabDataError('标签不能为空');
    if (tag.length > MAX_TAG_LENGTH) throw new LabDataError('单个标签不能超过 20 字符');
    const key = tag.normalize('NFC').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length > MAX_TAGS) throw new LabDataError('标签不能超过 6 个');
  }
  return tags;
}

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ANNOTATION_FIELDS = ['notes', 'tags', 'runs', 'updatedAt'];
const RUN_FIELDS = [
  'outcome', 'timeToHeadersMs', 'timeToFirstTokenMs', 'durationMs',
  'characters', 'historyMessages', 'systemPromptCharacters', 'model', 'route', 'requestId',
  'statusCode', 'errorCategory',
];

function emptyAnnotations() {
  return { version: 1, sessions: {} };
}

function assertRecord(value, path, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new LabDataError('必须是对象', path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new LabDataError('对象原型不安全', path);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || RESERVED_KEYS.has(key)) {
      throw new LabDataError('包含不安全的字段', path);
    }
    if (!Object.hasOwn(descriptors[key], 'value')) {
      throw new LabDataError('不允许访问器字段', path);
    }
    if (allowed && !allowed.includes(key)) {
      throw new LabDataError(`不支持字段 ${key.slice(0, 60)}`, path);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new LabDataError(`缺少字段 ${key}`, path);
  }
}

function assertId(value, path) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || RESERVED_KEYS.has(value)) {
    throw new LabDataError('ID 必须是非空且安全的字符串（最多 256 字符）', path);
  }
}

function normalizeRun(raw, path) {
  assertRecord(raw, path, RUN_FIELDS);
  const run = {};
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (key === 'route') {
      if (value !== null && !['agent', 'gateway', 'unknown'].includes(value)) {
        throw new LabDataError('route 路径必须是 agent、gateway 或 unknown', path);
      }
    } else if (key === 'outcome') {
      if (!['complete', 'stopped', 'timeout', 'error', 'offline'].includes(value)) {
        throw new LabDataError('outcome 状态无效', path);
      }
    } else if (key === 'model' || key === 'requestId') {
      if (value !== null && (typeof value !== 'string' || value.length > 512)) {
        throw new LabDataError(`${key} 必须是最多 512 字符的文本或 null`, path);
      }
    } else if (key === 'statusCode') {
      if (value !== null && (!Number.isInteger(value) || value < 100 || value > 599)) {
        throw new LabDataError('statusCode 必须是有效的 HTTP 状态码或 null', path);
      }
    } else if (key === 'errorCategory') {
      if (value !== null && !['http', 'network', 'stream', 'abort', 'timeout', 'empty_response', 'unknown'].includes(value)) {
        throw new LabDataError('errorCategory 类型无效', path);
      }
    } else if (key === 'characters' || key === 'historyMessages' || key === 'systemPromptCharacters') {
      if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
        throw new LabDataError(`${key} 必须是非负整数或 null`, path);
      }
    } else if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new LabDataError(`${key} 必须是非负有限数字或 null`, path);
    }
    run[key] = value;
  }
  return run;
}

function normalizeAnnotation(raw, path, strictTags = false) {
  assertRecord(raw, path, ANNOTATION_FIELDS);
  const notes = Object.hasOwn(raw, 'notes') ? raw.notes : '';
  if (typeof notes !== 'string') throw new LabDataError('笔记必须是字符串', path);
  if (notes.length > MAX_NOTE_LENGTH) throw new LabDataError('笔记不能超过 12000 字符', path);
  const rawTags = Object.hasOwn(raw, 'tags') ? raw.tags : [];
  if (!Array.isArray(rawTags)) throw new LabDataError('标签必须是字符串数组', path);
  let tags;
  try { tags = normalizeTags(rawTags); }
  catch (error) { throw new LabDataError(error.message, `${path}.tags`); }
  if (strictTags && (tags.length !== rawTags.length || tags.some((tag, i) => tag !== rawTags[i]))) {
    throw new LabDataError('标签必须先去重并去除首尾空白', `${path}.tags`);
  }
  const rawRuns = Object.hasOwn(raw, 'runs') ? raw.runs : {};
  assertRecord(rawRuns, `${path}.runs`, null);
  const runs = {};
  for (const messageId of Object.keys(rawRuns)) {
    assertId(messageId, `${path}.runs`);
    runs[messageId] = normalizeRun(rawRuns[messageId], `${path}.runs[${JSON.stringify(messageId)}]`);
  }
  const result = { notes, tags, runs };
  if (Object.hasOwn(raw, 'updatedAt')) {
    if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt) || raw.updatedAt < 0) {
      throw new LabDataError('更新时间必须是非负有限数字', `${path}.updatedAt`);
    }
    result.updatedAt = raw.updatedAt;
  }
  return result;
}

function canonicalAnnotations(raw, strictTags = false) {
  assertRecord(raw, 'annotations', ['version', 'sessions'], ['version', 'sessions']);
  if (raw.version !== 1) throw new LabDataError('扩展数据版本必须为 1', 'annotations.version');
  assertRecord(raw.sessions, 'annotations.sessions', null);
  const sessions = {};
  for (const sessionId of Object.keys(raw.sessions)) {
    assertId(sessionId, 'annotations.sessions');
    sessions[sessionId] = normalizeAnnotation(raw.sessions[sessionId],
      `annotations.sessions[${JSON.stringify(sessionId)}]`, strictTags);
  }
  return { version: 1, sessions };
}

export function normalizeAnnotations(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return canonicalAnnotations(value);
  } catch (_) {
    return emptyAnnotations();
  }
}

export function createAnnotationStorage(store) {
  let target = store;
  if (target === undefined) {
    try { target = typeof localStorage === 'undefined' ? null : localStorage; }
    catch (_) { target = null; }
  }
  return {
    load() {
      if (!target) return { ok: false, state: emptyAnnotations(), fresh: true, reason: 'unavailable', error: '实验扩展存储不可用' };
      let raw;
      try { raw = target.getItem(LAB_STORAGE_KEY); }
      catch (_) { return { ok: false, state: emptyAnnotations(), fresh: true, reason: 'read-error', error: '无法读取实验扩展数据' }; }
      if (raw === null || raw === undefined || raw === '') {
        return { ok: true, state: emptyAnnotations(), fresh: true };
      }
      try {
        if (typeof raw !== 'string') throw new LabDataError('存储内容必须是字符串');
        return { ok: true, state: canonicalAnnotations(JSON.parse(raw)), fresh: false };
      } catch (_) {
        return { ok: false, state: emptyAnnotations(), fresh: false, reason: 'corrupt', error: '实验扩展数据已损坏，原始数据尚未被覆盖' };
      }
    },
    save(state) {
      if (!target) return false;
      try {
        const value = canonicalAnnotations(state, true);
        target.setItem(LAB_STORAGE_KEY, JSON.stringify(value));
        return true;
      } catch (_) { return false; }
    },
  };
}

export function createUiStorage(store) {
  let target = store;
  let writable = true;
  if (target === undefined) {
    try { target = typeof localStorage === 'undefined' ? null : localStorage; }
    catch (_) { target = null; }
  }
  const defaults = () => ({ version: 1, wrapCode: false });
  return {
    load() {
      if (!target) { writable = false; return { ok: false, state: defaults(), reason: 'unavailable' }; }
      let raw;
      try { raw = target.getItem(UI_STORAGE_KEY); }
      catch (_) { writable = false; return { ok: false, state: defaults(), reason: 'read-error' }; }
      if (raw === null || raw === '') { writable = true; return { ok: true, state: defaults(), fresh: true }; }
      try {
        const parsed = JSON.parse(raw);
        assertRecord(parsed, 'ui', ['version', 'wrapCode'], ['version', 'wrapCode']);
        if (parsed.version !== 1 || typeof parsed.wrapCode !== 'boolean') throw new Error('invalid ui');
        writable = true;
        return { ok: true, state: { version: 1, wrapCode: parsed.wrapCode }, fresh: false };
      } catch (_) {
        writable = false;
        return { ok: false, state: defaults(), reason: 'corrupt' };
      }
    },
    save(state) {
      if (!target || !writable || !state || state.version !== 1 || typeof state.wrapCode !== 'boolean') return false;
      try { target.setItem(UI_STORAGE_KEY, JSON.stringify({ version: 1, wrapCode: state.wrapCode })); return true; }
      catch (_) { return false; }
    },
  };
}

export function getSessionAnnotation(annotations, sessionId) {
  assertId(sessionId, 'sessionId');
  const normalized = canonicalAnnotations(annotations);
  return Object.hasOwn(normalized.sessions, sessionId)
    ? normalized.sessions[sessionId] : { notes: '', tags: [], runs: {} };
}

export function updateSessionAnnotation(annotations, sessionId, patch) {
  assertId(sessionId, 'sessionId');
  assertRecord(patch, 'patch', ['notes', 'tags', 'runs']);
  const normalized = canonicalAnnotations(annotations);
  const previous = Object.hasOwn(normalized.sessions, sessionId)
    ? normalized.sessions[sessionId] : { notes: '', tags: [], runs: {} };
  normalized.sessions[sessionId] = normalizeAnnotation({ ...previous, ...patch, updatedAt: Date.now() }, `annotations.sessions[${JSON.stringify(sessionId)}]`);
  return normalized;
}

function searchSnippet(text, query) {
  if (text.length <= 120) return text;
  const found = query ? text.toLowerCase().indexOf(query) : 0;
  const center = found < 0 ? 0 : found + Math.min(query.length, 118) / 2;
  let start = Math.max(0, Math.min(text.length - 118, Math.floor(center - 59)));
  let end = Math.min(text.length, start + 118);
  // 不在 UTF-16 代理项中间截断。
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(start))) start++;
  if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

export function searchWorkspace(workspace, query, options = {}) {
  assertRecord(workspace, 'workspace', null);
  if (!workspace.chat || !Array.isArray(workspace.chat.projects)) {
    throw new LabDataError('工作区必须包含项目列表', 'chat.projects');
  }
  if (typeof query !== 'string') throw new LabDataError('搜索查询必须是字符串');
  assertRecord(options, 'options', ['limit']);
  const requested = Object.hasOwn(options, 'limit') ? options.limit : 50;
  if (!Number.isSafeInteger(requested) || requested < 0) throw new LabDataError('搜索数量限制必须是非负整数');
  const limit = Math.min(requested, 50);
  if (!limit) return [];
  const term = query.trim().toLowerCase();
  const annotations = normalizeAnnotations(workspace.annotations);
  const results = [];
  let order = 0;
  for (const project of workspace.chat.projects) {
    if (!project || typeof project.id !== 'string' || typeof project.name !== 'string' || !Array.isArray(project.sessions)) {
      throw new LabDataError('项目或实验列表无效', 'chat.projects');
    }
    for (const session of project.sessions) {
      if (!session || typeof session.id !== 'string' || typeof session.title !== 'string' || !Array.isArray(session.messages)) {
        throw new LabDataError('实验或消息列表无效', 'chat.projects.sessions');
      }
      const annotation = Object.hasOwn(annotations.sessions, session.id)
        ? annotations.sessions[session.id] : { notes: '', tags: [], runs: {} };
      const titles = [session.title, project.name];
      let match = 'recent';
      let rank = 0;
      let source = session.title;
      if (term) {
        const normalizedTitles = titles.map((title) => title.trim().toLowerCase());
        let index = normalizedTitles.findIndex((title) => title === term);
        if (index !== -1) { match = 'title-exact'; rank = 0; source = titles[index]; }
        else if ((index = normalizedTitles.findIndex((title) => title.startsWith(term))) !== -1) {
          match = 'title-prefix'; rank = 1; source = titles[index];
        } else if ((index = normalizedTitles.findIndex((title) => title.includes(term))) !== -1) {
          match = 'title-substring'; rank = 2; source = titles[index];
        } else {
          const tag = annotation.tags.find((item) => item.toLowerCase().includes(term));
          if (tag !== undefined) { match = 'tag'; rank = 3; source = tag; }
          else if (annotation.notes.toLowerCase().includes(term)) {
            match = 'note'; rank = 4; source = annotation.notes;
          } else {
            const message = [...session.messages].reverse().find((item) =>
              item && typeof item.content === 'string' && item.content.toLowerCase().includes(term));
            if (!message) continue;
            match = 'message'; rank = 5; source = message.content;
          }
        }
      }
      const updatedAt = Math.max(Number.isFinite(session.updatedAt) ? session.updatedAt : 0,
        Number.isFinite(annotation.updatedAt) ? annotation.updatedAt : 0);
      results.push({
        projectId: project.id,
        sessionId: session.id,
        projectName: project.name,
        sessionTitle: session.title,
        updatedAt,
        match,
        snippet: searchSnippet(source, term),
        _rank: rank,
        _order: order++,
      });
    }
  }
  results.sort((a, b) => a._rank - b._rank || b.updatedAt - a.updatedAt || a._order - b._order);
  return results.slice(0, limit).map(({ _rank, _order, ...item }) => item);
}

function textField(value, path, maximum, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim())) throw new LabDataError('必须是非空字符串', path);
  if (maximum !== null && value.length > maximum) throw new LabDataError(`不能超过 ${maximum} 字符`, path);
}

function timestamp(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new LabDataError('必须是非负时间戳', path);
  }
}

function validateBackup(backup) {
  assertRecord(backup, 'backup', ['format', 'version', 'exportedAt', 'chat', 'annotations'],
    ['format', 'version', 'exportedAt', 'chat', 'annotations']);
  if (backup.format !== 'cyberlab.backup') throw new LabDataError('不是赛博实验室备份', 'format');
  if (backup.version !== 1) throw new LabDataError('不支持的备份版本', 'version');
  if (typeof backup.exportedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(backup.exportedAt) || !Number.isFinite(Date.parse(backup.exportedAt))) {
    throw new LabDataError('必须是有效的 ISO 时间', 'exportedAt');
  }
  const chat = backup.chat;
  assertRecord(chat, 'chat', ['version', 'activeProjectId', 'projects'], ['version', 'activeProjectId', 'projects']);
  if (chat.version !== 1) throw new LabDataError('对话数据版本必须为 1', 'chat.version');
  if (!Array.isArray(chat.projects) || chat.projects.length === 0 || chat.projects.length > MAX_PROJECTS) {
    throw new LabDataError(`项目数量须为 1–${MAX_PROJECTS}`, 'chat.projects');
  }
  assertId(chat.activeProjectId, 'chat.activeProjectId');
  const projectIds = new Set();
  const sessionIds = new Set();
  const sessionMessages = new Map();
  const stats = { projects: chat.projects.length, sessions: 0, messages: 0, notes: 0, tags: 0 };

  chat.projects.forEach(function (project, pi) {
    const path = `chat.projects[${pi}]`;
    assertRecord(project, path, ['id', 'name', 'createdAt', 'updatedAt', 'systemPrompt', 'activeSessionId', 'sessions'],
      ['id', 'name', 'createdAt', 'updatedAt', 'systemPrompt', 'activeSessionId', 'sessions']);
    assertId(project.id, `${path}.id`);
    if (projectIds.has(project.id)) throw new LabDataError('项目 ID 重复', `${path}.id`);
    projectIds.add(project.id);
    textField(project.name, `${path}.name`, 60);
    timestamp(project.createdAt, `${path}.createdAt`);
    timestamp(project.updatedAt, `${path}.updatedAt`);
    const sys = project.systemPrompt;
    assertRecord(sys, `${path}.systemPrompt`, ['enabled', 'text', 'presetId'], ['enabled', 'text', 'presetId']);
    if (typeof sys.enabled !== 'boolean') throw new LabDataError('必须是布尔值', `${path}.systemPrompt.enabled`);
    textField(sys.text, `${path}.systemPrompt.text`, null, true);
    if (sys.text.trim().length > 4000) throw new LabDataError('协议不能超过 4000 字符', `${path}.systemPrompt.text`);
    if (sys.presetId !== null && (typeof sys.presetId !== 'string' || sys.presetId.length > 256)) {
      throw new LabDataError('预设 ID 无效', `${path}.systemPrompt.presetId`);
    }
    if (!Array.isArray(project.sessions) || project.sessions.length > MAX_SESSIONS) {
      throw new LabDataError(`每个项目最多 ${MAX_SESSIONS} 个实验`, `${path}.sessions`);
    }
    const ownSessionIds = new Set();
    stats.sessions += project.sessions.length;
    project.sessions.forEach(function (session, si) {
      const sessionPath = `${path}.sessions[${si}]`;
      assertRecord(session, sessionPath, ['id', 'title', 'createdAt', 'updatedAt', 'messages'],
        ['id', 'title', 'createdAt', 'updatedAt', 'messages']);
      assertId(session.id, `${sessionPath}.id`);
      if (sessionIds.has(session.id)) throw new LabDataError('实验 ID 重复', `${sessionPath}.id`);
      sessionIds.add(session.id);
      ownSessionIds.add(session.id);
      textField(session.title, `${sessionPath}.title`, 60);
      timestamp(session.createdAt, `${sessionPath}.createdAt`);
      timestamp(session.updatedAt, `${sessionPath}.updatedAt`);
      if (!Array.isArray(session.messages) || session.messages.length > MAX_STORED_MESSAGES) {
        throw new LabDataError(`每个实验最多 ${MAX_STORED_MESSAGES} 条消息`, `${sessionPath}.messages`);
      }
      const messageIds = new Map();
      stats.messages += session.messages.length;
      session.messages.forEach(function (message, mi) {
        const messagePath = `${sessionPath}.messages[${mi}]`;
        assertRecord(message, messagePath, ['id', 'role', 'content', 'ts', 'stopped'], ['role', 'content', 'ts']);
        if (Object.hasOwn(message, 'id')) {
          assertId(message.id, `${messagePath}.id`);
          if (messageIds.has(message.id)) throw new LabDataError('消息 ID 重复', `${messagePath}.id`);
          messageIds.set(message.id, message.role);
        }
        if (!['user', 'assistant'].includes(message.role)) throw new LabDataError('角色只能是 user 或 assistant', `${messagePath}.role`);
        textField(message.content, `${messagePath}.content`, null);
        timestamp(message.ts, `${messagePath}.ts`);
        if (Object.hasOwn(message, 'stopped') && typeof message.stopped !== 'boolean') {
          throw new LabDataError('中止标记必须是布尔值', `${messagePath}.stopped`);
        }
      });
      sessionMessages.set(session.id, messageIds);
    });
    if (typeof project.activeSessionId !== 'string' ||
      (project.sessions.length && !ownSessionIds.has(project.activeSessionId)) ||
      (!project.sessions.length && project.activeSessionId !== '')) {
      throw new LabDataError('当前实验 ID 无效', `${path}.activeSessionId`);
    }
  });
  if (!projectIds.has(chat.activeProjectId)) throw new LabDataError('当前项目 ID 无效', 'chat.activeProjectId');
  const annotations = canonicalAnnotations(backup.annotations, true);
  Object.keys(annotations.sessions).forEach(function (sessionId) {
    const session = annotations.sessions[sessionId];
    if (!sessionMessages.has(sessionId)) throw new LabDataError('找不到对应实验', `annotations.sessions[${JSON.stringify(sessionId)}]`);
    if (session.notes.trim()) stats.notes += 1;
    stats.tags += session.tags.length;
    Object.keys(session.runs).forEach(function (messageId) {
      if (sessionMessages.get(sessionId).get(messageId) !== 'assistant') {
        throw new LabDataError('运行记录没有对应的助手消息', `annotations.sessions[${JSON.stringify(sessionId)}].runs`);
      }
    });
  });
  return stats;
}

export function inspectWorkspaceBackup(text, byteLength) {
  try {
    if (typeof text !== 'string') throw new LabDataError('备份必须是 JSON 文本');
    const actualBytes = new TextEncoder().encode(text).byteLength;
    if (actualBytes > MAX_BACKUP_BYTES || (byteLength !== undefined && (!Number.isSafeInteger(byteLength) || byteLength < actualBytes || byteLength > MAX_BACKUP_BYTES))) {
      throw new LabDataError('备份文件不能超过 5 MiB');
    }
    let backup;
    try { backup = JSON.parse(text); } catch (_) { throw new LabDataError('备份不是有效 JSON'); }
    const stats = validateBackup(backup);
    return { ok: true, stats, backup };
  } catch (error) {
    return { ok: false, error: error instanceof LabDataError ? error.message : '备份格式无效' };
  }
}

export function createWorkspaceBackup(chat, annotations, exportedAt = new Date().toISOString()) {
  return {
    format: 'cyberlab.backup',
    version: 1,
    exportedAt,
    chat: structuredClone(chat),
    annotations: structuredClone(annotations),
  };
}

export function buildMergedImport(chat, annotations, backup, idFactory = uid) {
  const text = JSON.stringify(backup);
  const inspected = inspectWorkspaceBackup(text, new TextEncoder().encode(text).byteLength);
  if (!inspected.ok) throw new LabDataError(inspected.error);
  if (!chat || !Array.isArray(chat.projects) || chat.projects.length + backup.chat.projects.length > MAX_PROJECTS) {
    throw new LabDataError(`合并后项目不能超过 ${MAX_PROJECTS} 个`);
  }
  const currentAnnotations = canonicalAnnotations(annotations, true);
  const existing = new Set();
  chat.projects.forEach(function (project) {
    existing.add(project.id);
    if (!Array.isArray(project.sessions) || project.sessions.length > MAX_SESSIONS) {
      throw new LabDataError('当前项目的实验数量已超过上限');
    }
    project.sessions.forEach(function (session) {
      existing.add(session.id);
      if (!Array.isArray(session.messages) || session.messages.length > MAX_STORED_MESSAGES) {
        throw new LabDataError('当前实验的消息数量已超过上限');
      }
      session.messages.forEach(function (message) { if (message.id) existing.add(message.id); });
    });
  });
  function nextId() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const value = idFactory();
      if (typeof value !== 'string' || !value.trim() || value.length > 256 || RESERVED_KEYS.has(value) || existing.has(value)) continue;
      existing.add(value);
      return value;
    }
    throw new LabDataError('无法生成不重复的 ID');
  }
  const additions = [];
  const sessions = { ...currentAnnotations.sessions };
  backup.chat.projects.forEach(function (project) {
    const nextProject = { ...project, id: nextId(), sessions: [] };
    let nextActive = '';
    project.sessions.forEach(function (session) {
      const nextSession = { ...session, id: nextId(), messages: [] };
      const messageIds = new Map();
      session.messages.forEach(function (message) {
        const id = nextId();
        if (message.id) messageIds.set(message.id, id);
        nextSession.messages.push({ ...message, id });
      });
      if (session.id === project.activeSessionId) nextActive = nextSession.id;
      nextProject.sessions.push(nextSession);
      if (Object.hasOwn(backup.annotations.sessions, session.id)) {
        const annotation = canonicalAnnotations({ version: 1, sessions: { [session.id]: backup.annotations.sessions[session.id] } }, true).sessions[session.id];
        const runs = {};
        Object.keys(annotation.runs).forEach(function (oldId) { runs[messageIds.get(oldId)] = annotation.runs[oldId]; });
        sessions[nextSession.id] = { ...annotation, runs };
      }
    });
    nextProject.activeSessionId = nextActive;
    additions.push(nextProject);
  });
  return {
    chat: { ...structuredClone(chat), projects: [...structuredClone(chat.projects), ...additions] },
    annotations: { version: 1, sessions },
  };
}

function markdownText(value) {
  return String(value).replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}\[\]<>#|]/g, '\\$&');
}

function fencedText(value) {
  const text = String(value == null ? '' : value);
  let longest = 2;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

function formattedDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '未提供';
}

export function serializeSessionMarkdown(project, session, annotation) {
  if (!project || !session) throw new LabDataError('缺少当前实验');
  const note = annotation || { notes: '', tags: [] };
  const protocol = project.systemPrompt && project.systemPrompt.enabled && project.systemPrompt.text.trim()
    ? project.systemPrompt.text : '未启用';
  const sections = [
    `# ${markdownText(session.title)}`,
    `- 项目：${markdownText(project.name)}`,
    `- 实验 ID：${markdownText(session.id)}`,
    `- 创建时间：${formattedDate(session.createdAt)}`,
    `- 更新时间：${formattedDate(session.updatedAt)}`,
    `- 标签：${(note.tags || []).map(markdownText).join('、') || '无'}`,
    `## 实验协议\n\n${fencedText(protocol)}`,
    `## 实验笔记\n\n${fencedText(note.notes || '')}`,
    '## 实验对话',
  ];
  const messages = Array.isArray(session.messages) ? [...session.messages] : [];
  messages.sort((a, b) => Number(a.ts) - Number(b.ts));
  messages.forEach(function (message) {
    sections.push(`### ${message.role === 'assistant' ? '观测结果' : '实验输入'} · ${formattedDate(message.ts)}${message.stopped ? ' · 已中止' : ''}\n\n${fencedText(message.content)}`);
  });
  return sections.join('\n\n') + '\n';
}

export function safeFileName(title) {
  let name = String(title == null ? '' : title).replace(/[\x00-\x1f\x7f/\\?%*:|"<>]/g, '').trim();
  name = name.replace(/^\.+|\.+$/g, '').slice(0, 48);
  if (/[\uD800-\uDBFF]$/.test(name)) name = name.slice(0, -1);
  return name || '实验';
}
