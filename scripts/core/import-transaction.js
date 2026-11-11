import { STORAGE_KEY } from './state.js';
import { LAB_STORAGE_KEY } from './lab-data.js';

export const IMPORT_TRANSACTION_KEY = 'cyberlab.import.transaction.v1';

function resolveStore(store) {
  if (store !== undefined) return store;
  try { return typeof localStorage === 'undefined' ? null : localStorage; }
  catch (_) { return null; }
}

function restoreValue(store, key, value) {
  if (value === null) store.removeItem(key);
  else store.setItem(key, value);
}

function validJournal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.format !== 'cyberlab.import.transaction' || value.version !== 1) return false;
  for (const side of ['before', 'after']) {
    const record = value[side];
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    if (!(record.chat === null || typeof record.chat === 'string')) return false;
    if (!(record.annotations === null || typeof record.annotations === 'string')) return false;
  }
  return typeof value.after.chat === 'string' && typeof value.after.annotations === 'string';
}

export function recoverImportTransaction(store) {
  const target = resolveStore(store);
  if (!target) return { ok: false, reason: 'unavailable' };
  try {
    const raw = target.getItem(IMPORT_TRANSACTION_KEY);
    if (raw === null) return { ok: true, recovered: false };
    let journal;
    try { journal = JSON.parse(raw); } catch (_) { return { ok: false, reason: 'corrupt' }; }
    if (!validJournal(journal)) return { ok: false, reason: 'corrupt' };
    const chat = target.getItem(STORAGE_KEY);
    const annotations = target.getItem(LAB_STORAGE_KEY);
    if (chat === journal.after.chat && annotations === journal.after.annotations) {
      target.removeItem(IMPORT_TRANSACTION_KEY);
      return { ok: true, recovered: true, committed: true };
    }
    if (chat !== journal.before.chat || (annotations !== journal.before.annotations && annotations !== journal.after.annotations)) {
      return { ok: false, reason: 'conflict' };
    }
    if (annotations !== journal.before.annotations) restoreValue(target, LAB_STORAGE_KEY, journal.before.annotations);
    if (target.getItem(LAB_STORAGE_KEY) !== journal.before.annotations) return { ok: false, reason: 'recovery-needed' };
    target.removeItem(IMPORT_TRANSACTION_KEY);
    return { ok: true, recovered: true, committed: false };
  } catch (_) {
    return { ok: false, reason: 'recovery-needed' };
  }
}

export function commitImportTransaction(store, candidate, expected) {
  const target = resolveStore(store);
  if (!target) return { ok: false, reason: 'unavailable' };
  const recovered = recoverImportTransaction(target);
  if (!recovered.ok) return recovered;
  let journalWritten = false;
  try {
    const chat = JSON.stringify(candidate.chat);
    const annotations = JSON.stringify(candidate.annotations);
    if (typeof chat !== 'string' || typeof annotations !== 'string') return { ok: false, reason: 'invalid' };
    const journal = {
      format: 'cyberlab.import.transaction',
      version: 1,
      before: { chat: target.getItem(STORAGE_KEY), annotations: target.getItem(LAB_STORAGE_KEY) },
      after: { chat, annotations },
    };
    if (expected && (journal.before.chat !== expected.chat || journal.before.annotations !== expected.annotations)) {
      return { ok: false, reason: 'conflict', stage: 'preflight' };
    }
    target.setItem(IMPORT_TRANSACTION_KEY, JSON.stringify(journal));
    journalWritten = true;
    target.setItem(LAB_STORAGE_KEY, annotations);
    target.setItem(STORAGE_KEY, chat);
    if (target.getItem(LAB_STORAGE_KEY) !== annotations || target.getItem(STORAGE_KEY) !== chat) {
      return { ok: false, reason: 'conflict' };
    }
    try {
      target.removeItem(IMPORT_TRANSACTION_KEY);
      return { ok: true, cleanupPending: false };
    } catch (_) {
      return { ok: true, cleanupPending: true };
    }
  } catch (_) {
    if (!journalWritten) return { ok: false, reason: 'write-error' };
    const rollback = recoverImportTransaction(target);
    return { ok: false, reason: rollback.ok ? 'write-error' : 'recovery-needed' };
  }
}
