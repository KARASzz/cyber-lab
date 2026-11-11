export const ICONS = {
  chevron: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>',
  plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
  pencil: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 2.5l2 2-8 8-2.5.5.5-2.5 8-8z"/></svg>',
  trash: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8M6.7 7v3.5M9.3 7v3.5"/></svg>',
  spark: '<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M16 3.5l2.9 8.6 8.6 2.9-8.6 2.9L16 26.5l-2.9-8.6L4.5 15l8.6-2.9L16 3.5z" fill="currentColor"/><circle cx="25" cy="6.5" r="2" fill="currentColor" opacity=".75"/></svg>',
  alert: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 6.5v4.2M10 13.6v.1"/></svg>',
  retry: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16.5 9A6.5 6.5 0 104.5 11"/><path d="M16.5 4.5V9H12"/></svg>',
};

export function createEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

export function iconNode(name) {
  const span = createEl('span', 'ico');
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = ICONS[name] || '';
  return span;
}

export function pad2(n) { return String(n).padStart(2, '0'); }

export function formatTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
