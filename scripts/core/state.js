/* ============================================================
 * scripts/core/state.js —— 对话状态纯函数核心（DOM 无关）
 *
 * 从 app.js 迁移而来，保持算法与常量完全一致，仅做「解耦」不做「重设计」。
 * 负责：本地数据结构、归一化与异常兜底、存储适配、历史裁剪、请求体组装。
 *
 * 契约约束（与 cloud-functions/api/chat.js、agents/_chat.ts 对齐）：
 *   - messages 最多 60 条、单条 ≤8000 字、累计 ≤60000 字（后端硬校验）
 *   - 前端历史裁剪更保守：≤40 条 / ≤50000 字，并保证首条为 user
 *   - systemPrompt 仅在「启用且 trim 后非空」时携带，≤4000 字
 * ============================================================ */

/* 存储键与版本号：主键版本不变，保证旧 cyberchat.v1 可读 */
export const STORAGE_KEY = 'cyberchat.v1';
export const DATA_VERSION = 1;

export const MAX_INPUT_LENGTH = 4000;
export const MAX_SYSTEM_LENGTH = 4000;

/* 与后端校验（60 条 / 60000 字符 / 单条 8000）对齐并留余量 */
export const MAX_HISTORY_MESSAGES = 40;
export const MAX_HISTORY_CHARS = 50000;
export const MAX_MESSAGE_CHARS = 8000;

/* 本地数据结构上限，防止异常数据撑爆存储 */
export const MAX_PROJECTS = 50;
export const MAX_SESSIONS = 100;
export const MAX_STORED_MESSAGES = 200;

/* 项目级系统指令模板（预设） */
export const PRESETS = [
  {
    id: 'coder',
    name: '代码实现助手',
    desc: '给可运行代码 + 关键说明，标注语言',
    text: '你是一名资深全栈工程师。回答时先给一句结论，再给出可直接运行的代码，代码块必须标注语言。随后用简短要点说明关键实现、依赖与常见坑。不写客套话，不重复问题；信息不足时先列出最多 3 个必要的澄清点再动手。',
  },
  {
    id: 'reviewer',
    name: '犀利技术评审',
    desc: '按严重度列问题与风险，给修改建议',
    text: '你是一名严格的技术评审专家。先按「阻塞 / 严重 / 一般」三个等级列出问题，每条包含：现象、根因、影响、可执行的修改建议。对性能、安全、边界条件与可维护性保持敏感。不要客套、不要泛泛而谈；若确实没有问题，明确说明并指出仍存的风险点。',
  },
  {
    id: 'translator',
    name: '极简翻译官',
    desc: '只输出译文，保留术语与格式',
    text: '你是一名专业翻译。自动识别原文语种并在中英文之间互译。只输出译文，不解释、不加注释、不加前后缀。准确保留专业术语、数字、单位、标点层级、列表与代码格式；不确定的人名或术语采用通行译法，并在首次出现时用括号保留原文。',
  },
  {
    id: 'ideator',
    name: '创意思考伙伴',
    desc: '三个不同角度的设想 + 落地难点',
    text: '你是一名发散思维搭档。针对每个问题给出 3 个明显不同角度的设想，每个设想包含：核心思路、最吸引人的亮点、最大的落地难点、一个最小可行验证方式。鼓励反常识方向，但每个设想都要能落地；语言精炼，不写引言和总结。',
  },
];

const root = (typeof globalThis !== 'undefined') ? globalThis : undefined;

