import { formatTally, notchOf, verifySig } from '/protocol.js';

export const $ = (id) => document.getElementById(id);

export async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}

export function short(value, n = 8) {
  const text = String(value || '');
  if (text.length <= n * 2 + 1) return text;
  return `${text.slice(0, n)}…${text.slice(-4)}`;
}

export function ago(ts) {
  if (!ts) return 'pending';
  const seconds = Math.max(0, (Date.now() - ts) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function toast(message, bad = false) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.toggle('bad', bad);
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.remove(), 3800);
}

export function tally(amount) {
  return `${formatTally(amount)} tTALLY`;
}

export function localNotch(tx) {
  return notchOf(tx.memo) === tx.notch && (tx.type === 'coinbase' || verifySig(tx));
}

export { formatTally, notchOf, verifySig };
