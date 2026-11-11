import {
  MAX_INPUT_LENGTH, MAX_SYSTEM_LENGTH, MAX_PROJECTS, MAX_SESSIONS, MAX_STORED_MESSAGES, STORAGE_KEY,
  PRESETS, uid, clampText, makeProject, makeSession, createStorage, buildRequestBody,
  resolveSystemPrompt, matchPresetId,
} from './scripts/core/state.js';
import {
  ChatError, looksLikeMarkup, extractDelta, createSSEParser, deliverDelta,
} from './scripts/core/chat-protocol.js';
import { ICONS, createEl, iconNode, pad2, formatTime } from './scripts/ui/dom.js';
import { copyText, renderMarkdown } from './scripts/ui/markdown.js';
import { closeDialog, focusSafely, openDialog, trapFocus } from './scripts/ui/dialogs.js';
import {
  buildMergedImport, createAnnotationStorage, createUiStorage, createWorkspaceBackup, getSessionAnnotation,
  inspectWorkspaceBackup, LAB_STORAGE_KEY, MAX_BACKUP_BYTES, normalizeAnnotations, normalizeTags, safeFileName, searchWorkspace,
  serializeSessionMarkdown, updateSessionAnnotation,
} from './scripts/core/lab-data.js';
import { commitImportTransaction, recoverImportTransaction } from './scripts/core/import-transaction.js';
import { createRunTelemetry, normalizeRunTelemetry, toDiagnostic } from './scripts/core/telemetry.js';

