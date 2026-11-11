export function focusSafely(element) {
  if (!element || !element.isConnected || element.closest('[inert]')) return;
  try { element.focus({ preventScroll: true }); } catch (_) { element.focus(); }
}

export function trapFocus(event, panel) {
  if (event.key !== 'Tab' || !panel || document.querySelector('dialog[open]')) return;
  const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const items = Array.from(panel.querySelectorAll(selector)).filter(function (node) {
    return !node.closest('[inert]') && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  });
  if (!items.length) {
    event.preventDefault();
    focusSafely(panel);
    return;
  }
  const current = document.activeElement;
  const index = items.indexOf(current);
  if (index === -1 || (event.shiftKey && index === 0) || (!event.shiftKey && index === items.length - 1)) {
    event.preventDefault();
    focusSafely(event.shiftKey ? items[items.length - 1] : items[0]);
  }
}

export function openDialog(dialog, initialFocus) {
  dialog.hidden = false;
  if (!dialog.open) dialog.showModal();
  if (initialFocus) focusSafely(initialFocus);
}

export function closeDialog(dialog, trigger) {
  if (dialog.open) dialog.close();
  dialog.hidden = true;
  focusSafely(trigger);
}
