import { createEl } from './dom.js';

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

export async function copyText(text, btn) {
  const originalLabel = btn.textContent;
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
  setTimeout(function () { btn.textContent = originalLabel; }, 1600);
  return ok;
}

function buildCodeBlock(code, lang, options) {
  const box = createEl('div', 'code-block');
  const head = createEl('div', 'code-head');
  head.appendChild(createEl('span', 'code-lang', lang || 'text'));
  const controls = createEl('div', 'code-actions');
  const wrap = createEl('button', 'btn-copy', '自动换行');
  wrap.type = 'button';
  wrap.setAttribute('aria-pressed', options.wrapCode ? 'true' : 'false');
  const btn = createEl('button', 'btn-copy', '复制');
  btn.type = 'button';
  btn.setAttribute('aria-label', '复制代码');
  btn.addEventListener('click', function () { copyText(code, btn); });
  controls.append(wrap, btn);
  head.appendChild(controls);
  const pre = createEl('pre', 'code-pre');
  pre.classList.toggle('is-wrapped', !!options.wrapCode);
  wrap.addEventListener('click', function () {
    const enabled = pre.classList.toggle('is-wrapped');
    wrap.setAttribute('aria-pressed', String(enabled));
    if (typeof options.onWrapChange === 'function') options.onWrapChange(enabled);
  });
  pre.appendChild(createEl('code', null, code));
  box.append(head, pre);
  return box;
}

export function renderMarkdown(text, container, options = {}) {
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
      container.appendChild(buildCodeBlock(buf.join('\n'), lang, options));
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