export function uid() {
  try {
    if (root && root.crypto && typeof root.crypto.randomUUID === 'function') {
      return root.crypto.randomUUID();
    }
  } catch (_) { /* 降级到时间戳随机串 */ }
  return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

export function clampText(value, max) {
  return String(value == null ? '' : value).slice(0, max);
}

export function makeSession(title) {
  const t = Date.now();
  return {
    id: uid(),
    title: clampText(title || '新会话', 60),
    createdAt: t,
    updatedAt: t,
    messages: [],
  };
}

export function makeProject(name) {
  const t = Date.now();
  const session = makeSession('新会话');
  return {
    id: uid(),
    name: clampText(name || '未命名项目', 60),
    createdAt: t,
    updatedAt: t,
    systemPrompt: { enabled: false, text: '', presetId: null },
    activeSessionId: session.id,
    sessions: [session],
  };
}

export function defaultState() {
  const p = makeProject('默认项目');
  return { version: DATA_VERSION, activeProjectId: p.id, projects: [p] };
}

/* 数据版本 + 异常 JSON 兜底：任何非法结构都收敛为可用状态 */
export function normalizeState(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw); } catch (_) { return defaultState(); }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return defaultState();
  const srcProjects = Array.isArray(data.projects) ? data.projects : null;
  if (!srcProjects) return defaultState();

  const seenP = Object.create(null);
  const seenS = Object.create(null);
  const projects = [];
  let mappedActiveProjectId = '';

  for (let i = 0; i < srcProjects.length; i++) {
    const p = srcProjects[i];
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    const originalProjectId = typeof p.id === 'string' ? p.id : '';
    let pid = (originalProjectId.trim() && originalProjectId.length <= 256 && !['__proto__', 'constructor', 'prototype'].includes(originalProjectId)) ? originalProjectId : uid();
    while (seenP[pid]) pid = uid();
    seenP[pid] = 1;
    if (!mappedActiveProjectId && originalProjectId && originalProjectId === data.activeProjectId) mappedActiveProjectId = pid;

    const sys = (p.systemPrompt && typeof p.systemPrompt === 'object' && !Array.isArray(p.systemPrompt))
      ? p.systemPrompt : {};
    const systemPrompt = {
      enabled: sys.enabled === true,
      text: typeof sys.text === 'string' ? sys.text : '',
      presetId: typeof sys.presetId === 'string' ? sys.presetId : null,
    };

    const sessions = [];
    let mappedActiveSessionId = '';
    const srcSessions = Array.isArray(p.sessions) ? p.sessions : [];
    for (let j = 0; j < srcSessions.length; j++) {
      const s = srcSessions[j];
      if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
      const originalId = typeof s.id === 'string' ? s.id : '';
      let sid = (originalId.trim() && originalId.length <= 256 && !['__proto__', 'constructor', 'prototype'].includes(originalId)) ? originalId : uid();
      while (seenS[sid]) sid = uid();
      seenS[sid] = 1;
      if (!mappedActiveSessionId && originalId && originalId === p.activeSessionId) mappedActiveSessionId = sid;

      const messages = [];
      const seenMessages = Object.create(null);
      const srcMessages = Array.isArray(s.messages) ? s.messages : [];
      for (let k = 0; k < srcMessages.length; k++) {
        const m = srcMessages[k];
        if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const content = typeof m.content === 'string' ? m.content : '';
        if (!content.trim()) continue;
        let messageId = (typeof m.id === 'string' && m.id.trim() && m.id.length <= 256 && !['__proto__', 'constructor', 'prototype'].includes(m.id)) ? m.id : uid();
        while (seenMessages[messageId]) messageId = uid();
        seenMessages[messageId] = 1;
        messages.push({
          id: messageId,
          role: m.role,
          content: content,
          ts: Number(m.ts) || Date.now(),
          stopped: m.stopped === true,
        });
      }
      const sc = Number(s.createdAt) || Date.now();
      sessions.push({
        id: sid,
        title: typeof s.title === 'string' && s.title ? s.title : '新会话',
        createdAt: sc,
        updatedAt: Number(s.updatedAt) || sc,
        messages: messages,
      });
    }

    let activeSessionId = mappedActiveSessionId || (typeof p.activeSessionId === 'string' ? p.activeSessionId : '');
    let hasActive = false;
    for (let j = 0; j < sessions.length; j++) if (sessions[j].id === activeSessionId) { hasActive = true; break; }
    if (!hasActive) activeSessionId = sessions.length ? sessions[0].id : '';

    const pc = Number(p.createdAt) || Date.now();
    projects.push({
      id: pid,
      name: typeof p.name === 'string' && p.name ? p.name : '未命名项目',
      createdAt: pc,
      updatedAt: Number(p.updatedAt) || pc,
      systemPrompt: systemPrompt,
      activeSessionId: activeSessionId,
      sessions: sessions,
    });
  }

  if (!projects.length) return defaultState();
  let activeProjectId = mappedActiveProjectId || (typeof data.activeProjectId === 'string' ? data.activeProjectId : '');
  let hasActive = false;
  for (let i = 0; i < projects.length; i++) if (projects[i].id === activeProjectId) { hasActive = true; break; }
  if (!hasActive) activeProjectId = projects[0].id;

  /* 版本不匹配但结构可用 → 就地迁移到当前版本 */
  return { version: DATA_VERSION, activeProjectId: activeProjectId, projects: projects };
}

