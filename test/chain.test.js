import assert from 'node:assert/strict';
import {
  FAUCET_DRIP, MIN_FEE, addressFromSecret, formatTally, notchOf, parseTally, randomSeed,
  seedBytes, signTx, verifySig,
} from '../client/protocol.js';
import { createChain } from '../server/chain.js';

const secret = (n) => seedBytes(n.repeat(64));
const A = secret('a');
const B = secret('b');
const miner = secret('c');
const addr = (key) => addressFromSecret(key);

function pay(from, to, amount, nonce, memo, ref = '') {
  return signTx({
    type: 'pay',
    from: addr(from),
    to: addr(to),
    amount: amount.toString(),
    fee: MIN_FEE.toString(),
    nonce,
    memo,
    ref,
  }, from);
}

function drip(key, nonce) {
  return signTx({
    type: 'faucet',
    from: addr(key),
    to: addr(key),
    amount: FAUCET_DRIP.toString(),
    fee: '0',
    nonce,
    memo: 'faucet',
    ref: '',
  }, key);
}

function seal(chain, key, now) {
  const work = chain.issue(addr(key), now);
  return chain.accept(work.id, 0);
}

const chain = createChain({ difficulty: 1n });
const step = 20_000;
const t0 = Date.now() - step * 20;

assert.equal(verifySig(drip(A, 0)), true);
assert.equal(notchOf('faucet'), drip(A, 0).notch);
chain.submit(drip(A, 0));
assert.throws(() => chain.submit(drip(A, 1)), /once an hour/);
seal(chain, miner, t0);
assert.equal(chain.account(addr(A)).balance, FAUCET_DRIP.toString());

const marked = pay(A, B, 2_000_000n, 1, 'for the field report', 'ab'.repeat(32));
assert.equal(marked.notch, notchOf('for the field report'));
chain.submit(marked);
const bad = { ...pay(A, B, 1_000_000n, 2, 'second'), memo: 'changed words' };
assert.equal(verifySig(bad), false);
assert.throws(() => chain.submit(bad), /notch|signature|words/);
assert.throws(() => chain.submit(pay(A, B, FAUCET_DRIP, 2, 'too much')), /not enough/);
assert.throws(() => chain.submit(signTx({
  type: 'pay', from: addr(A), to: addr(B), amount: '1000000', fee: MIN_FEE.toString(),
  nonce: 2, memo: 'line\nbreak', ref: '',
}, A)), /one line/);

seal(chain, miner, t0 + step);
const sent = chain.tx(marked.id);
assert.equal(sent.to, addr(B));
assert.equal(sent.memo, 'for the field report');
assert.equal(sent.ref, 'ab'.repeat(32));
assert.equal(chain.account(addr(B)).balance, 2_000_000n.toString());
assert.equal(chain.account(addr(A)).balance, (FAUCET_DRIP - 2_000_000n - MIN_FEE).toString());

const minerView = chain.account(addr(miner));
assert.equal(minerView.balance, '0');
assert.equal(BigInt(minerView.maturing) > 0n, true);

seal(chain, miner, t0 + step * 2);
assert.equal(chain.account(addr(miner)).balance, '0');
seal(chain, miner, t0 + step * 3);
const spendable = BigInt(chain.account(addr(miner)).balance);
assert.equal(spendable > MIN_FEE, true);
chain.submit(pay(miner, B, 500_000n, 0, 'wage for the week'));
seal(chain, miner, t0 + step * 4);
assert.equal(chain.account(addr(B)).balance, (2_000_000n + 500_000n).toString());

const again = createChain({ blocks: chain.export(), difficulty: 1n });
assert.equal(again.tip().height, chain.tip().height);
assert.equal(again.account(addr(B)).balance, chain.account(addr(B)).balance);
assert.equal(again.tx(marked.id).notch, notchOf('for the field report'));

assert.equal(formatTally(parseTally('1.5')), '1.5');
assert.equal(parseTally('25'), FAUCET_DRIP);
assert.throws(() => parseTally('1.1234567'), /amount/);
assert.equal(addr(A).startsWith('tally1'), true);
assert.notEqual(randomSeed(), randomSeed());

console.log(`ok  ${again.tip().height} blocks, receipt ${marked.id.slice(0, 12)}… halves match`);