(function (root) {
  'use strict';

  const CHAT_API = '/api/chat';
  const STALL_TIMEOUT_MS = 120000;
  const NEAR_BOTTOM_THRESHOLD = 120;
  const MAX_TEXTAREA_HEIGHT = 190;
  const Encoder = (typeof TextEncoder !== 'undefined')
    ? TextEncoder
    : (root && root.TextEncoder ? root.TextEncoder : null);

  if (typeof document === 'undefined' || !document.getElementById) return;

  /* ==========================================================
   * 6. DOM 应用层
   * ======================================================== */
  const $ = function (id) { return document.getElementById(id); };
  const els = {
    topbar: $('lab-topbar'),
    chatPanel: document.querySelector('.chat-panel'),
    observeBtn: $('lab-observe-btn'),
    network: $('lab-network'),
    runState: $('lab-run-state'),
    metrics: {
      model: $('lab-metric-model'), route: $('lab-metric-route'), requestId: $('lab-metric-request-id'),
      headers: $('lab-metric-headers'), firstToken: $('lab-metric-first-token'), duration: $('lab-metric-duration'),
      characters: $('lab-metric-characters'), history: $('lab-metric-history'), prompt: $('lab-metric-prompt'),
    },
    announcement: $('lab-announcement'),
    localCount: $('lab-local-count'),
    storageWarning: $('lab-storage-warning'),
    tagsList: $('lab-tags-list'),
    tagInput: $('lab-tag-input'),
    tagAdd: $('lab-tag-add'),
    notes: $('lab-notes'),
    noteStatus: $('lab-note-status'),
    commandBtn: $('lab-command-btn'),
    sidebarSearch: $('lab-sidebar-search'),
    commandDialog: $('lab-command-dialog'),
    commandInput: $('lab-command-input'),
    commandList: $('lab-command-list'),
    commandClose: $('lab-command-close'),
    exportMd: $('lab-export-md'),
    exportJson: $('lab-export-json'),
    importOpen: $('lab-import-open'),
    importDialog: $('lab-import-dialog'),
    importFile: $('lab-import-file'),
    importSummary: $('lab-import-summary'),
    importConfirm: $('lab-import-confirm'),
    importCancel: $('lab-import-cancel'),
    copyDiagnostic: $('lab-copy-diagnostic'),
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

  function findProject(id) {
    for (let i = 0; i < data.projects.length; i++) if (data.projects[i].id === id) return data.projects[i];
    return null;
  }
  function sessionLabel(session) {
    if (!session) return '无实验';
    return session.title === '新会话' || session.title === '新建会话' ? '新实验' : session.title;
  }

  function presetLabel(id) {
    for (let i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i].name;
    return '自定义';
  }

  /* ---------------- 状态 ---------------- */
  function readStorageSnapshot() {
    try { return { chat: localStorage.getItem(STORAGE_KEY), annotations: localStorage.getItem(LAB_STORAGE_KEY) }; }
    catch (_) { return null; }
  }

  const importRecovery = recoverImportTransaction();
  let transactionBlocked = !importRecovery.ok;
  const initialSnapshot = readStorageSnapshot();
  let expectedChat = initialSnapshot?.chat;
  let expectedAnnotations = initialSnapshot?.annotations;
  let storageConflict = false;
  let storage = createStorage();
  const loadResult = storage.load();
  let data = loadResult.state;
  const annotationStorage = createAnnotationStorage();
  const annotationLoad = annotationStorage.load();
  let annotations = annotationLoad.state;
  const annotationWritable = annotationLoad.ok && !transactionBlocked;
  const uiStorage = createUiStorage();
  const uiLoad = uiStorage.load();
  let uiSettings = uiLoad.state;
  const loadedSnapshot = readStorageSnapshot();
  if (!initialSnapshot || !loadedSnapshot) transactionBlocked = true;
  else if (initialSnapshot.chat !== loadedSnapshot.chat || initialSnapshot.annotations !== loadedSnapshot.annotations) storageConflict = true;

  const rt = {
    generation: 0,          // 会话世代：切换项目/会话即 +1，旧请求全部失效
    streaming: false,
    run: null,              // 当前流式请求上下文
    stickToBottom: true,
    scrollRaf: null,
    saveTimer: null,
    sysSaveTimer: null,
    sysFlashTimer: null,
    notesTimer: null,
    pendingNotes: null,
    notesSessionId: null,
    annotationOk: annotationLoad.ok,
    uiOk: uiLoad.ok,
    expanded: Object.create(null),
    modal: null,
    modalTrigger: null,
    sidebarTrigger: null,
    inspectorTrigger: null,
    runState: 'idle',
    recentRuns: Object.create(null),
    commandTrigger: null,
    commandItems: [],
    commandIndex: 0,
    commandTimer: null,
    importTrigger: null,
    importPreview: null,
    importReadToken: 0,
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
    updateStorageWarning();
  }

  function updateStorageWarning() {
    const warnings = [];
    if (storageConflict) warnings.push('其他标签页已更改本地数据，当前页面的修改未保存；请先备份本页，再刷新。');
    if (transactionBlocked) warnings.push('本地存储或导入事务无法安全读取，已暂停写入以保护原有数据。');
    if (!rt.storageOk) warnings.push(loadResult.reason === 'corrupt'
      ? '原有对话数据已损坏，原始内容未覆盖；当前对话仅本次有效。'
      : '对话存储不可用，当前修改仅本次有效。');
    if (!rt.annotationOk) warnings.push(annotationLoad.reason === 'corrupt'
      ? '实验扩展数据已损坏，原始内容未覆盖；笔记仅本次有效。'
      : '实验扩展存储不可用，笔记与观测仅本次有效。');
    if (!rt.uiOk) warnings.push('界面设置不可用或已损坏，原始数据未覆盖。');
    els.storageWarning.textContent = warnings.join(' ');
    els.storageWarning.hidden = warnings.length === 0;
  }

  function canWriteSnapshot() {
    if (transactionBlocked || storageConflict) return false;
    const snapshot = readStorageSnapshot();
    if (!snapshot) { transactionBlocked = true; return false; }
    if (snapshot.chat !== expectedChat || snapshot.annotations !== expectedAnnotations) {
      storageConflict = true;
      return false;
    }
    return true;
  }

  function saveAnnotations() {
    let ok = annotationWritable && canWriteSnapshot();
    if (ok) {
      const expected = JSON.stringify(normalizeAnnotations(annotations));
      ok = annotationStorage.save(annotations);
      if (ok) {
        const snapshot = readStorageSnapshot();
        if (!snapshot) { transactionBlocked = true; ok = false; }
        else if (snapshot.chat !== expectedChat || snapshot.annotations !== expected) { storageConflict = true; ok = false; }
        else expectedAnnotations = snapshot.annotations;
      }
    }
    rt.annotationOk = ok;
    updateStorageWarning();
    return ok;
  }
  const runLabels = {
    idle: '待发起实验',
    connecting: '正在请求 /api/chat',
    streaming: '正在接收观测结果',
    complete: '本次观测已完成',
    stopped: '已由用户中止',
    timeout: '无新数据，已超时',
    error: '本次观测失败',
  };

  function setRunState(state, announce = true) {
    rt.runState = state;
    const label = runLabels[state] || runLabels.idle;
    els.runState.textContent = label;
    els.runState.dataset.state = state;
    if (els.linkStatus) els.linkStatus.textContent = label;
    if (announce && (state === 'connecting' || state === 'complete' || state === 'stopped' || state === 'timeout' || state === 'error')) {
      els.announcement.textContent = label;
    }
  }

  function displayTelemetry(run) {
    const value = run || {};
    const metric = function (input) { return input === null || input === undefined ? '未提供' : String(input); };
    const milliseconds = function (input) { return input === null || input === undefined ? '未提供' : (Math.round(input * 10) / 10) + ' ms'; };
    els.metrics.model.textContent = metric(value.model);
    els.metrics.route.textContent = value.route && value.route !== 'unknown' ? value.route : '未提供';
    els.metrics.requestId.textContent = metric(value.requestId);
    els.metrics.headers.textContent = milliseconds(value.timeToHeadersMs);
    els.metrics.firstToken.textContent = milliseconds(value.timeToFirstTokenMs);
    els.metrics.duration.textContent = milliseconds(value.durationMs);
    els.metrics.characters.textContent = metric(value.characters);
    els.metrics.history.textContent = metric(value.historyMessages);
    els.metrics.prompt.textContent = metric(value.systemPromptCharacters);
    setRunState(value.state || value.outcome || 'idle', false);
  }

  function latestTelemetry(session) {
    if (!session) return null;
    if (rt.run && rt.run.sessionId === session.id) return rt.run.telemetry.snapshot();
    if (rt.recentRuns[session.id]) return rt.recentRuns[session.id];
    const runs = getSessionAnnotation(annotations, session.id).runs;
    for (let i = session.messages.length - 1; i >= 0; i -= 1) {
      const id = session.messages[i].id;
      if (id && Object.hasOwn(runs, id)) return normalizeRunTelemetry(runs[id]);
    }
    return null;
  }

  function renderTelemetry() {
    displayTelemetry(latestTelemetry(currentSession()));
  }

  function finishTelemetry(ctx, outcome, errorCategory) {
    if (ctx.telemetrySaved) return;
    const details = {
      historyMessages: ctx.historyMessages,
      systemPromptCharacters: ctx.systemPromptCharacters,
      errorCategory: errorCategory || null,
    };
    const run = normalizeRunTelemetry(ctx.telemetry.finish(outcome, details));
    ctx.telemetrySaved = true;
    rt.recentRuns[ctx.sessionId] = run;
    if (ctx.content.trim() && ctx.session.messages.some(function (message) { return message.id === ctx.messageId; })) {
      const current = getSessionAnnotation(annotations, ctx.sessionId);
      annotations = updateSessionAnnotation(annotations, ctx.sessionId, {
        runs: { ...current.runs, [ctx.messageId]: run },
      });
      saveAnnotations();
    }
    if (ctx.gen === rt.generation && ctx.sessionId === currentSessionId()) displayTelemetry(run);
  }

  function updateNetworkStatus() {
    const online = navigator.onLine !== false;
    els.network.textContent = online ? '浏览器在线' : '浏览器离线';
    els.network.title = '浏览器网络信号不能证明模型服务可用';
    els.network.classList.toggle('is-offline', !online);
  }

  function save() {
    let ok = canWriteSnapshot();
    if (ok) {
      const expected = JSON.stringify(data);
      ok = storage.save(data);
      if (ok) {
        const snapshot = readStorageSnapshot();
        if (!snapshot) { transactionBlocked = true; ok = false; }
        else if (snapshot.chat !== expected || snapshot.annotations !== expectedAnnotations) { storageConflict = true; ok = false; }
        else expectedChat = snapshot.chat;
      }
    }
    if (ok !== rt.storageOk) { rt.storageOk = ok; setStorageStatus(ok); }
    else if (!ok) updateStorageWarning();
    return ok;
  }
  function saveSoon() {
    clearTimeout(rt.saveTimer);
    rt.saveTimer = setTimeout(save, 220);
  }

  function flushPendingNotes() {
    clearTimeout(rt.notesTimer);
    rt.notesTimer = null;
    const pending = rt.pendingNotes;
    if (!pending) return;
    rt.pendingNotes = null;
    try {
      annotations = updateSessionAnnotation(annotations, pending.sessionId, { notes: pending.text });
      const ok = saveAnnotations();
      if (pending.sessionId === currentSessionId()) {
        els.noteStatus.textContent = ok ? '笔记已保存' : '存储不可用，笔记仅本次有效';
      }
    } catch (error) {
      els.noteStatus.textContent = error.message || '笔记无法保存';
    }
  }

  function renderAnnotations(force = false) {
    const session = currentSession();
    if (!session) {
      els.notes.value = '';
      els.notes.disabled = true;
      els.tagsList.replaceChildren();
      return;
    }
    els.notes.disabled = false;
    const annotation = getSessionAnnotation(annotations, session.id);
    if (force || rt.notesSessionId !== session.id) {
      els.notes.value = annotation.notes;
      rt.notesSessionId = session.id;
    }
    const fragment = document.createDocumentFragment();
    annotation.tags.forEach(function (tag) {
      const item = createEl('span', 'lab-tag');
      item.appendChild(document.createTextNode(tag));
      const remove = createEl('button', null, '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', '删除标签：' + tag);
      remove.addEventListener('click', function () {
        flushPendingNotes();
        const current = getSessionAnnotation(annotations, session.id);
        annotations = updateSessionAnnotation(annotations, session.id, {
          tags: current.tags.filter(function (value) { return value !== tag; }),
        });
        const ok = saveAnnotations();
        els.noteStatus.textContent = ok ? '标签已保存' : '存储不可用，标签仅本次有效';
        renderAnnotations();
      });
      item.appendChild(remove);
      fragment.appendChild(item);
    });
    els.tagsList.replaceChildren(fragment);
    if (!rt.annotationOk) els.noteStatus.textContent = '存储不可用，笔记仅本次有效';
  }

  function addTag() {
    const session = currentSession();
    if (!session) return;
    flushPendingNotes();
    try {
      const current = getSessionAnnotation(annotations, session.id);
      const tags = normalizeTags(current.tags.concat(els.tagInput.value));
      annotations = updateSessionAnnotation(annotations, session.id, { tags: tags });
      const ok = saveAnnotations();
      els.tagInput.value = '';
      els.noteStatus.textContent = ok ? '标签已保存' : '存储不可用，标签仅本次有效';
      renderAnnotations();
    } catch (error) {
      els.noteStatus.textContent = error.message || '标签无效';
      els.announcement.textContent = els.noteStatus.textContent;
    }
  }

  function appendAnswerToNotes(message) {
    const session = currentSession();
    if (!session || !message || !message.content) return false;
    flushPendingNotes();
    const current = getSessionAnnotation(annotations, session.id);
    const separator = current.notes ? '\n\n' : '';
    const next = current.notes + separator + '观测结果 · ' + formatTime(message.ts) + '\n' + message.content;
    if (next.length > 12000) {
      els.noteStatus.textContent = '加入后笔记会超过 12000 字，请先精简笔记或回答。';
      els.announcement.textContent = els.noteStatus.textContent;
      return false;
    }
    annotations = updateSessionAnnotation(annotations, session.id, { notes: next });
    const ok = saveAnnotations();
    els.noteStatus.textContent = ok ? '已加入实验笔记' : '存储不可用，笔记仅本次有效';
    renderAnnotations(true);
    els.announcement.textContent = ok ? '已加入实验笔记' : '笔记仅本次有效，未能保存';
    return ok;
  }

  function removeSessionAnnotations(sessionIds) {
    flushPendingNotes();
    const sessions = { ...annotations.sessions };
    sessionIds.forEach(function (id) { delete sessions[id]; });
    annotations = { version: 1, sessions: sessions };
    saveAnnotations();
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
      actions.appendChild(makeActionBtn('new-session', 'plus', '新实验', p.id, 'is-accent'));
      actions.appendChild(makeActionBtn('rename-project', 'pencil', '重命名', p.id));
      actions.appendChild(makeActionBtn('delete-project', 'trash', '删除', p.id, 'is-danger'));
      card.appendChild(actions);

      if (open) {
        const list = createEl('div', 'session-list');
        if (!p.sessions.length) {
          const empty = createEl('div', 'empty-projects');
          empty.appendChild(createEl('strong', null, '空项目'));
          empty.appendChild(document.createTextNode('该项目下还没有实验，点击「新实验」开始。'));
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
          sb.appendChild(createEl('span', 'session-title', sessionLabel(s)));
          sb.appendChild(createEl('span', 'session-msgcount', String(s.messages.length)));
          row.appendChild(sb);

          const rename = createEl('button', 'session-del');
          rename.type = 'button';
          rename.setAttribute('data-action', 'rename-session');
          rename.setAttribute('data-project-id', p.id);
          rename.setAttribute('data-session-id', s.id);
          rename.setAttribute('aria-label', '重命名实验');
          rename.title = '重命名实验';
          rename.innerHTML = ICONS.pencil;
          row.appendChild(rename);

          const del = createEl('button', 'session-del');
          del.type = 'button';
          del.setAttribute('data-action', 'delete-session');
          del.setAttribute('data-project-id', p.id);
          del.setAttribute('data-session-id', s.id);
          del.setAttribute('aria-label', '删除实验');
          del.title = '删除实验';
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
    els.headSession.textContent = sessionLabel(s);
    els.headSysChipText.textContent = sysOn ? ('协议 · ' + modeName) : '协议关闭';
    els.headSysChip.setAttribute('aria-label', els.headSysChipText.textContent + '，打开实验协议设置');
    els.headSysChip.classList.toggle('is-on', sysOn);
    els.sysBadgeText.textContent = sysOn ? '协议 · 已启用' : '协议 · 关闭';
    els.sysBadge.setAttribute('aria-label', els.sysBadgeText.textContent + '，打开实验协议设置');
    els.sysBadge.classList.toggle('is-on', sysOn);
    els.composerMode.textContent = sysOn ? 'PROTOCOL ON' : 'STANDARD';
    els.composerMode.classList.toggle('is-on', sysOn);
    els.emptySub.textContent = sysOn
      ? '当前项目已启用实验协议「' + modeName + '」。选择卡片或输入问题，开始记录实验。'
      : '选择一张实验卡片或输入问题，开始记录你的第一项实验。';
    els.localCount.textContent = '本地实验：' + data.projects.reduce(function (count, project) {
      return count + project.sessions.length;
    }, 0);
  }

  /* ---------------- 消息渲染 ---------------- */
  function buildUserMessage(m) {
    const wrap = createEl('div', 'msg user');
    const body = createEl('div', 'msg-body');
    body.appendChild(createEl('div', 'msg-label', 'INPUT // 实验输入'));
    const bubble = createEl('div', 'bubble');
    bubble.textContent = m.content;
    body.appendChild(bubble);
    body.appendChild(createEl('div', 'msg-time', formatTime(m.ts)));
    wrap.appendChild(body);
    return wrap;
  }

  function addAnswerActions(body, message) {
    const actions = createEl('div', 'lab-answer-actions');
    const copy = createEl('button', null, '复制观测');
    copy.type = 'button';
    copy.addEventListener('click', function () { copyText(message.content, copy); });
    const note = createEl('button', null, '加入实验笔记');
    note.type = 'button';
    note.setAttribute('aria-label', '加入实验笔记');
    note.addEventListener('click', function () {
      if (appendAnswerToNotes(message)) {
        note.textContent = '已加入';
        setTimeout(function () { note.textContent = '加入实验笔记'; }, 1600);
      }
    });
    actions.append(copy, note);
    body.appendChild(actions);
  }

  function buildAssistantMessage(m) {
    const wrap = createEl('div', 'msg assistant' + (m.stopped ? ' stopped' : ''));
    const avatar = createEl('span', 'msg-avatar');
    avatar.setAttribute('aria-hidden', 'true');
    avatar.innerHTML = ICONS.spark;
    const body = createEl('div', 'msg-body');
    body.appendChild(createEl('div', 'msg-label', 'OBSERVE // 观测结果'));
    const bubble = createEl('div', 'bubble md-rendered');
    renderMarkdown(m.content, bubble, {
      wrapCode: uiSettings.wrapCode,
      onWrapChange: function (enabled) {
        uiSettings = { version: 1, wrapCode: enabled };
        rt.uiOk = uiStorage.save(uiSettings);
        updateStorageWarning();
      },
    });
    body.appendChild(bubble);
    if (m.stopped) body.appendChild(createEl('span', 'stopped-tag', '已中止的观测'));
    body.appendChild(createEl('div', 'msg-time', formatTime(m.ts)));
    addAnswerActions(body, m);
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
    if (currentProject() && rt.sysProjectId !== currentProject().id) loadSysFromProject();
    renderAnnotations();
    renderTelemetry();
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
    body.appendChild(createEl('div', 'msg-label', 'OBSERVE // 观测结果 · 生成中'));
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
      ctx.telemetry.finish('timeout', {
        historyMessages: ctx.historyMessages,
        systemPromptCharacters: ctx.systemPromptCharacters,
      });
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
        ctx.errorCategory = 'stream';
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
    processEvent(normalized.trim(), ctx);
  }

  /* 把已生成的部分文本写回「被切走的旧会话」对象，幂等 */
  function persistPartial(ctx) {
    if (ctx.finalized) return;
    ctx.finalized = true;
    finalizeAssistant(ctx.assistant);
    if (ctx.content.trim()) {
      const partial = { id: ctx.messageId, role: 'assistant', content: ctx.content, ts: Date.now(), stopped: true };
      ctx.session.messages.push(partial);
      ctx.session.updatedAt = Date.now();
      save();
      if (ctx.gen === rt.generation && ctx.assistant.wrap && ctx.assistant.wrap.parentNode) {
        ctx.assistant.wrap.replaceWith(buildAssistantMessage(partial));
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
    if (session.messages.length + (opts.reuseUser ? 1 : 2) > MAX_STORED_MESSAGES) {
      revealConversation();
      appendErrorBubble('实验消息已达上限', '为保留现有记录，请新建实验后继续。', false);
      return;
    }

    if (rt.sysProjectId === project.id && sysEffectiveLength() > MAX_SYSTEM_LENGTH) {
      updateSysUI();
      revealConversation();
      appendErrorBubble('实验协议不可用', '实验协议超过 4000 字，请先精简后再发送。', false);
      els.announcement.textContent = '实验协议超过 4000 字，无法发送。';
      return;
    }
    flushPendingSys();
    const sys = resolveSystemPrompt(project);
    if (sys.error) {
      revealConversation();
      appendErrorBubble('系统指令不可用', sys.error, false);
      return;
    }

    if (!opts.reuseUser) {
      session.messages.push({ id: uid(), role: 'user', content: text, ts: Date.now() });
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
    setRunState('connecting');
    rt.stickToBottom = true;
    scrollToBottom(true, false);

    const a = createStreamingAssistant();
    const requestBody = buildRequestBody(opts.history || session.messages, sys.value);
    const ctx = {
      gen: rt.generation,
      projectId: project.id,
      sessionId: session.id,
      messageId: uid(),
      session: session,
      systemPrompt: sys.value,
      historyMessages: requestBody.messages.length,
      systemPromptCharacters: sys.value ? sys.value.length : 0,
      telemetry: createRunTelemetry(),
      telemetrySaved: false,
      errorCategory: null,
      content: '',
      append: function (d) {
        ctx.telemetry.markToken(d);
        if (rt.runState !== 'streaming') setRunState('streaming');
        displayTelemetry(ctx.telemetry.snapshot());
        appendStreamDelta(a, d);
      },
      assistant: a,
      controller: null,
      timeoutId: null,
      timedOut: false,
      stoppedByUser: false,
      finalized: false,
    };
    rt.run = ctx;
    displayTelemetry(ctx.telemetry.snapshot());
    ctx.controller = new AbortController();
    armStallTimeout(ctx);

    try {
      const res = await fetch(CHAT_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(requestBody),
        signal: ctx.controller.signal,
        cache: 'no-store',
      });

      ctx.telemetry.markHeaders({
        statusCode: res.status,
        route: res.headers.get('X-AI-Route'),
        model: res.headers.get('X-AI-Model'),
        requestId: res.headers.get('X-Request-Id'),
      });
      if (ctx.gen === rt.generation) displayTelemetry(ctx.telemetry.snapshot());
      if (!res.ok) {
        ctx.errorCategory = 'http';
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
        ctx.errorCategory = 'empty_response';
        throw new ChatError('未收到回复内容', '服务已结束响应，但没有返回任何文本，请重试。');
      }
      ctx.finalized = true;
      const resultMessage = { id: ctx.messageId, role: 'assistant', content: ctx.content, ts: Date.now() };
      ctx.session.messages.push(resultMessage);
      ctx.session.updatedAt = Date.now();
      project.updatedAt = Date.now();
      save();
      a.wrap.replaceWith(buildAssistantMessage(resultMessage));
      finishTelemetry(ctx, 'complete');
      setRunState('complete');
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
    const outcome = ctx.timedOut ? 'timeout' : ctx.stoppedByUser ? 'stopped' : 'error';
    finishTelemetry(ctx, outcome, ctx.errorCategory || (aborted ? 'abort' : 'network'));
    setRunState(outcome);
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
    rt.run.telemetry.finish('stopped', {
      historyMessages: rt.run.historyMessages,
      systemPromptCharacters: rt.run.systemPromptCharacters,
    });
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
    const history = session.messages.slice(0, idx + 1);
    renderMessages();
    rt.stickToBottom = true;
    runChat(text, { reuseUser: true, history: history });
  }

  /* 会话世代机制：切换即 +1 并逐级 abort，旧请求增量不再落到新会话 */
  function cancelActiveRun() {
    rt.generation += 1;
    const ctx = rt.run;
    if (ctx) {
      clearTimeout(ctx.timeoutId);
      ctx.telemetry.finish('stopped', {
        historyMessages: ctx.historyMessages,
        systemPromptCharacters: ctx.systemPromptCharacters,
      });
      abortCtx(ctx);
      persistPartial(ctx);
      finishTelemetry(ctx, 'stopped');
      rt.run = null;
    }
    setStreaming(false);
    setRunState('idle');
  }

  function sidebarIsDrawer() {
    return window.matchMedia('(max-width: 767px)').matches;
  }

  function inspectorIsDrawer() {
    return window.matchMedia('(max-width: 1279px)').matches;
  }

  function syncInert() {
    const sidebarOpen = document.body.classList.contains('sidebar-open');
    const inspectorOpen = document.body.classList.contains('inspector-open');
    els.topbar.inert = sidebarOpen || inspectorOpen;
    els.chatPanel.inert = sidebarOpen || inspectorOpen;
    els.sidebar.inert = inspectorOpen || (sidebarIsDrawer() && !sidebarOpen);
    els.sysPanel.inert = sidebarOpen || (inspectorIsDrawer() && !inspectorOpen);
  }

  function closeSidebar(restoreFocus = true) {
    const wasOpen = document.body.classList.contains('sidebar-open');
    document.body.classList.remove('sidebar-open');
    els.sidebarOverlay.hidden = true;
    els.menuBtn.setAttribute('aria-expanded', 'false');
    syncInert();
    if (wasOpen && restoreFocus) focusSafely(rt.sidebarTrigger || els.menuBtn);
  }

  function toggleSidebar() {
    if (document.body.classList.contains('sidebar-open')) {
      closeSidebar();
      return;
    }
    if (document.body.classList.contains('inspector-open')) closeSysPanel(false);
    rt.sidebarTrigger = document.activeElement;
    document.body.classList.add('sidebar-open');
    els.sidebarOverlay.hidden = false;
    els.menuBtn.setAttribute('aria-expanded', 'true');
    syncInert();
    requestAnimationFrame(function () {
      if (document.body.classList.contains('sidebar-open')) focusSafely(els.sidebarClose);
    });
  }

  function switchProject(pid) {
    if (!findProject(pid)) return;
    if (pid === data.activeProjectId) {
      rt.expanded[pid] = true;   // 点击当前项目只展开，不折叠，保证层级始终可见
      renderSidebar();
      closeSidebar();
      return;
    }
    flushPendingNotes();
    flushPendingSys();
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
    flushPendingNotes();
    flushPendingSys();
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
    if (data.projects.length >= MAX_PROJECTS) {
      openModal({ title: '项目数量已达上限', desc: '最多保存 50 个项目，请先备份并整理现有项目。', confirmText: '知道了' });
      return;
    }
    flushPendingNotes();
    flushPendingSys();
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
        removeSessionAnnotations(p.sessions.map(function (session) { return session.id; }));
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
    if (p.sessions.length >= MAX_SESSIONS) {
      openModal({ title: '实验数量已达上限', desc: '每个项目最多保存 100 个实验，请先备份并整理现有实验。', confirmText: '知道了' });
      return;
    }
    flushPendingNotes();
    flushPendingSys();
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

  function renameSession(pid, sid) {
    const project = findProject(pid);
    const session = project && project.sessions.find(function (item) { return item.id === sid; });
    if (!session) return;
    openModal({
      eyebrow: 'RENAME // 重命名',
      title: '重命名实验',
      desc: '实验名称仅保存在本地。',
      confirmText: '保存',
      input: { value: sessionLabel(session), placeholder: '输入实验名称', maxLength: 60 },
      onConfirm: function (value) {
        session.title = value;
        session.updatedAt = Date.now();
        project.updatedAt = Date.now();
        save();
        renderSidebar();
        renderHeader();
      },
    });
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
        removeSessionAnnotations([sid]);
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
    rt.modalTrigger = document.activeElement;
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
    openDialog(els.modalOverlay, hasInput ? els.modalInput : els.modalConfirm);
    if (hasInput) els.modalInput.select();
  }
  function closeModal() {
    closeDialog(els.modalOverlay, rt.modalTrigger);
    rt.modal = null;
    rt.modalTrigger = null;
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
      if (sysEffectiveLength() <= MAX_SYSTEM_LENGTH) {
        els.sysSaveState.textContent = rt.storageOk && !storageConflict && !transactionBlocked ? '已保存' : '未保存 · 仅本次有效';
      }
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
    const saved = save();
    updateSysUI();
    renderPresets();
    renderHeader();
    renderSidebar();
    flashSave(saved ? '已保存' : '未保存 · 仅本次有效');
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
    const saved = save();
    updateSysUI();
    renderPresets();
    renderHeader();
    renderSidebar();
    flashSave(saved ? '模板已套用 · 已启用' : '模板已套用 · 未保存');
  }

  function flushPendingSys() {
    if (rt.sysSaveTimer === null) return;
    clearTimeout(rt.sysSaveTimer);
    rt.sysSaveTimer = null;
    if (!persistSysFromUI()) els.announcement.textContent = '超过上限的协议修改未保存。';
  }

  function loadSysFromProject() {
    const p = currentProject();
    if (!p) return;
    rt.sysProjectId = p.id;
    els.sysEnabled.checked = !!p.systemPrompt.enabled;
    els.sysInput.value = p.systemPrompt.text || '';
    updateSysUI();
    renderPresets();
    els.sysSaveState.textContent = rt.storageOk && !storageConflict && !transactionBlocked ? '已保存' : '未保存 · 仅本次有效';
  }

  function openSysPanel() {
    const p = currentProject();
    if (!p) return;
    const trigger = document.activeElement;
    closeSidebar(false);
    if (rt.sysProjectId !== p.id) loadSysFromProject();
    if (inspectorIsDrawer()) {
      rt.inspectorTrigger = trigger;
      document.body.classList.add('inspector-open');
      els.sysOverlay.hidden = false;
      els.observeBtn.setAttribute('aria-expanded', 'true');
      syncInert();
    }
    focusSafely(els.sysInput);
  }

  function closeSysPanel(restoreFocus = true) {
    clearTimeout(rt.sysSaveTimer);
    rt.sysSaveTimer = null;
    if (sysEffectiveLength() > MAX_SYSTEM_LENGTH) {
      loadSysFromProject();
      els.announcement.textContent = '超过 4000 字的协议修改未保存。';
    } else {
      persistSysFromUI();
    }
    const wasOpen = document.body.classList.contains('inspector-open');
    document.body.classList.remove('inspector-open');
    els.sysOverlay.hidden = true;
    els.observeBtn.setAttribute('aria-expanded', inspectorIsDrawer() ? 'false' : 'true');
    syncInert();
    if (wasOpen && restoreFocus) focusSafely(rt.inspectorTrigger || els.observeBtn);
    else if (!wasOpen && restoreFocus) focusSafely(els.input);
  }

  function downloadFile(content, mime, name) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportSessionMarkdown() {
    if (rt.streaming) {
      openModal({ title: '请先结束当前观测', desc: '生成中的结果尚未保存，请等待完成或停止后再导出。', confirmText: '知道了' });
      return;
    }
    const project = currentProject();
    const session = currentSession();
    if (!project || !session) return;
    openModal({
      title: '导出当前实验？',
      desc: '文件包含对话、实验协议与笔记。请勿上传含私密内容的文件。',
      confirmText: '继续导出',
      onConfirm: function () {
        flushPendingNotes();
        flushPendingSys();
        const text = serializeSessionMarkdown(project, session, getSessionAnnotation(annotations, session.id));
        downloadFile(text, 'text/markdown;charset=utf-8', safeFileName(session.title) + '.md');
        els.announcement.textContent = '实验 Markdown 已导出';
      },
    });
  }

  function backupWorkspace() {
    if (rt.streaming) {
      openModal({ title: '请先结束当前观测', desc: '生成中的结果尚未保存，请等待完成或停止后再备份。', confirmText: '知道了' });
      return;
    }
    flushPendingNotes();
    flushPendingSys();
    const text = JSON.stringify(createWorkspaceBackup(data, annotations), null, 2);
    const inspected = inspectWorkspaceBackup(text, new TextEncoder().encode(text).byteLength);
    const warning = inspected.ok ? '' : ' 此备份不能直接导入：' + inspected.error + '。原始数据仍会完整导出。';
    openModal({
      title: '备份当前工作区？',
      desc: '备份包含所有对话、实验协议与笔记。请勿上传含私密内容的备份。' + warning,
      confirmText: '继续备份',
      onConfirm: function () {
        downloadFile(text, 'application/json;charset=utf-8', 'cyberlab-backup.json');
        els.announcement.textContent = inspected.ok ? '工作区 JSON 备份已导出' : '备份已导出，但不能直接导入。';
      },
    });
  }

  function openImportDialog() {
    rt.importTrigger = document.activeElement;
    rt.importPreview = null;
    rt.importReadToken += 1;
    els.importFile.value = '';
    els.importSummary.textContent = '尚未选择文件。';
    els.importConfirm.disabled = true;
    openDialog(els.importDialog, els.importFile);
  }

  function closeImportDialog(restoreFocus = true) {
    rt.importReadToken += 1;
    rt.importPreview = null;
    closeDialog(els.importDialog, restoreFocus ? rt.importTrigger : null);
    rt.importTrigger = null;
  }

  async function inspectSelectedFile() {
    const token = ++rt.importReadToken;
    rt.importPreview = null;
    els.importConfirm.disabled = true;
    const file = els.importFile.files && els.importFile.files[0];
    if (!file) { els.importSummary.textContent = '尚未选择文件。'; return; }
    if (file.size > MAX_BACKUP_BYTES) {
      els.importSummary.textContent = '备份文件不能超过 5 MiB。';
      return;
    }
    try {
      const text = await file.text();
      if (token !== rt.importReadToken || !els.importDialog.open) return;
      const inspected = inspectWorkspaceBackup(text, file.size);
      if (!inspected.ok) { els.importSummary.textContent = inspected.error; return; }
      try { buildMergedImport(data, annotations, inspected.backup); }
      catch (error) { els.importSummary.textContent = error.message || '备份无法合并。'; return; }
      const stats = inspected.stats;
      rt.importPreview = inspected.backup;
      els.importSummary.textContent = `项目 ${stats.projects}，实验 ${stats.sessions}，消息 ${stats.messages}，笔记 ${stats.notes}，标签 ${stats.tags}。导入会合并，不覆盖现有项目。`;
      els.importConfirm.disabled = false;
    } catch (_) {
      if (token === rt.importReadToken) els.importSummary.textContent = '无法读取备份文件。';
    }
  }

  function confirmImport() {
    if (!rt.importPreview) return;
    if (rt.streaming) { els.importSummary.textContent = '请先停止当前生成，再导入备份。'; return; }
    flushPendingNotes();
    flushPendingSys();
    if (storageConflict) {
      els.importSummary.textContent = '其他标签页已更改数据，请先备份本页并刷新后再导入。';
      return;
    }
    if (!rt.storageOk || !rt.annotationOk || transactionBlocked) {
      els.importSummary.textContent = '本地存储不可用，无法安全导入。';
      return;
    }
    if (!canWriteSnapshot()) {
      updateStorageWarning();
      els.importSummary.textContent = storageConflict
        ? '其他标签页已更改数据，请先备份本页并刷新后再导入。'
        : '本地存储不可用，无法安全导入。';
      return;
    }
    try {
      const candidate = buildMergedImport(data, annotations, rt.importPreview);
      const result = commitImportTransaction(undefined, candidate, { chat: expectedChat, annotations: expectedAnnotations });
      if (!result.ok) {
        if (result.reason === 'conflict' && result.stage === 'preflight') storageConflict = true;
        else if (result.reason === 'recovery-needed' || result.reason === 'conflict' || result.reason === 'corrupt') transactionBlocked = true;
        updateStorageWarning();
        els.importSummary.textContent = storageConflict
          ? '其他标签页已更改数据，请先备份本页并刷新后再导入。'
          : '导入未完成，现有对话和笔记未被有意覆盖；请检查存储空间后重试。';
        return;
      }
      data = candidate.chat;
      annotations = candidate.annotations;
      expectedChat = JSON.stringify(candidate.chat);
      expectedAnnotations = JSON.stringify(candidate.annotations);
      if (result.cleanupPending) {
        transactionBlocked = true;
        updateStorageWarning();
      }
      rt.notesSessionId = null;
      rt.expanded[data.activeProjectId] = true;
      renderAll();
      closeImportDialog();
      els.announcement.textContent = '备份已合并导入';
    } catch (error) {
      els.importSummary.textContent = error.message || '备份无法合并。';
    }
  }

  function duplicateSession() {
    const project = currentProject();
    const session = currentSession();
    if (!project || !session) return;
    if (project.sessions.length >= MAX_SESSIONS) {
      openModal({ title: '实验数量已达上限', desc: '每个项目最多保存 100 个实验。', confirmText: '知道了' });
      return;
    }
    flushPendingNotes();
    flushPendingSys();
    cancelActiveRun();
    const copied = structuredClone(session);
    copied.id = uid();
    copied.title = clampText(sessionLabel(session) + '（副本）', 60);
    copied.createdAt = copied.updatedAt = Date.now();
    const remap = new Map();
    copied.messages.forEach(function (message) {
      const oldId = message.id;
      message.id = uid();
      if (oldId) remap.set(oldId, message.id);
    });
    const original = getSessionAnnotation(annotations, session.id);
    const runs = {};
    Object.keys(original.runs).forEach(function (id) {
      if (remap.has(id)) runs[remap.get(id)] = original.runs[id];
    });
    annotations = updateSessionAnnotation(annotations, copied.id, { notes: original.notes, tags: original.tags, runs: runs });
    saveAnnotations();
    project.sessions.unshift(copied);
    project.activeSessionId = copied.id;
    project.updatedAt = Date.now();
    rt.expanded[project.id] = true;
    save();
    renderAll();
    closeSidebar(false);
    focusSafely(els.input);
  }

  function commandRegistry() {
    return [
      { label: '新建项目', enabled: data.projects.length < MAX_PROJECTS, run: openNewProject },
      { label: '新建实验', enabled: !!currentProject() && currentProject().sessions.length < MAX_SESSIONS, run: function () { newSession(data.activeProjectId); } },
      { label: '聚焦输入', enabled: !rt.streaming, run: function () { closeSidebar(false); if (document.body.classList.contains('inspector-open')) closeSysPanel(false); focusSafely(els.input); } },
      { label: '切换观测台', enabled: true, run: function () { if (document.body.classList.contains('inspector-open')) closeSysPanel(); else openSysPanel(); } },
      { label: '复制当前实验', enabled: !!currentSession() && currentProject().sessions.length < MAX_SESSIONS, run: duplicateSession },
      { label: '导出 Markdown', enabled: !!currentSession(), run: exportSessionMarkdown },
      { label: '备份 JSON', enabled: true, run: backupWorkspace },
      { label: '导入备份', enabled: true, run: openImportDialog },
      { label: '停止当前生成', enabled: rt.streaming, run: stopGeneration },
    ];
  }

  function selectCommand(index) {
    const items = rt.commandItems;
    if (!items.length) {
      rt.commandIndex = -1;
      els.commandInput.removeAttribute('aria-activedescendant');
      return;
    }
    const direction = index < rt.commandIndex ? -1 : 1;
    let next = ((index % items.length) + items.length) % items.length;
    let found = false;
    for (let i = 0; i < items.length; i += 1) {
      if (items[next].enabled !== false) { found = true; break; }
      next = (next + direction + items.length) % items.length;
    }
    if (!found) {
      rt.commandIndex = -1;
      els.commandInput.removeAttribute('aria-activedescendant');
      return;
    }
    rt.commandIndex = next;
    Array.from(els.commandList.querySelectorAll('[role="option"]')).forEach(function (node, i) {
      node.setAttribute('aria-selected', i === next ? 'true' : 'false');
    });
    const active = $('lab-command-option-' + next);
    if (active) {
      els.commandInput.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderCommandList() {
    const query = els.commandInput.value.trim();
    const term = query.toLowerCase();
    const commands = commandRegistry().filter(function (item) { return !term || item.label.toLowerCase().includes(term); });
    let results = [];
    try { results = searchWorkspace({ chat: data, annotations: annotations }, query, { limit: 50 }); }
    catch (_) { results = []; }
    rt.commandItems = commands.concat(results.map(function (result) {
      return {
        label: result.sessionTitle,
        detail: result.projectName + ' / ' + result.snippet,
        enabled: true,
        run: function () { switchSession(result.projectId, result.sessionId); focusSafely(els.input); },
      };
    }));
    const fragment = document.createDocumentFragment();
    rt.commandItems.forEach(function (item, index) {
      const option = createEl('div', item.detail ? 'lab-search-result' : 'lab-command-item');
      option.id = 'lab-command-option-' + index;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', 'false');
      if (item.enabled === false) option.setAttribute('aria-disabled', 'true');
      option.appendChild(createEl('span', null, item.label));
      if (item.detail) option.appendChild(createEl('small', null, item.detail));
      option.addEventListener('mousedown', function (e) { e.preventDefault(); });
      option.addEventListener('click', function () { executeCommand(index); });
      fragment.appendChild(option);
    });
    if (!rt.commandItems.length) {
      const empty = createEl('div', 'lab-command-item', '没有匹配的命令或实验');
      empty.setAttribute('role', 'presentation');
      fragment.appendChild(empty);
    }
    els.commandList.replaceChildren(fragment);
    rt.commandIndex = -1;
    selectCommand(0);
  }

  function openCommand() {
    if (els.commandDialog.open) { focusSafely(els.commandInput); return; }
    rt.commandTrigger = document.activeElement;
    els.commandInput.value = '';
    els.commandInput.setAttribute('aria-expanded', 'true');
    renderCommandList();
    openDialog(els.commandDialog, els.commandInput);
  }

  function closeCommand(restoreFocus = true) {
    clearTimeout(rt.commandTimer);
    rt.commandTimer = null;
    els.commandInput.setAttribute('aria-expanded', 'false');
    closeDialog(els.commandDialog, restoreFocus ? rt.commandTrigger : null);
    rt.commandTrigger = null;
  }

  function executeCommand(index) {
    const item = rt.commandItems[index];
    if (!item || item.enabled === false) return;
    closeCommand(false);
    item.run();
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
    focusSafely(els.input);
  });
  els.scroller.addEventListener('scroll', function () {
    rt.stickToBottom = distanceFromBottom() <= NEAR_BOTTOM_THRESHOLD;
    updateScrollButton();
  }, { passive: true });
  els.scrollBottomBtn.addEventListener('click', function () {
    rt.stickToBottom = true;
    scrollToBottom(true, true);
  });

  function openNewProject() {
    openModal({
      eyebrow: 'NEW PROJECT // 新建',
      title: '新建项目',
      desc: '每个项目拥有独立的实验列表与一套实验协议。',
      confirmText: '创建项目',
      input: { value: '', placeholder: '例如：前端重构 / 技术调研', maxLength: 60 },
      onConfirm: createProject,
    });
  }
  els.newProjectBtn.addEventListener('click', openNewProject);
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
    else if (action === 'rename-session') renameSession(pid, sid);
    else if (action === 'delete-session') deleteSession(pid, sid);
  });

  els.notes.addEventListener('input', function () {
    const session = currentSession();
    if (!session) return;
    clearTimeout(rt.notesTimer);
    rt.pendingNotes = { sessionId: session.id, text: els.notes.value };
    els.noteStatus.textContent = rt.annotationOk ? '保存中…' : '存储不可用，笔记仅本次有效';
    rt.notesTimer = setTimeout(flushPendingNotes, 300);
  });
  els.notes.addEventListener('change', flushPendingNotes);
  els.tagAdd.addEventListener('click', addTag);
  els.tagInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      addTag();
    }
  });

  els.commandBtn.addEventListener('click', openCommand);
  els.sidebarSearch.addEventListener('click', openCommand);
  els.commandClose.addEventListener('click', closeCommand);
  els.commandDialog.addEventListener('cancel', function (e) { e.preventDefault(); closeCommand(); });
  els.commandInput.addEventListener('input', function () {
    clearTimeout(rt.commandTimer);
    rt.commandTimer = setTimeout(function () {
      rt.commandTimer = null;
      renderCommandList();
    }, 150);
  });
  els.commandInput.addEventListener('keydown', function (e) {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      selectCommand(rt.commandIndex + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (rt.commandTimer !== null) {
        clearTimeout(rt.commandTimer);
        rt.commandTimer = null;
        renderCommandList();
      }
      executeCommand(rt.commandIndex);
    }
  });
  els.exportMd.addEventListener('click', exportSessionMarkdown);
  els.exportJson.addEventListener('click', backupWorkspace);
  els.importOpen.addEventListener('click', openImportDialog);
  els.importCancel.addEventListener('click', closeImportDialog);
  els.importConfirm.addEventListener('click', confirmImport);
  els.importFile.addEventListener('change', inspectSelectedFile);
  els.importDialog.addEventListener('cancel', function (e) { e.preventDefault(); closeImportDialog(); });
  els.copyDiagnostic.addEventListener('click', function () {
    const run = latestTelemetry(currentSession());
    if (!run) { els.announcement.textContent = '当前实验暂无运行诊断。'; return; }
    copyText(JSON.stringify(toDiagnostic(run), null, 2), els.copyDiagnostic);
  });

  els.menuBtn.addEventListener('click', toggleSidebar);
  els.sidebarClose.addEventListener('click', closeSidebar);
  els.sidebarOverlay.addEventListener('click', closeSidebar);

  els.sysBadge.addEventListener('click', openSysPanel);
  els.headSysChip.addEventListener('click', openSysPanel);
  els.observeBtn.addEventListener('click', function () {
    if (document.body.classList.contains('inspector-open')) closeSysPanel();
    else openSysPanel();
  });
  els.sysClose.addEventListener('click', closeSysPanel);
  els.sysDone.addEventListener('click', closeSysPanel);
  els.sysOverlay.addEventListener('click', closeSysPanel);
  els.sysEnabled.addEventListener('change', function () {
    clearTimeout(rt.sysSaveTimer);
    rt.sysSaveTimer = null;
    persistSysFromUI();
  });
  els.sysInput.addEventListener('input', function () {
    updateSysUI();
    clearTimeout(rt.sysSaveTimer);
    rt.sysSaveTimer = setTimeout(function () {
      rt.sysSaveTimer = null;
      persistSysFromUI();
    }, 300);
  });
  els.sysInput.addEventListener('change', function () {
    clearTimeout(rt.sysSaveTimer);
    rt.sysSaveTimer = null;
    persistSysFromUI();
  });
  els.presetList.addEventListener('click', function (e) {
    const btn = e.target && e.target.closest ? e.target.closest('[data-preset-id]') : null;
    if (!btn) return;
    applyPreset(btn.getAttribute('data-preset-id'));
  });

  els.modalCancel.addEventListener('click', closeModal);
  els.modalConfirm.addEventListener('click', confirmModal);
  els.modalOverlay.addEventListener('cancel', function (e) {
    e.preventDefault();
    closeModal();
  });
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
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (els.commandDialog.open) closeCommand();
      else if (!document.querySelector('dialog[open]')) openCommand();
      return;
    }
    if (document.querySelector('dialog[open]')) return;
    if (document.body.classList.contains('inspector-open')) {
      if (e.key === 'Escape') { e.preventDefault(); closeSysPanel(); }
      else trapFocus(e, els.sysPanel);
      return;
    }
    if (document.body.classList.contains('sidebar-open')) {
      if (e.key === 'Escape') { e.preventDefault(); closeSidebar(); }
      else trapFocus(e, els.sidebar);
    }
  });

  window.addEventListener('resize', function () {
    if (!sidebarIsDrawer() && document.body.classList.contains('sidebar-open')) closeSidebar(false);
    if (!inspectorIsDrawer() && document.body.classList.contains('inspector-open')) {
      document.body.classList.remove('inspector-open');
      els.sysOverlay.hidden = true;
    }
    els.observeBtn.setAttribute('aria-expanded', inspectorIsDrawer() ? String(document.body.classList.contains('inspector-open')) : 'true');
    syncInert();
  });
  window.addEventListener('online', updateNetworkStatus);
  window.addEventListener('offline', updateNetworkStatus);
  window.addEventListener('storage', function (event) {
    if ((event.key === STORAGE_KEY && event.newValue !== expectedChat) ||
        (event.key === LAB_STORAGE_KEY && event.newValue !== expectedAnnotations) || event.key === null) {
      storageConflict = true;
      updateStorageWarning();
    }
  });

  window.addEventListener('pagehide', function () {
    clearTimeout(rt.saveTimer);
    flushPendingNotes();
    flushPendingSys();
    save();
  });

  /* ---------------- 初始化 ---------------- */
  setStorageStatus(loadResult.ok);
  if (loadResult.fresh) save();
  syncInert();
  els.observeBtn.setAttribute('aria-expanded', inspectorIsDrawer() ? 'false' : 'true');
  setRunState('idle');
  updateNetworkStatus();
  renderAll();
  autoResize();
  updateCharCount();
  updateSendButton();
  tickClock();
  setInterval(tickClock, 1000);
})((typeof window !== 'undefined') ? window : globalThis);