/* 存储适配层：store 可注入，便于 mock 自测；localStorage 不可用时静默降级 */
export function createStorage(store) {
  let target = store;
  let writable = true;
  if (target === undefined) {
    try { target = (typeof localStorage !== 'undefined') ? localStorage : null; }
    catch (_) { target = null; }
  }
  return {
    load: function () {
      if (!target) {
        writable = false;
        return { ok: false, state: defaultState(), fresh: true, reason: 'unavailable' };
      }
      let raw;
      try { raw = target.getItem(STORAGE_KEY); }
      catch (_) {
        writable = false;
        return { ok: false, state: defaultState(), fresh: false, reason: 'read-error' };
      }
      if (raw === null || raw === undefined || raw === '') {
        writable = true;
        return { ok: true, state: defaultState(), fresh: true };
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.projects)) {
          throw new Error('invalid storage');
        }
        writable = true;
        return { ok: true, state: normalizeState(parsed), fresh: false };
      } catch (_) {
        writable = false;
        return { ok: false, state: defaultState(), fresh: false, reason: 'corrupt' };
      }
    },
    save: function (state) {
      if (!target || !writable) return false;
      try { target.setItem(STORAGE_KEY, JSON.stringify(state)); return true; }
      catch (_) { return false; }
    },
  };
}

/* 历史裁剪：≤40 条 / ≤50000 字符 / 单条 ≤8000 / 首条必为 user */
export function trimHistory(history) {
  const all = Array.isArray(history) ? history : [];
  const picked = [];
  let total = 0;
  for (let i = all.length - 1; i >= 0 && picked.length < MAX_HISTORY_MESSAGES; i--) {
    const m = all[i];
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = clampText(typeof m.content === 'string' ? m.content : '', MAX_MESSAGE_CHARS);
    if (!content.trim()) continue;   // 与后端 validate() 的 content.trim() 校验对齐
    if (total + content.length > MAX_HISTORY_CHARS) break;
    total += content.length;
    picked.push({ role: m.role, content: content });
  }
  picked.reverse();
  while (picked.length && picked[0].role !== 'user') picked.shift();
  if (!picked.length) {
    const last = all[all.length - 1];
    return [{ role: 'user', content: clampText(last && last.content, MAX_MESSAGE_CHARS) }];
  }
  return picked;
}

/* 请求体：systemPrompt 仅在「启用且非空」时携带，否则字段完全不存在 */
export function buildRequestBody(history, systemPrompt) {
  const body = { messages: trimHistory(history) };
  if (typeof systemPrompt === 'string' && systemPrompt.trim() !== '') {
    /* 与后端 normalizeSystemPrompt 一致：按 trim 后内容计算并截断 */
    body.systemPrompt = clampText(systemPrompt.trim(), MAX_SYSTEM_LENGTH);
  }
  return body;
}

export function resolveSystemPrompt(project) {
  const s = project && project.systemPrompt;
  if (!s || s.enabled !== true) return { value: null, error: '' };
  const t = String(s.text == null ? '' : s.text).trim();
  if (!t) return { value: null, error: '' };
  if (t.length > MAX_SYSTEM_LENGTH) {
    return { value: null, error: '系统指令超过 4000 字，请先精简后再发送。' };
  }
  return { value: t, error: '' };
}

export function matchPresetId(text) {
  for (let i = 0; i < PRESETS.length; i++) if (PRESETS[i].text === text) return PRESETS[i].id;
  return null;
}
