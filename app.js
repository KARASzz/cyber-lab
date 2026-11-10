/* ============================================================
 * NEON//CHAT · 前端交互逻辑
 * 纯原生 JS，零依赖、零构建、零外部资源；所有请求走同源相对路径。
 *
 * 接口契约：
 *   POST /api/chat
 *   body: {
 *     messages: [{ role: 'user'|'assistant', content: '...' }],
 *     systemPrompt?: '当前项目启用且非空时才携带'   // 可选字段
 *   }
 *   SSE: data: {"delta":"增量"} / data: [DONE] / data: {"error":"..."}
 *
 * 持久化：localStorage['cyberchat.v1']（单 key，含版本号与异常兜底）
 * 安全：用户与助手文本一律通过 textContent / Text 节点写入；
 *       innerHTML 仅用于本文件内硬编码的静态 SVG 常量。
 * ============================================================ */

(function (root) {
  'use strict';

  /* ----------------------------------------------------------
   * 1. 配置常量（接口地址集中在此，改路径只需改这一处）
   * -------------------------------------------------------- */
  const CHAT_API = '/api/chat';
  const STORAGE_KEY = 'cyberchat.v1';
  const DATA_VERSION = 1;

  const MAX_INPUT_LENGTH = 4000;
  const MAX_SYSTEM_LENGTH = 4000;
  const STALL_TIMEOUT_MS = 120000;   // 120 秒无新数据兜底超时
  const NEAR_BOTTOM_THRESHOLD = 120;
  const MAX_TEXTAREA_HEIGHT = 190;

  /* 与后端校验（60 条 / 60000 字符 / 单条 8000）对齐并留余量 */
  const MAX_HISTORY_MESSAGES = 40;
  const MAX_HISTORY_CHARS = 50000;
  const MAX_MESSAGE_CHARS = 8000;

  /* 本地数据结构上限，防止异常数据撑爆存储 */
  const MAX_PROJECTS = 50;
  const MAX_SESSIONS = 100;
  const MAX_STORED_MESSAGES = 200;

  /* 离线自测开关：仅在测试宿主注入时生效，生产环境无任何导出 */
  const SELFTEST = !!(root && root.__CYBERCHAT_SELFTEST__);

  const Decoder = (typeof TextDecoder !== 'undefined')
    ? TextDecoder
    : (root && root.TextDecoder ? root.TextDecoder : null);
  const Encoder = (typeof TextEncoder !== 'undefined')
    ? TextEncoder
    : (root && root.TextEncoder ? root.TextEncoder : null);

  /* ----------------------------------------------------------
   * 2. 预设模板（项目级系统指令）
   * -------------------------------------------------------- */
  const PRESETS = [
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

  /* 静态内联 SVG 常量（不含任何用户数据，可安全用于 innerHTML） */
  const ICONS = {
    chevron: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>',
    plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
    pencil: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 2.5l2 2-8 8-2.5.5.5-2.5 8-8z"/></svg>',
    trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8M6.7 7v3.5M9.3 7v3.5"/></svg>',
    spark: '<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M16 3.5l2.9 8.6 8.6 2.9-8.6 2.9L16 26.5l-2.9-8.6L4.5 15l8.6-2.9L16 3.5z" fill="currentColor"/><circle cx="25" cy="6.5" r="2" fill="currentColor" opacity=".75"/></svg>',
    alert: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 6.5v4.2M10 13.6v.1"/></svg>',
    retry: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16.5 9A6.5 6.5 0 104.5 11"/><path d="M16.5 4.5V9H12"/></svg>',
  };

  /* ----------------------------------------------------------
   * 3. 纯函数核心（不依赖 DOM，可离线自测）
   * -------------------------------------------------------- */
  function uid() {
    try {
      if (root && root.crypto && typeof root.crypto.randomUUID === 'function') {
        return root.crypto.randomUUID();
      }
    } catch (_) { /* 降级到时间戳随机串 */ }
    return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }

  function clampText(value, max) {
    return String(value == null ? '' : value).slice(0, max);
  }

  function makeSession(title) {
    const t = Date.now();
    return {
      id: uid(),
      title: clampText(title || '新会话', 60),
      createdAt: t,
      updatedAt: t,
      messages: [],
    };
  }

  function makeProject(name) {
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

  function defaultState() {
    const p = makeProject('默认项目');
    return { version: DATA_VERSION, activeProjectId: p.id, projects: [p] };
  }

  /* 数据版本 + 异常 JSON 兜底：任何非法结构都收敛为可用状态 */
  function normalizeState(raw) {
    let data = raw;
    if (typeof raw === 'string') {
      try { data = JSON.parse(raw); } catch (_) { return defaultState(); }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return defaultState();
    const srcProjects = Array.isArray(data.projects) ? data.projects.slice(0, MAX_PROJECTS) : null;
    if (!srcProjects) return defaultState();

    const seenP = Object.create(null);
    const projects = [];

    for (let i = 0; i < srcProjects.length; i++) {
      const p = srcProjects[i];
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
      let pid = (typeof p.id === 'string' && p.id) ? p.id : uid();
      if (seenP[pid]) pid = uid();
      seenP[pid] = 1;

      const sys = (p.systemPrompt && typeof p.systemPrompt === 'object' && !Array.isArray(p.systemPrompt))
        ? p.systemPrompt : {};
      const systemPrompt = {
        enabled: sys.enabled === true,
        text: clampText(typeof sys.text === 'string' ? sys.text : '', MAX_SYSTEM_LENGTH),
        presetId: typeof sys.presetId === 'string' ? sys.presetId : null,
      };

      const seenS = Object.create(null);
      const sessions = [];
      const srcSessions = Array.isArray(p.sessions) ? p.sessions.slice(0, MAX_SESSIONS) : [];
      for (let j = 0; j < srcSessions.length; j++) {
        const s = srcSessions[j];
        if (!s || typeof s !== 'object' || Array.isArray(s)) continue;
        let sid = (typeof s.id === 'string' && s.id) ? s.id : uid();
        if (seenS[sid]) sid = uid();
        seenS[sid] = 1;

        const messages = [];
        const srcMessages = Array.isArray(s.messages) ? s.messages.slice(-MAX_STORED_MESSAGES) : [];
        for (let k = 0; k < srcMessages.length; k++) {
          const m = srcMessages[k];
          if (!m || typeof m !== 'object' || Array.isArray(m)) continue;
          if (m.role !== 'user' && m.role !== 'assistant') continue;
          const content = clampText(typeof m.content === 'string' ? m.content : '', MAX_MESSAGE_CHARS);
          if (!content.trim()) continue;   // 后端拒绝纯空白 content，本地同样过滤
          messages.push({
            role: m.role,
            content: content,
            ts: Number(m.ts) || Date.now(),
            stopped: m.stopped === true,
          });
        }
        const sc = Number(s.createdAt) || Date.now();
        sessions.push({
          id: sid,
          title: clampText(typeof s.title === 'string' && s.title ? s.title : '新会话', 60),
          createdAt: sc,
          updatedAt: Number(s.updatedAt) || sc,
          messages: messages,
        });
      }

      let activeSessionId = typeof p.activeSessionId === 'string' ? p.activeSessionId : '';
      let hasActive = false;
      for (let j = 0; j < sessions.length; j++) if (sessions[j].id === activeSessionId) { hasActive = true; break; }
      if (!hasActive) activeSessionId = sessions.length ? sessions[0].id : '';

      const pc = Number(p.createdAt) || Date.now();
      projects.push({
        id: pid,
        name: clampText(typeof p.name === 'string' && p.name ? p.name : '未命名项目', 60),
        createdAt: pc,
        updatedAt: Number(p.updatedAt) || pc,
        systemPrompt: systemPrompt,
        activeSessionId: activeSessionId,
        sessions: sessions,
      });
    }

    if (!projects.length) return defaultState();
    let activeProjectId = typeof data.activeProjectId === 'string' ? data.activeProjectId : '';
    let hasActive = false;
    for (let i = 0; i < projects.length; i++) if (projects[i].id === activeProjectId) { hasActive = true; break; }
    if (!hasActive) activeProjectId = projects[0].id;

    /* 版本不匹配但结构可用 → 就地迁移到当前版本 */
    return { version: DATA_VERSION, activeProjectId: activeProjectId, projects: projects };
  }

  /* 存储适配层：store 可注入，便于 mock 自测；localStorage 不可用时静默降级 */
  function createStorage(store) {
    let target = store;
    if (target === undefined) {
      try { target = (typeof localStorage !== 'undefined') ? localStorage : null; }
      catch (_) { target = null; }
    }
    return {
      load: function () {
        if (!target) return { ok: false, state: defaultState(), fresh: true, reason: 'unavailable' };
        let raw;
        try { raw = target.getItem(STORAGE_KEY); }
        catch (_) { return { ok: false, state: defaultState(), fresh: true, reason: 'read-error' }; }
        if (raw === null || raw === undefined || raw === '') {
          return { ok: true, state: defaultState(), fresh: true };
        }
        return { ok: true, state: normalizeState(raw), fresh: false };
      },
      save: function (state) {
        if (!target) return false;
        try { target.setItem(STORAGE_KEY, JSON.stringify(state)); return true; }
        catch (_) { return false; }
      },
    };
  }

  /* 历史裁剪：≤40 条 / ≤50000 字符 / 单条 ≤8000 / 首条必为 user */
  function trimHistory(history) {
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
  function buildRequestBody(history, systemPrompt) {
    const body = { messages: trimHistory(history) };
    if (typeof systemPrompt === 'string' && systemPrompt.trim() !== '') {
      /* 与后端 normalizeSystemPrompt 一致：按 trim 后内容计算并截断 */
      body.systemPrompt = clampText(systemPrompt.trim(), MAX_SYSTEM_LENGTH);
    }
    return body;
  }

  function resolveSystemPrompt(project) {
    const s = project && project.systemPrompt;
    if (!s || s.enabled !== true) return { value: null, error: '' };
    const t = String(s.text == null ? '' : s.text).trim();
    if (!t) return { value: null, error: '' };
    if (t.length > MAX_SYSTEM_LENGTH) {
      return { value: null, error: '系统指令超过 4000 字，请先精简后再发送。' };
    }
    return { value: t, error: '' };
  }

  function matchPresetId(text) {
    for (let i = 0; i < PRESETS.length; i++) if (PRESETS[i].text === text) return PRESETS[i].id;
    return null;
  }

  function looksLikeMarkup(payload) {
    return /^(<|\{|\[|\s*<!DOCTYPE|\[object )/i.test(payload);
  }

  /* 兼容 delta / delta.content / delta.text / content / text /
     answer / response / message / choices[0].delta.content 等形态 */
  function extractDelta(obj) {
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

  function isSelfContained(payload) {
    if (payload === '[DONE]') return true;
    const first = payload.charAt(0);
    const last = payload.charAt(payload.length - 1);
    if ((first === '{' && last === '}') || (first === '[' && last === ']')) {
      try { JSON.parse(payload); return true; } catch (_) { return false; }
    }
    return false;
  }

  /* ----------------------------------------------------------
   * 4. SSE 解析器（自研，不用 EventSource）
   *    - 跨 chunk 半行留在 buffer；TextDecoder 流式解码处理 UTF-8 拆字
   *    - CRLF 归一；忽略空行 / ':' 心跳注释 / event/id/retry 非 data 字段
   *    - 单行完整 JSON 立即处理（逐字实时渲染）；多行 data 空行后合并
   *    - [DONE] 立即置 finished，之后所有事件一律忽略
   * -------------------------------------------------------- */
  function createSSEParser(onEvent, onChunk) {
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
  function deliverDelta(ctx, delta, generation, activeSessionId) {
    if (!ctx || ctx.gen !== generation || ctx.sessionId !== activeSessionId) return false;
    if (!delta) return false;
    const d = String(delta);
    ctx.content += d;
    if (typeof ctx.append === 'function') ctx.append(d);
    return true;
  }

  /* ----------------------------------------------------------
   * 5. 离线自测导出（仅当宿主显式注入 __CYBERCHAT_SELFTEST__ 时）
   * -------------------------------------------------------- */
  if (SELFTEST) {
    root.CyberChatTest = Object.freeze({
      CHAT_API: CHAT_API,
      STORAGE_KEY: STORAGE_KEY,
      DATA_VERSION: DATA_VERSION,
      MAX_SYSTEM_LENGTH: MAX_SYSTEM_LENGTH,
      STALL_TIMEOUT_MS: STALL_TIMEOUT_MS,
      PRESETS: PRESETS,
      uid: uid,
      defaultState: defaultState,
      makeProject: makeProject,
      makeSession: makeSession,
      normalizeState: normalizeState,
      createStorage: createStorage,
      trimHistory: trimHistory,
      buildRequestBody: buildRequestBody,
      resolveSystemPrompt: resolveSystemPrompt,
      matchPresetId: matchPresetId,
      extractDelta: extractDelta,
      isSelfContained: isSelfContained,
      createSSEParser: createSSEParser,
      deliverDelta: deliverDelta,
      looksLikeMarkup: looksLikeMarkup,
    });
    return;
  }

  if (typeof document === 'undefined' || !document.getElementById) return;

  /* ==========================================================
   * 6. DOM 应用层
   * ======================================================== */
  const $ = function (id) { return document.getElementById(id); };
  const els = {
    fxCanvas: $('fx-canvas'),
    menuBtn: $('menu-btn'),
    sidebar: $('sidebar'),
    sidebarClose: $('sidebar-close'),
    sidebarOverlay: $('sidebar-overlay'),
    newProjectBtn: $('new-project-btn'),
    projectList: $('project-list'),
    storageStatus: $('storage-status'),
    linkStatus: $('link-status'),
    sysBadge: $('sys-badge'),
    sysBadgeText: $('sys-badge-text'),
    topbarClock: $('topbar-clock'),
    headProject: $('head-project'),
    headSession: $('head-session'),
    headSysChip: $('head-sys-chip'),
    headSysChipText: $('head-sys-chip-text'),
    newSessionBtn: $('new-session-btn'),
    scroller: $('scroller'),
    messages: $('messages'),
    emptyState: $('empty-state'),
    emptySub: $('empty-sub'),
    suggestions: $('suggestions'),
    scrollBottomBtn: $('scroll-bottom-btn'),
    composer: $('composer'),
    input: $('input'),
    charCount: $('char-count'),
    composerMode: $('composer-mode'),
    sendBtn: $('send-btn'),
    sysOverlay: $('sys-overlay'),
    sysPanel: $('sys-panel'),
    sysClose: $('sys-close'),
    sysEnabled: $('sys-enabled'),
    presetList: $('preset-list'),
    sysCount: $('sys-count'),
    sysInput: $('sys-input'),
    sysWarn: $('sys-warn'),
    sysSaveState: $('sys-save-state'),
    sysDone: $('sys-done'),
    modalOverlay: $('modal-overlay'),
    modalEyebrow: $('modal-eyebrow'),
    modalTitle: $('modal-title'),
    modalDesc: $('modal-desc'),
    modalInputWrap: $('modal-input-wrap'),
    modalInput: $('modal-input'),
    modalCancel: $('modal-cancel'),
    modalConfirm: $('modal-confirm'),
  };

  class ChatError extends Error {
    constructor(title, detail) {
      super(detail || title);
      this.name = 'ChatError';
      this.title = title;
      this.detail = detail || '';
    }
  }

  function createEl(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function iconNode(name) {
    const span = createEl('span', 'ico');
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = ICONS[name] || '';
    return span;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function formatTime(ts) {
    const d = new Date(Number(ts) || Date.now());
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function findProject(id) {
    for (let i = 0; i < data.projects.length; i++) if (data.projects[i].id === id) return data.projects[i];
    return null;
  }
  function presetLabel(id) {
    for (let i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i].name;
    return '自定义';
  }

  /* ---------------- 状态 ---------------- */
  let storage = createStorage();
  const loadResult = storage.load();
  let data = loadResult.state;

  const rt = {
    generation: 0,          // 会话世代：切换项目/会话即 +1，旧请求全部失效
    streaming: false,
    run: null,              // 当前流式请求上下文
    stickToBottom: true,
    scrollRaf: null,
    saveTimer: null,
    sysSaveTimer: null,
    sysFlashTimer: null,
    expanded: Object.create(null),
    modal: null,
    sysProjectId: null,
    storageOk: loadResult.ok,
  };
  rt.expanded[data.activeProjectId] = true;

  function currentProject() {
    return findProject(data.activeProjectId) || data.projects[0] || null;
  }
  function currentSession() {
    const p = currentProject();
    if (!p) return null;
    for (let i = 0; i < p.sessions.length; i++) if (p.sessions[i].id === p.activeSessionId) return p.sessions[i];
    return p.sessions[0] || null;
  }
  function currentSessionId() {
    const s = currentSession();
    return s ? s.id : '';
  }
  function sysTargetProject() {
    return findProject(rt.sysProjectId) || currentProject();
  }

  function setStorageStatus(ok) {
    if (!els.storageStatus) return;
    els.storageStatus.textContent = ok ? '本地存储 · 就绪' : '存储不可用 · 仅本次有效';
    const dot = els.storageStatus.parentNode && els.storageStatus.parentNode.querySelector('.mini-dot');
    if (dot) dot.classList.toggle('is-error', !ok);
  }
  function save() {
    const ok = storage.save(data);
    if (ok !== rt.storageOk) { rt.storageOk = ok; setStorageStatus(ok); }
    return ok;
  }
  function saveSoon() {
    clearTimeout(rt.saveTimer);
    rt.saveTimer = setTimeout(save, 220);
  }

  /* ---------------- 侧栏渲染 ---------------- */
  function makeActionBtn(action, icon, label, projectId, extraClass) {
    const b = createEl('button', 'pa-btn' + (extraClass ? ' ' + extraClass : ''));
    b.type = 'button';
    b.setAttribute('data-action', action);
    b.setAttribute('data-project-id', projectId);
    b.setAttribute('aria-label', label);
    b.title = label;
    b.appendChild(iconNode(icon));
    b.appendChild(createEl('span', null, label));
    return b;
  }

  function renderSidebar() {
    const frag = document.createDocumentFragment();

    if (!data.projects.length) {
      const box = createEl('div', 'empty-projects');
      box.appendChild(createEl('strong', null, '暂无项目'));
      box.appendChild(document.createTextNode('点击上方「新建项目」创建你的第一个工作区。'));
      frag.appendChild(box);
    }

    for (let i = 0; i < data.projects.length; i++) {
      const p = data.projects[i];
      const active = p.id === data.activeProjectId;
      const open = !!rt.expanded[p.id];
      const card = createEl('div', 'project-card' + (active ? ' is-active' : '') + (open ? ' is-open' : ''));
      card.setAttribute('data-project-id', p.id);

      const main = createEl('button', 'project-main');
      main.type = 'button';
      main.setAttribute('data-action', 'switch-project');
      main.setAttribute('data-project-id', p.id);
      main.setAttribute('aria-expanded', open ? 'true' : 'false');
      const chev = iconNode('chevron');
      chev.className = 'ico project-chevron';
      main.appendChild(chev);
      main.appendChild(createEl('span', 'project-name', p.name));
      if (p.systemPrompt.enabled && p.systemPrompt.text.trim()) {
        const flag = createEl('span', 'project-sys-flag');
        flag.title = '已启用系统指令';
        main.appendChild(flag);
      }
      main.appendChild(createEl('span', 'project-count', String(p.sessions.length)));
      card.appendChild(main);

      const actions = createEl('div', 'project-actions');
      actions.appendChild(makeActionBtn('new-session', 'plus', '新会话', p.id, 'is-accent'));
      actions.appendChild(makeActionBtn('rename-project', 'pencil', '重命名', p.id));
      actions.appendChild(makeActionBtn('delete-project', 'trash', '删除', p.id, 'is-danger'));
      card.appendChild(actions);

      if (open) {
        const list = createEl('div', 'session-list');
        if (!p.sessions.length) {
          const empty = createEl('div', 'empty-projects');
          empty.appendChild(createEl('strong', null, '空项目'));
          empty.appendChild(document.createTextNode('该项目下还没有会话，点击「新会话」开始。'));
          list.appendChild(empty);
        }
        for (let j = 0; j < p.sessions.length; j++) {
          const s = p.sessions[j];
          const isActive = active && p.activeSessionId === s.id;
          const row = createEl('div', 'session-row' + (isActive ? ' is-active' : ''));
          row.setAttribute('data-session-id', s.id);

          const sb = createEl('button', 'session-main');
          sb.type = 'button';
          sb.setAttribute('data-action', 'switch-session');
          sb.setAttribute('data-project-id', p.id);
          sb.setAttribute('data-session-id', s.id);
          sb.appendChild(createEl('span', 'session-bullet'));
          sb.appendChild(createEl('span', 'session-title', s.title));
          sb.appendChild(createEl('span', 'session-msgcount', String(s.messages.length)));
          row.appendChild(sb);

          const del = createEl('button', 'session-del');
          del.type = 'button';
          del.setAttribute('data-action', 'delete-session');
          del.setAttribute('data-project-id', p.id);
          del.setAttribute('data-session-id', s.id);
          del.setAttribute('aria-label', '删除会话');
          del.title = '删除会话';
          del.innerHTML = ICONS.trash;
          row.appendChild(del);
          list.appendChild(row);
        }
        card.appendChild(list);
      }
      frag.appendChild(card);
    }
    els.projectList.replaceChildren(frag);
  }

  /* ---------------- 顶栏 / 头栏渲染 ---------------- */
  function renderHeader() {
    const p = currentProject();
    const s = currentSession();
    const sysOn = !!(p && p.systemPrompt.enabled && p.systemPrompt.text.trim());
    const modeName = p ? presetLabel(p.systemPrompt.presetId) : '自定义';

    els.headProject.textContent = 'PROJECT // ' + (p ? p.name : '--');
    els.headSession.textContent = s ? s.title : '无会话';

    els.headSysChipText.textContent = sysOn ? ('指令 · ' + modeName) : '指令关闭';
    els.headSysChip.classList.toggle('is-on', sysOn);
    els.sysBadgeText.textContent = sysOn ? '指令模式 · 已启用' : '指令模式 · 关闭';
    els.sysBadge.classList.toggle('is-on', sysOn);
    els.composerMode.textContent = sysOn ? 'DIRECTIVE ON' : 'STANDARD';
    els.composerMode.classList.toggle('is-on', sysOn);
    els.emptySub.textContent = sysOn
      ? '当前项目已启用系统指令模式，助手将按「' + modeName + '」的角色设定回应。可在顶栏修改。'
      : '在下方输入你的第一条指令。当前项目未启用系统指令模式，可在顶栏开启。';
  }

  /* ---------------- 轻量 Markdown 渲染（全 DOM 节点，无 innerHTML 用户数据） ---------------- */
  function isBlockStart(line) {
    return /^\s*```/.test(line) ||
           /^#{1,6}\s+/.test(line) ||
           /^\s*([-*+]|\d+[.)])\s+/.test(line) ||
           /^\s*([-*_])\1{2,}\s*$/.test(line);
  }

  function renderInline(text, parent) {
    const s = String(text == null ? '' : text);
    const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
    let last = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(s.slice(last, m.index)));
      if (m[1] !== undefined) parent.appendChild(createEl('code', 'md-code-inline', m[1]));
      else if (m[2] !== undefined) parent.appendChild(createEl('strong', 'md-strong', m[2]));
      last = re.lastIndex;
    }
    if (last < s.length) parent.appendChild(document.createTextNode(s.slice(last)));
  }

  async function copyText(text, btn) {
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (_) { /* 降级 */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      } catch (_) { /* 忽略 */ }
    }
    btn.textContent = ok ? '已复制' : '复制失败';
    setTimeout(function () { btn.textContent = '复制'; }, 1600);
  }

  function buildCodeBlock(code, lang) {
    const box = createEl('div', 'code-block');
    const head = createEl('div', 'code-head');
    head.appendChild(createEl('span', 'code-lang', lang || 'text'));
    const btn = createEl('button', 'btn-copy', '复制');
    btn.type = 'button';
    btn.setAttribute('aria-label', '复制代码');
    btn.addEventListener('click', function () { copyText(code, btn); });
    head.appendChild(btn);
    const pre = createEl('pre', 'code-pre');
    pre.appendChild(createEl('code', null, code));
    box.append(head, pre);
    return box;
  }

  function renderMarkdown(text, container) {
    container.replaceChildren();
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      const fence = /^\s*```\s*([^\s`]*)\s*$/.exec(line);
      if (fence) {
        const lang = fence[1] || 'text';
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < lines.length) i++;
        container.appendChild(buildCodeBlock(buf.join('\n'), lang));
        continue;
      }
      if (!line.trim()) { i++; continue; }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
        container.appendChild(createEl('hr', 'md-hr'));
        i++;
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        const h = createEl('h' + heading[1].length, 'md-h');
        renderInline(heading[2], h);
        container.appendChild(h);
        i++;
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const list = createEl(ordered ? 'ol' : 'ul', 'md-list');
        let guard = 0;
        while (i < lines.length && guard < 200) {
          const mm = ordered
            ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i])
            : /^\s*[-*+]\s+(.*)$/.exec(lines[i]);
          if (!mm) break;
          const li = createEl('li');
          renderInline(mm[1], li);
          list.appendChild(li);
          i++;
          guard++;
        }
        container.appendChild(list);
        continue;
      }

      const para = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      const p = createEl('p', 'md-p');
      for (let k = 0; k < para.length; k++) {
        if (k) p.appendChild(document.createElement('br'));
        renderInline(para[k], p);
      }
      container.appendChild(p);
    }
  }

  /* ---------------- 消息渲染 ---------------- */
  function buildUserMessage(m) {
    const wrap = createEl('div', 'msg user');
    const body = createEl('div', 'msg-body');
    body.appendChild(createEl('div', 'msg-label', 'YOU // 指令'));
    const bubble = createEl('div', 'bubble');
    bubble.textContent = m.content;
    body.appendChild(bubble);
    body.appendChild(createEl('div', 'msg-time', formatTime(m.ts)));
    wrap.appendChild(body);
    return wrap;
  }

  function buildAssistantMessage(m) {
    const wrap = createEl('div', 'msg assistant' + (m.stopped ? ' stopped' : ''));
    const avatar = createEl('span', 'msg-avatar');
    avatar.setAttribute('aria-hidden', 'true');
    avatar.innerHTML = ICONS.spark;
    const body = createEl('div', 'msg-body');
    body.appendChild(createEl('div', 'msg-label', 'NEON // 助手'));
    const bubble = createEl('div', 'bubble md-rendered');
    renderMarkdown(m.content, bubble);
    body.appendChild(bubble);
    if (m.stopped) body.appendChild(createEl('span', 'stopped-tag', '// 生成已中断'));
    body.appendChild(createEl('div', 'msg-time', formatTime(m.ts)));
    wrap.append(avatar, body);
    return wrap;
  }

  function renderMessages() {
    const s = currentSession();
    const list = s ? s.messages : [];
    const frag = document.createDocumentFragment();
    for (let i = 0; i < list.length; i++) {
      frag.appendChild(list[i].role === 'user' ? buildUserMessage(list[i]) : buildAssistantMessage(list[i]));
    }
    els.messages.replaceChildren(frag);
    if (!list.length) {
      els.emptyState.hidden = false;
      els.messages.hidden = true;
    } else {
      els.emptyState.hidden = true;
      els.messages.hidden = false;
    }
    scrollToBottom(true, false);
  }

  function renderAll() {
    renderSidebar();
    renderHeader();
    renderMessages();
    updateScrollButton();
  }

  function revealConversation() {
    els.emptyState.hidden = true;
    els.messages.hidden = false;
  }

  /* ---------------- 流式消息 DOM ---------------- */
  function createStreamingAssistant() {
    const wrap = createEl('div', 'msg assistant is-incomplete');
    const avatar = createEl('span', 'msg-avatar');
    avatar.setAttribute('aria-hidden', 'true');
    avatar.innerHTML = ICONS.spark;
    const body = createEl('div', 'msg-body');
    body.appendChild(createEl('div', 'msg-label', 'NEON // 助手 · 生成中'));
    const bubble = createEl('div', 'bubble');
    const typing = createEl('span', 'typing');
    typing.setAttribute('aria-hidden', 'true');
    typing.innerHTML = '<i></i><i></i><i></i>';
    const textNode = document.createTextNode('');
    const cursor = createEl('span', 'stream-cursor');
    cursor.setAttribute('aria-hidden', 'true');
    cursor.hidden = true;
    bubble.append(typing, textNode, cursor);
    body.appendChild(bubble);
    wrap.append(avatar, body);
    els.messages.appendChild(wrap);
    return { wrap: wrap, bubble: bubble, typing: typing, textNode: textNode, cursor: cursor };
  }

  function appendStreamDelta(a, delta) {
    if (a.typing && a.typing.parentNode) { a.typing.remove(); a.typing = null; }
    if (a.cursor) a.cursor.hidden = false;
    a.textNode.appendData(delta);
    scheduleAutoScroll();
  }

  function finalizeAssistant(a) {
    if (a.typing && a.typing.parentNode) { a.typing.remove(); a.typing = null; }
    if (a.cursor) { a.cursor.remove(); a.cursor = null; }
  }

  function appendErrorBubble(title, detail, withRetry) {
    const wrap = createEl('div', 'msg assistant error is-ephemeral');
    const avatar = createEl('span', 'msg-avatar is-error');
    avatar.setAttribute('aria-hidden', 'true');
    avatar.innerHTML = ICONS.alert;
    const body = createEl('div', 'msg-body');
    body.appendChild(createEl('div', 'msg-label', '系统提示'));
    const bubble = createEl('div', 'bubble');
    const head = createEl('div', 'error-head');
    head.innerHTML = ICONS.alert;
    head.appendChild(createEl('span', null, title));
    bubble.append(head, createEl('span', 'error-detail', detail));
    if (withRetry) {
      const btn = createEl('button', 'btn-retry');
      btn.type = 'button';
      btn.innerHTML = ICONS.retry;
      btn.appendChild(createEl('span', null, '重试'));
      btn.addEventListener('click', retryLast);
      bubble.appendChild(btn);
    }
    body.appendChild(bubble);
    wrap.append(avatar, body);
    els.messages.appendChild(wrap);
    scheduleAutoScroll();
  }

  /* ---------------- 滚动 ---------------- */
  function distanceFromBottom() {
    return els.scroller.scrollHeight - els.scroller.scrollTop - els.scroller.clientHeight;
  }
  function updateScrollButton() {
    els.scrollBottomBtn.hidden = els.messages.hidden || distanceFromBottom() <= 180;
  }
  function scrollToBottom(force, smooth) {
    if (force || rt.stickToBottom) {
      const top = els.scroller.scrollHeight;
      if (smooth && typeof els.scroller.scrollTo === 'function') {
        els.scroller.scrollTo({ top: top, behavior: 'smooth' });
      } else {
        els.scroller.scrollTop = top;
      }
    }
    updateScrollButton();
  }
  function scheduleAutoScroll() {
    if (rt.scrollRaf) return;
    rt.scrollRaf = requestAnimationFrame(function () {
      rt.scrollRaf = null;
      scrollToBottom(false, false);
    });
  }

  /* ---------------- 输入区 ---------------- */
  function autoResize() {
    els.input.style.height = 'auto';
    els.input.style.height = Math.min(els.input.scrollHeight, MAX_TEXTAREA_HEIGHT) + 'px';
  }
  function updateCharCount() {
    const n = els.input.value.length;
    els.charCount.textContent = n + ' / ' + MAX_INPUT_LENGTH;
    els.charCount.classList.toggle('is-near-limit', n > MAX_INPUT_LENGTH * 0.9);
  }
  function updateSendButton() {
    els.sendBtn.disabled = !rt.streaming && els.input.value.trim().length === 0;
  }
  function setStreaming(on) {
    rt.streaming = on;
    els.input.disabled = on;
    els.composer.classList.toggle('is-streaming', on);
    els.sendBtn.classList.toggle('is-busy', on);
    const iconSend = els.sendBtn.querySelector('.icon-send');
    const iconStop = els.sendBtn.querySelector('.icon-stop');
    if (iconSend) iconSend.hidden = on;
    if (iconStop) iconStop.hidden = !on;
    els.sendBtn.setAttribute('aria-label', on ? '停止生成' : '发送消息');
    els.sendBtn.title = on ? '停止生成' : '发送消息';
    if (els.linkStatus) els.linkStatus.textContent = on ? '神经链路 · 传输中' : '神经链路 · 已连接';
    updateSendButton();
  }

  /* ---------------- 请求 / 流式消费 ---------------- */
  function abortCtx(ctx) {
    if (ctx && ctx.controller) {
      try { ctx.controller.abort(); } catch (_) { /* 忽略 */ }
    }
  }

  function armStallTimeout(ctx) {
    clearTimeout(ctx.timeoutId);
    ctx.timeoutId = setTimeout(function () {
      if (ctx.gen !== rt.generation) return;
      ctx.timedOut = true;
      abortCtx(ctx);
    }, STALL_TIMEOUT_MS);
  }

  async function readErrorDetail(res) {
    try {
      const raw = await res.text();
      if (!raw) return '服务端未返回错误详情。';
      try {
        const obj = JSON.parse(raw);
        const msg = obj && (obj.error || obj.message || obj.detail);
        return String(msg || raw).slice(0, 400);
      } catch (_) {
        const plain = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        return (plain || '服务端未返回错误详情。').slice(0, 400);
      }
    } catch (_) {
      return '无法读取错误详情。';
    }
  }

  function processEvent(payload, ctx) {
    if (ctx.gen !== rt.generation) return;
    /* 服务端约 5s 发送一次空 delta 心跳：任何事件（含空 delta）都重置 120s 兜底计时 */
    armStallTimeout(ctx);
    let obj;
    try { obj = JSON.parse(payload); }
    catch (_) {
      if (!looksLikeMarkup(payload)) {
        deliverDelta(ctx, payload, rt.generation, currentSessionId());
      } else if (window.console && console.warn) {
        console.warn('[chat] 已忽略无法解析的 data 行：', payload.slice(0, 120));
      }
      return;
    }
    if (obj && typeof obj === 'object') {
      if (obj.error !== undefined && obj.error !== null && obj.error !== '') {
        const msg = typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error);
        throw new ChatError('服务返回错误', String(msg).slice(0, 400));
      }
      const d = extractDelta(obj);
      if (d) deliverDelta(ctx, d, rt.generation, currentSessionId());
      return;
    }
    if (typeof obj === 'string') deliverDelta(ctx, obj, rt.generation, currentSessionId());
  }

  async function consumeStream(body, ctx) {
    const parser = createSSEParser(
      function (payload) { processEvent(payload, ctx); },
      function () { if (ctx.gen === rt.generation) armStallTimeout(ctx); }
    );
    const reader = body.getReader();
    try {
      while (!parser.finished && ctx.gen === rt.generation) {
        const chunk = await reader.read();
        if (chunk.done) break;
        parser.feed(chunk.value);
      }
      if (ctx.gen === rt.generation) parser.finish();
    } finally {
      /* 逐级 abort：reader.cancel() → fetch 的 AbortController → 释放锁 */
      const signal = ctx.controller && ctx.controller.signal;
      const shouldCancel = parser.finished || (signal && signal.aborted) || ctx.gen !== rt.generation;
      try { if (shouldCancel) await reader.cancel(); } catch (_) { /* 忽略 */ }
      try { reader.releaseLock(); } catch (_) { /* 忽略 */ }
    }
  }

  async function consumeWholeText(res, ctx) {
    const raw = await res.text();
    if (!raw || ctx.gen !== rt.generation) return;
    const normalized = raw.replace(/\r\n?/g, '\n');
    if (/^\s*data:/m.test(normalized)) {
      const parser = createSSEParser(function (payload) { processEvent(payload, ctx); }, null);
      if (Encoder) parser.feed(new Encoder().encode(normalized));
      else parser.feed(normalized);
      parser.finish();
      return;
    }
    try {
      processEvent(normalized.trim(), ctx);
    } catch (_) {
      deliverDelta(ctx, normalized.trim(), rt.generation, currentSessionId());
    }
  }

  /* 把已生成的部分文本写回「被切走的旧会话」对象，幂等 */
  function persistPartial(ctx) {
    if (ctx.finalized) return;
    ctx.finalized = true;
    finalizeAssistant(ctx.assistant);
    if (ctx.content.trim()) {
      ctx.session.messages.push({
        role: 'assistant', content: ctx.content, ts: Date.now(), stopped: true,
      });
      ctx.session.updatedAt = Date.now();
      save();
      if (ctx.gen === rt.generation && ctx.assistant.bubble && ctx.assistant.bubble.parentNode) {
        renderMarkdown(ctx.content, ctx.assistant.bubble);
        ctx.assistant.bubble.classList.add('md-rendered');
        ctx.assistant.wrap.classList.remove('is-incomplete');
        ctx.assistant.wrap.classList.add('stopped');
        const label = ctx.assistant.wrap.querySelector('.msg-label');
        if (label) label.textContent = 'NEON // 助手';
      }
    } else if (ctx.assistant.wrap && ctx.assistant.wrap.parentNode) {
      ctx.assistant.wrap.remove();
    }
  }

  async function runChat(rawText, options) {
    const opts = options || {};
    const text = String(rawText == null ? '' : rawText).trim();
    if (!text || rt.streaming) return;

    const project = currentProject();
    const session = currentSession();
    if (!project || !session) return;

    const sys = resolveSystemPrompt(project);
    if (sys.error) {
      revealConversation();
      appendErrorBubble('系统指令不可用', sys.error, false);
      return;
    }

    if (!opts.reuseUser) {
      session.messages.push({ role: 'user', content: text, ts: Date.now() });
      if (session.title === '新会话' || session.title === '新建会话') {
        session.title = clampText(text.replace(/\s+/g, ' '), 24) || '新会话';
      }
      session.updatedAt = Date.now();
      project.updatedAt = Date.now();
      save();
      renderSidebar();
      renderHeader();
      revealConversation();
      els.messages.appendChild(buildUserMessage({ content: text, ts: Date.now() }));
      els.input.value = '';
      autoResize();
      updateCharCount();
    } else {
      revealConversation();
    }

    setStreaming(true);
    rt.stickToBottom = true;
    scrollToBottom(true, false);

    const a = createStreamingAssistant();
    const ctx = {
      gen: rt.generation,
      projectId: project.id,
      sessionId: session.id,
      session: session,                 // 捕获对象引用：始终写回发起请求的那个会话
      systemPrompt: sys.value,
      content: '',
      append: function (d) { appendStreamDelta(a, d); },
      assistant: a,
      controller: null,
      timeoutId: null,
      timedOut: false,
      stoppedByUser: false,
      finalized: false,
    };
    rt.run = ctx;
    ctx.controller = new AbortController();
    armStallTimeout(ctx);

    try {
      const res = await fetch(CHAT_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(buildRequestBody(ctx.session.messages, ctx.systemPrompt)),
        signal: ctx.controller.signal,
        cache: 'no-store',
      });

      if (!res.ok) {
        const detail = await readErrorDetail(res);
        throw new ChatError('服务返回异常（HTTP ' + res.status + '）', detail);
      }

      if (res.body && typeof res.body.getReader === 'function') {
        await consumeStream(res.body, ctx);
      } else {
        await consumeWholeText(res, ctx);
      }

      if (ctx.gen !== rt.generation) return;
      if (ctx.finalized) return;
      finalizeAssistant(a);
      if (!ctx.content.trim()) {
        throw new ChatError('未收到回复内容', '服务已结束响应，但没有返回任何文本，请重试。');
      }
      ctx.finalized = true;
      ctx.session.messages.push({ role: 'assistant', content: ctx.content, ts: Date.now() });
      ctx.session.updatedAt = Date.now();
      project.updatedAt = Date.now();
      save();
      renderMarkdown(ctx.content, a.bubble);
      a.bubble.classList.add('md-rendered');
      a.wrap.classList.remove('is-incomplete');
      const label = a.wrap.querySelector('.msg-label');
      if (label) label.textContent = 'NEON // 助手';
      renderSidebar();
      scrollToBottom(false, false);
    } catch (err) {
      if (ctx.gen !== rt.generation) {
        persistPartial(ctx);      // 旧请求只写回旧会话，不在新会话渲染错误
        return;
      }
      abortCtx(ctx);
      handleFailure(err, ctx);
    } finally {
      clearTimeout(ctx.timeoutId);
      if (ctx.gen === rt.generation) {
        rt.run = null;
        setStreaming(false);
        if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) {
          try { els.input.focus({ preventScroll: true }); } catch (_) { /* 忽略 */ }
        }
      }
    }
  }

  function handleFailure(err, ctx) {
    const aborted = !!err && err.name === 'AbortError';
    let title = '请求失败';
    let detail = '网络连接异常，请稍后重试。';
    if (aborted && ctx.timedOut) {
      title = '请求超时';
      detail = '超过 ' + Math.round(STALL_TIMEOUT_MS / 1000) + ' 秒未收到新内容，连接已中断，请重试。';
    } else if (aborted && ctx.stoppedByUser) {
      title = '已停止生成';
      detail = '你已手动停止本次回答，可以修改问题或点击重试。';
    } else if (aborted) {
      title = '连接已中断';
      detail = '网络或服务端连接意外中断，请重试。';
    } else if (err instanceof ChatError) {
      title = err.title;
      detail = err.detail;
    } else if (err && err.message) {
      detail = String(err.message).slice(0, 300);
    }
    persistPartial(ctx);
    appendErrorBubble(title, detail, true);
  }

  /* ---------------- 交互动作 ---------------- */
  function submitFromInput() {
    if (rt.streaming) return;
    const text = els.input.value.trim();
    if (!text) return;
    runChat(text);
  }

  function stopGeneration() {
    if (!rt.streaming || !rt.run) return;
    rt.run.stoppedByUser = true;
    abortCtx(rt.run);
  }

  function retryLast() {
    if (rt.streaming) return;
    const session = currentSession();
    if (!session) return;
    let idx = -1;
    for (let i = session.messages.length - 1; i >= 0; i--) {
      if (session.messages[i].role === 'user') { idx = i; break; }
    }
    if (idx < 0) return;
    const text = session.messages[idx].content;
    session.messages.length = idx;   // 丢弃最后一次提问之后的失败/中断内容
    session.updatedAt = Date.now();
    save();
    renderMessages();
    rt.stickToBottom = true;
    runChat(text);
  }

  /* 会话世代机制：切换即 +1 并逐级 abort，旧请求增量不再落到新会话 */
  function cancelActiveRun() {
    rt.generation += 1;
    const ctx = rt.run;
    if (ctx) {
      clearTimeout(ctx.timeoutId);
      abortCtx(ctx);
      persistPartial(ctx);
      rt.run = null;
    }
    setStreaming(false);
  }

  function closeSidebar() {
    document.body.classList.remove('sidebar-open');
    els.sidebarOverlay.hidden = true;
    if (els.menuBtn) els.menuBtn.setAttribute('aria-expanded', 'false');
  }
  function toggleSidebar() {
    const opened = document.body.classList.toggle('sidebar-open');
    els.sidebarOverlay.hidden = !opened;
    if (els.menuBtn) els.menuBtn.setAttribute('aria-expanded', opened ? 'true' : 'false');
  }

  function switchProject(pid) {
    if (!findProject(pid)) return;
    if (pid === data.activeProjectId) {
      rt.expanded[pid] = true;   // 点击当前项目只展开，不折叠，保证层级始终可见
      renderSidebar();
      closeSidebar();
      return;
    }
    cancelActiveRun();
    data.activeProjectId = pid;
    rt.expanded[pid] = true;
    save();
    renderAll();
    closeSidebar();
  }

  function switchSession(pid, sid) {
    const p = findProject(pid);
    if (!p) return;
    let exists = false;
    for (let i = 0; i < p.sessions.length; i++) if (p.sessions[i].id === sid) { exists = true; break; }
    if (!exists) return;
    if (pid === data.activeProjectId && p.activeSessionId === sid) { closeSidebar(); return; }
    cancelActiveRun();
    data.activeProjectId = pid;
    p.activeSessionId = sid;
    p.updatedAt = Date.now();
    rt.expanded[pid] = true;
    save();
    renderAll();
    closeSidebar();
  }

  function createProject(name) {
    cancelActiveRun();
    const p = makeProject(name);
    data.projects.unshift(p);
    data.activeProjectId = p.id;
    rt.expanded[p.id] = true;
    save();
    renderAll();
    closeSidebar();
    try { els.input.focus({ preventScroll: true }); } catch (_) { /* 忽略 */ }
  }

  function renameProject(pid) {
    const p = findProject(pid);
    if (!p) return;
    openModal({
      eyebrow: 'RENAME // 重命名',
      title: '重命名项目',
      desc: '项目名称仅保存在本地，可随时修改。',
      confirmText: '保存',
      input: { value: p.name, placeholder: '输入项目名称', maxLength: 60 },
      onConfirm: function (value) {
        p.name = value;
        p.updatedAt = Date.now();
        save();
        renderAll();
        if (rt.sysProjectId === pid) renderPresets();
      },
    });
  }

  function deleteProject(pid) {
    const p = findProject(pid);
    if (!p) return;
    openModal({
      eyebrow: 'DELETE // 危险操作',
      title: '删除项目？',
      desc: '将永久删除「' + p.name + '」及其下 ' + p.sessions.length + ' 个会话的全部消息，此操作无法撤销。',
      confirmText: '确认删除',
      danger: true,
      onConfirm: function () {
        cancelActiveRun();
        data.projects = data.projects.filter(function (x) { return x.id !== pid; });
        if (!data.projects.length) data.projects.push(makeProject('默认项目'));
        if (data.activeProjectId === pid) data.activeProjectId = data.projects[0].id;
        rt.expanded[data.activeProjectId] = true;
        if (rt.sysProjectId === pid) rt.sysProjectId = data.activeProjectId;
        save();
        renderAll();
      },
    });
  }

  function newSession(pid) {
    const p = findProject(pid);
    if (!p) return;
    cancelActiveRun();
    const s = makeSession('新会话');
    p.sessions.unshift(s);
    p.activeSessionId = s.id;
    p.updatedAt = Date.now();
    data.activeProjectId = pid;
    rt.expanded[pid] = true;
    save();
    renderAll();
    closeSidebar();
    try { els.input.focus({ preventScroll: true }); } catch (_) { /* 忽略 */ }
  }

  function deleteSession(pid, sid) {
    const p = findProject(pid);
    if (!p) return;
    let target = null;
    for (let i = 0; i < p.sessions.length; i++) if (p.sessions[i].id === sid) { target = p.sessions[i]; break; }
    if (!target) return;
    openModal({
      eyebrow: 'DELETE // 危险操作',
      title: '删除会话？',
      desc: '将永久删除「' + target.title + '」中的 ' + target.messages.length + ' 条消息，此操作无法撤销。',
      confirmText: '确认删除',
      danger: true,
      onConfirm: function () {
        cancelActiveRun();
        p.sessions = p.sessions.filter(function (x) { return x.id !== sid; });
        if (!p.sessions.length) p.sessions.push(makeSession('新会话'));
        if (p.activeSessionId === sid) p.activeSessionId = p.sessions[0].id;
        p.updatedAt = Date.now();
        save();
        renderAll();
      },
    });
  }

  /* ---------------- 通用弹窗 ---------------- */
  function openModal(cfg) {
    rt.modal = cfg;
    els.modalEyebrow.textContent = cfg.eyebrow || 'CONFIRM // 确认';
    els.modalTitle.textContent = cfg.title || '确认操作';
    if (cfg.desc) { els.modalDesc.textContent = cfg.desc; els.modalDesc.hidden = false; }
    else { els.modalDesc.textContent = ''; els.modalDesc.hidden = true; }
    const hasInput = !!cfg.input;
    els.modalInputWrap.hidden = !hasInput;
    if (hasInput) {
      els.modalInput.value = cfg.input.value || '';
      els.modalInput.placeholder = cfg.input.placeholder || '';
      els.modalInput.maxLength = cfg.input.maxLength || 60;
    }
    els.modalConfirm.textContent = cfg.confirmText || '确定';
    els.modalConfirm.classList.toggle('is-danger', !!cfg.danger);
    els.modalOverlay.hidden = false;
    setTimeout(function () {
      try { (hasInput ? els.modalInput : els.modalConfirm).focus({ preventScroll: true }); }
      catch (_) { /* 忽略 */ }
      if (hasInput) els.modalInput.select();
    }, 30);
  }
  function closeModal() {
    els.modalOverlay.hidden = true;
    rt.modal = null;
  }
  function confirmModal() {
    const cfg = rt.modal;
    if (!cfg) return;
    let value = null;
    if (cfg.input) {
      value = els.modalInput.value.trim().slice(0, cfg.input.maxLength || 60);
      if (!value) { try { els.modalInput.focus(); } catch (_) { /* 忽略 */ } return; }
    }
    closeModal();
    if (cfg.onConfirm) cfg.onConfirm(value);
  }

  /* ---------------- 系统指令抽屉 ---------------- */
  /* 后端按 trim 后内容校验 4000 字，字数口径必须一致：
     正好 4000 通过，4001 拦截；首尾空白不计入，避免误报 */
  function sysEffectiveLength() {
    return els.sysInput.value.trim().length;
  }

  function updateSysUI() {
    const n = sysEffectiveLength();
    const over = n > MAX_SYSTEM_LENGTH;
    els.sysCount.textContent = n + ' / ' + MAX_SYSTEM_LENGTH;
    els.sysCount.classList.toggle('is-over', over);
    els.sysInput.classList.toggle('is-over', over);
    els.sysWarn.hidden = !over;
    if (over) els.sysSaveState.textContent = '超出上限 · 未保存';
  }

  function flashSave(msg) {
    els.sysSaveState.textContent = msg;
    clearTimeout(rt.sysFlashTimer);
    rt.sysFlashTimer = setTimeout(function () {
      if (sysEffectiveLength() <= MAX_SYSTEM_LENGTH) els.sysSaveState.textContent = '已保存';
    }, 1500);
  }

  function renderPresets() {
    const p = sysTargetProject();
    const frag = document.createDocumentFragment();
    for (let i = 0; i < PRESETS.length; i++) {
      const preset = PRESETS[i];
      const active = !!(p && p.systemPrompt.presetId === preset.id);
      const b = createEl('button', 'preset' + (active ? ' is-active' : ''));
      b.type = 'button';
      b.setAttribute('data-preset-id', preset.id);
      b.appendChild(createEl('span', 'preset-name', preset.name));
      b.appendChild(createEl('span', 'preset-desc', preset.desc));
      if (active) b.appendChild(createEl('span', 'preset-tag', 'ACTIVE'));
      frag.appendChild(b);
    }
    els.presetList.replaceChildren(frag);
  }

  function persistSysFromUI() {
    const p = sysTargetProject();
    if (!p) return false;
    const text = els.sysInput.value;
    if (sysEffectiveLength() > MAX_SYSTEM_LENGTH) { updateSysUI(); return false; }
    p.systemPrompt.enabled = !!els.sysEnabled.checked;
    /* 按后端口径存 trim 后的文本：纯空白即视为空、不发 systemPrompt，
       也避免首尾空白占掉 4000 字配额导致刷新后被 normalizeState 截断 */
    p.systemPrompt.text = text.trim();
    p.systemPrompt.presetId = matchPresetId(text.trim());
    p.updatedAt = Date.now();
    /* 指令编辑立即落盘（输入事件本身由 sysSaveTimer 做 300ms 防抖），
       避免切换开关后尚未到防抖时间就关闭页面导致设置丢失 */
    clearTimeout(rt.saveTimer);
    save();
    updateSysUI();
    renderPresets();
    renderHeader();
    renderSidebar();
    flashSave('已保存');
    return true;
  }

  function applyPreset(id) {
    let preset = null;
    for (let i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) { preset = PRESETS[i]; break; }
    const p = sysTargetProject();
    if (!preset || !p) return;
    els.sysInput.value = preset.text;
    els.sysEnabled.checked = true;
    p.systemPrompt.enabled = true;
    p.systemPrompt.text = preset.text;
    p.systemPrompt.presetId = preset.id;
    p.updatedAt = Date.now();
    save();
    updateSysUI();
    renderPresets();
    renderHeader();
    renderSidebar();
    flashSave('模板已套用 · 已启用');
  }

  function openSysPanel() {
    const p = currentProject();
    if (!p) return;
    rt.sysProjectId = p.id;
    els.sysEnabled.checked = !!p.systemPrompt.enabled;
    els.sysInput.value = p.systemPrompt.text || '';
    updateSysUI();
    renderPresets();
    els.sysSaveState.textContent = '已保存';
    els.sysOverlay.hidden = false;
    els.sysPanel.hidden = false;
    closeSidebar();
    setTimeout(function () {
      try { els.sysInput.focus({ preventScroll: true }); } catch (_) { /* 忽略 */ }
    }, 60);
  }

  function closeSysPanel() {
    if (els.sysPanel.hidden) return;
    if (sysEffectiveLength() > MAX_SYSTEM_LENGTH) {
      /* 超限拦截：按后端口径截取 trim 后的前 4000 字再落盘 */
      els.sysInput.value = els.sysInput.value.trim().slice(0, MAX_SYSTEM_LENGTH);
    }
    clearTimeout(rt.sysSaveTimer);
    persistSysFromUI();
    els.sysPanel.hidden = true;
    els.sysOverlay.hidden = true;
    rt.sysProjectId = null;
  }

  /* ---------------- 轻量粒子层 ---------------- */
  function initFx() {
    const canvas = els.fxCanvas;
    if (!canvas || typeof canvas.getContext !== 'function') return;
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduce && reduce.matches) return;
    let ctx2d;
    try { ctx2d = canvas.getContext('2d'); } catch (_) { return; }
    if (!ctx2d) return;
    let w = 0, h = 0, dpr = 1, ps = [], raf = 0, last = 0, alive = true;

    function mk() {
      const r = Math.random();
      return {
        x: Math.random() * w,
        y: Math.random() * h,
        s: Math.random() * 1.6 + 0.5,
        v: Math.random() * 0.22 + 0.06,
        a: Math.random() * 0.4 + 0.1,
        c: r < 0.34 ? '255,43,214' : (r < 0.67 ? '0,240,255' : '155,107,255'),
      };
    }
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      w = canvas.clientWidth || window.innerWidth;
      h = canvas.clientHeight || window.innerHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.max(18, Math.min(46, Math.round(w * h / 30000)));
      ps = [];
      for (let i = 0; i < n; i++) ps.push(mk());
    }
    function frame(t) {
      if (!alive) return;
      raf = requestAnimationFrame(frame);
      if (document.hidden || t - last < 42) return;  // 约 24fps，避免与流式渲染抢帧
      last = t;
      ctx2d.clearRect(0, 0, w, h);
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        p.y -= p.v * 2.2;
        if (p.y < -4) { p.y = h + 4; p.x = Math.random() * w; }
        ctx2d.globalAlpha = p.a;
        ctx2d.fillStyle = 'rgb(' + p.c + ')';
        ctx2d.fillRect(p.x, p.y, p.s, p.s);
      }
      ctx2d.globalAlpha = 1;
    }
    resize();
    window.addEventListener('resize', resize, { passive: true });
    raf = requestAnimationFrame(frame);
    if (reduce && typeof reduce.addEventListener === 'function') {
      reduce.addEventListener('change', function (e) {
        if (e.matches) { alive = false; cancelAnimationFrame(raf); ctx2d.clearRect(0, 0, w, h); }
      });
    }
  }

  /* ---------------- 时钟 ---------------- */
  function tickClock() {
    const d = new Date();
    els.topbarClock.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /* ==========================================================
   * 7. 事件绑定
   * ======================================================== */
  els.input.addEventListener('input', function () {
    autoResize();
    updateCharCount();
    updateSendButton();
  });
  els.input.addEventListener('keydown', function (e) {
    /* 兼容中文输入法：组合输入期间不触发发送 */
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (!rt.streaming) submitFromInput();
    }
  });
  els.sendBtn.addEventListener('click', function () {
    if (rt.streaming) stopGeneration();
    else submitFromInput();
  });
  els.suggestions.addEventListener('click', function (e) {
    const btn = e.target && e.target.closest ? e.target.closest('.suggestion') : null;
    if (!btn || rt.streaming) return;
    const prompt = btn.getAttribute('data-prompt');
    if (!prompt) return;
    els.input.value = prompt;
    autoResize();
    updateCharCount();
    updateSendButton();
    runChat(prompt);
  });
  els.scroller.addEventListener('scroll', function () {
    rt.stickToBottom = distanceFromBottom() <= NEAR_BOTTOM_THRESHOLD;
    updateScrollButton();
  }, { passive: true });
  els.scrollBottomBtn.addEventListener('click', function () {
    rt.stickToBottom = true;
    scrollToBottom(true, true);
  });

  els.newProjectBtn.addEventListener('click', function () {
    openModal({
      eyebrow: 'NEW PROJECT // 新建',
      title: '新建项目',
      desc: '每个项目拥有独立的会话列表与一套系统指令。',
      confirmText: '创建项目',
      input: { value: '', placeholder: '例如：前端重构 / 技术调研', maxLength: 60 },
      onConfirm: createProject,
    });
  });
  els.newSessionBtn.addEventListener('click', function () { newSession(data.activeProjectId); });

  els.projectList.addEventListener('click', function (e) {
    const target = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (!target) return;
    const action = target.getAttribute('data-action');
    const pid = target.getAttribute('data-project-id');
    const sid = target.getAttribute('data-session-id');
    if (action === 'switch-project') switchProject(pid);
    else if (action === 'switch-session') switchSession(pid, sid);
    else if (action === 'new-session') newSession(pid);
    else if (action === 'rename-project') renameProject(pid);
    else if (action === 'delete-project') deleteProject(pid);
    else if (action === 'delete-session') deleteSession(pid, sid);
  });

  els.menuBtn.addEventListener('click', toggleSidebar);
  els.sidebarClose.addEventListener('click', closeSidebar);
  els.sidebarOverlay.addEventListener('click', closeSidebar);

  els.sysBadge.addEventListener('click', openSysPanel);
  els.headSysChip.addEventListener('click', openSysPanel);
  els.sysClose.addEventListener('click', closeSysPanel);
  els.sysDone.addEventListener('click', closeSysPanel);
  els.sysOverlay.addEventListener('click', closeSysPanel);
  els.sysEnabled.addEventListener('change', function () {
    clearTimeout(rt.sysSaveTimer);
    persistSysFromUI();
  });
  els.sysInput.addEventListener('input', function () {
    updateSysUI();                       // 实时字数 n / 4000 与超限提示
    clearTimeout(rt.sysSaveTimer);
    rt.sysSaveTimer = setTimeout(persistSysFromUI, 300);
  });
  els.sysInput.addEventListener('change', function () {
    clearTimeout(rt.sysSaveTimer);
    persistSysFromUI();
  });
  els.presetList.addEventListener('click', function (e) {
    const btn = e.target && e.target.closest ? e.target.closest('[data-preset-id]') : null;
    if (!btn) return;
    applyPreset(btn.getAttribute('data-preset-id'));
  });

  els.modalCancel.addEventListener('click', closeModal);
  els.modalConfirm.addEventListener('click', confirmModal);
  els.modalOverlay.addEventListener('click', function (e) {
    if (e.target === els.modalOverlay) closeModal();
  });
  els.modalInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      confirmModal();
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!els.modalOverlay.hidden) { closeModal(); return; }
    if (!els.sysPanel.hidden) { closeSysPanel(); return; }
    if (document.body.classList.contains('sidebar-open')) closeSidebar();
  });

  window.addEventListener('pagehide', function () {
    clearTimeout(rt.saveTimer);
    save();
  });

  /* ---------------- 初始化 ---------------- */
  setStorageStatus(loadResult.ok);
  if (loadResult.fresh) save();   // 首次访问立即落盘，保证默认项目/会话 id 跨刷新稳定
  renderAll();
  renderPresets();
  autoResize();
  updateCharCount();
  updateSendButton();
  initFx();
  tickClock();
  setInterval(tickClock, 1000);
})((typeof window !== 'undefined') ? window : globalThis);
