// Shared by the node, the wallet, the explorer and the miner.
// A receipt is valid only if both sides can rebuild these bytes.
import { sha256 } from '@noble/hashes/sha2.js';
import { ed25519 } from '@noble/curves/ed25519.js';

export const UNIT = 1_000_000n;
export const MEMO_MAX = 140;
export const BLOCK_REWARD = 8n * UNIT;
export const FAUCET_DRIP = 25n * UNIT;
export const MIN_FEE = 10_000n;
export const MATURITY = 3;
export const TARGET_MS = 20_000;
export const FAUCET_COOLDOWN = 60 * 60 * 1000;
export const INITIAL_DIFF = 120_000n;
export const GENESIS_TIME = 1_763_000_000_000;

const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = Object.fromEntries([...ALPH].map((c, i) => [c, BigInt(i)]));

export const utf8 = (s) => new TextEncoder().encode(s);
export const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
export function unhex(s) {
  if (typeof s !== 'string' || s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function hashHex(data) {
  return hex(sha256(typeof data === 'string' ? utf8(data) : data));
}
export const notchOf = (memo) => hashHex(memo);

export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let s = '';
  while (n > 0n) { s = ALPH[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s || '1';
}
export function b58decode(s) {
  if (!s || [...s].some((c) => MAP[c] === undefined)) throw new Error('bad base58');
  let n = 0n;
  for (const c of s) n = n * 58n + MAP[c];
  const bytes = [];
  while (n > 0n) { bytes.push(Number(n & 255n)); n >>= 8n; }
  bytes.reverse();
  let zeros = 0;
  for (const c of s) { if (c !== '1') break; zeros++; }
  return Uint8Array.from([...Array(zeros).fill(0), ...bytes]);
}

export function addressOfPub(pub) {
  const sum = sha256(sha256(pub)).slice(0, 4);
  const raw = new Uint8Array(36);
  raw.set(pub, 0);
  raw.set(sum, 32);
  return 'tally1' + b58encode(raw);
}
export function pubFromSecret(secret) {
  const pub = ed25519.getPublicKey(secret);
  return pub;
}
export function addressFromSecret(secret) {
  return addressOfPub(pubFromSecret(secret));
}
export function pubFromAddress(address) {
  if (typeof address !== 'string' || !address.startsWith('tally1')) throw new Error('bad address');
  const raw = b58decode(address.slice(6));
  if (raw.length !== 36) throw new Error('bad address');
  const pub = raw.slice(0, 32);
  const sum = sha256(sha256(pub)).slice(0, 4);
  if (![...sum].every((b, i) => b === raw[32 + i])) throw new Error('bad address checksum');
  return pub;
}
export const isAddress = (s) => { try { pubFromAddress(s); return true; } catch { return false; } };

export function randomSeed() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return hex(b);
}
export const seedBytes = (seed) => {
  if (!/^[0-9a-f]{64}$/i.test(seed || '')) throw new Error('seed must be 64 hex characters');
  return unhex(seed.toLowerCase());
};

const digits = (s) => {
  if (typeof s !== 'string' || !/^\d+$/.test(s)) throw new Error('bad amount');
  const n = BigInt(s);
  if (n.toString() !== s) throw new Error('bad amount');
  return n;
};

export function canonTx(tx) {
  return [
    'tally.tx.v1',
    tx.type,
    tx.from,
    tx.to,
    tx.amount,
    tx.fee,
    String(tx.nonce),
    tx.memo,
    tx.ref || '',
  ].join('\n');
}

export function signTx(fields, secret) {
  const tx = {
    v: 1,
    type: fields.type,
    from: fields.from,
    to: fields.to,
    amount: fields.amount,
    fee: fields.fee,
    nonce: fields.nonce,
    memo: fields.memo,
    ref: (fields.ref || '').toLowerCase(),
  };
  const sig = ed25519.sign(utf8(canonTx(tx)), secret);
  tx.sig = hex(sig);
  tx.notch = notchOf(tx.memo);
  tx.id = hashHex(canonTx(tx) + '\n' + tx.sig);
  return tx;
}

export function verifySig(tx) {
  try {
    if (tx.type === 'coinbase') return true;
    const pub = pubFromAddress(tx.from);
    return ed25519.verify(unhex(tx.sig), utf8(canonTx(tx)), pub);
  } catch {
    return false;
  }
}

export function txIdOf(tx) {
  if (tx.type === 'coinbase') return hashHex(canonTx(tx) + '\ncoinbase');
  return hashHex(canonTx(tx) + '\n' + tx.sig);
}

export function txRoot(txs) {
  return hashHex(txs.map((t) => t.id).join('\n'));
}

export function canonHead(h, nonce) {
  return [
    'tally.block.v1',
    String(h.height),
    h.prev,
    String(h.time),
    String(h.diff),
    h.miner,
    h.txRoot,
    String(nonce),
  ].join('\n');
}
export function powHash(h, nonce) {
  return sha256(utf8(canonHead(h, nonce)));
}
export function belowTarget(hashBytes, difficulty) {
  const diff = BigInt(difficulty);
  if (diff <= 1n) return true;
  let n = 0n;
  for (const b of hashBytes) n = (n << 8n) + BigInt(b);
  return n < (1n << 256n) / diff;
}

export function parseTally(input) {
  const s = String(input ?? '').trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error('enter an amount like 1.5');
  const [w, f = ''] = s.split('.');
  if (w.length > 1 && w.startsWith('0')) throw new Error('enter an amount like 1.5');
  const frac = (f + '000000').slice(0, 6);
  const n = BigInt(w) * UNIT + BigInt(frac);
  if (n <= 0n) throw new Error('amount must be greater than zero');
  return n;
}
export function formatTally(amount) {
  const n = typeof amount === 'bigint' ? amount : BigInt(amount);
  const neg = n < 0n;
  const v = neg ? -n : n;
  const whole = (v / UNIT).toString();
  let frac = (v % UNIT).toString().padStart(6, '0').replace(/0+$/, '');
  const text = frac ? `${whole}.${frac}` : whole;
  return neg ? `-${text}` : text;
}

export function checkMemo(memo) {
  if (typeof memo !== 'string') throw new Error('receipt needs words');
  if (/[\r\n]/.test(memo)) throw new Error('receipt words stay on one line');
  const size = utf8(memo).length;
  if (size < 1 || size > MEMO_MAX) throw new Error(`receipt words must be 1 to ${MEMO_MAX} bytes`);
  if (!memo.trim()) throw new Error('receipt needs words');
  return memo;
}
export function checkRef(ref) {
  const r = (ref || '').trim().toLowerCase();
  if (!r) return '';
  if (!/^[0-9a-f]{64}$/.test(r)) throw new Error('mark must be a 64-character hex hash');
  return r;
}

export function inspectTx(tx, expect = {}) {
  if (!tx || tx.v !== 1) throw new Error('bad transaction');
  if (!['pay', 'faucet', 'coinbase'].includes(tx.type)) throw new Error('bad transaction type');
  checkMemo(tx.memo);
  const ref = checkRef(tx.ref);
  if ((tx.ref || '') !== ref) throw new Error('bad mark');
  const amount = digits(tx.amount);
  const fee = digits(tx.fee);
  if (!Number.isInteger(tx.nonce) || tx.nonce < 0) throw new Error('bad nonce');
  if (tx.notch !== notchOf(tx.memo)) throw new Error('notch does not match the words');
  if (tx.type === 'coinbase') {
    if (tx.from !== 'coinbase' || tx.sig) throw new Error('bad coinbase');
    if (tx.memo !== 'block reward' || ref || fee !== 0n) throw new Error('bad coinbase');
    if (!isAddress(tx.to)) throw new Error('bad miner address');
    if (tx.id !== txIdOf(tx)) throw new Error('bad coinbase id');
    return { amount, fee };
  }
  if (!isAddress(tx.from) || !isAddress(tx.to)) throw new Error('bad address');
  if (!verifySig(tx)) throw new Error('bad signature');
  if (tx.id !== txIdOf(tx)) throw new Error('bad transaction id');
  if (tx.type === 'faucet') {
    if (tx.from !== tx.to || amount !== FAUCET_DRIP || fee !== 0n || tx.memo !== 'faucet' || ref) {
      throw new Error('bad faucet receipt');
    }
  } else {
    if (amount <= 0n) throw new Error('amount must be greater than zero');
    if (fee < MIN_FEE) throw new Error('fee is below the minimum');
    if (expect.to && tx.to !== expect.to) throw new Error('bad recipient');
  }
  return { amount, fee };
}
