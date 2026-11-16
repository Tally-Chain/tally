import {
  BLOCK_REWARD, FAUCET_COOLDOWN, FAUCET_DRIP, GENESIS_TIME, INITIAL_DIFF, MATURITY, TARGET_MS,
  belowTarget, hashHex, hex, inspectTx, notchOf, powHash, txIdOf, txRoot,
} from '../client/protocol.js';

const emptyAccount = () => ({ balance: 0n, nonce: 0, lastFaucet: 0, pending: [] });

function mature(account, height) {
  const keep = [];
  for (const item of account.pending) {
    if (item.unlock <= height) account.balance += item.amount;
    else keep.push(item);
  }
  account.pending = keep;
}

function credit(accounts, address) {
  let account = accounts.get(address);
  if (!account) accounts.set(address, account = emptyAccount());
  return account;
}

function retarget(prevDiff, elapsed) {
  const span = BigInt(Math.max(1, elapsed));
  let next = prevDiff * BigInt(TARGET_MS) / span;
  const min = prevDiff / 4n > 0n ? prevDiff / 4n : 1n;
  const max = prevDiff * 4n;
  if (next < min) next = min;
  if (next > max) next = max;
  return next < 1n ? 1n : next;
}

export function coinbase(to, reward) {
  const tx = {
    v: 1,
    type: 'coinbase',
    from: 'coinbase',
    to,
    amount: reward.toString(),
    fee: '0',
    nonce: 0,
    memo: 'block reward',
    ref: '',
    sig: '',
  };
  tx.notch = notchOf(tx.memo);
  tx.id = txIdOf(tx);
  return tx;
}

export function genesisBlock(difficulty = INITIAL_DIFF) {
  const block = {
    v: 1,
    height: 0,
    prev: '00'.repeat(32),
    time: GENESIS_TIME,
    diff: difficulty.toString(),
    miner: 'genesis',
    txRoot: hashHex(''),
    nonce: 0,
    txs: [],
  };
  block.hash = hashHex(`tally.genesis.v1\n${block.diff}`);
  return block;
}

function cloneAccounts(accounts) {
  const copy = new Map();
  for (const [address, account] of accounts) {
    copy.set(address, {
      balance: account.balance,
      nonce: account.nonce,
      lastFaucet: account.lastFaucet,
      pending: account.pending.map((item) => ({ ...item })),
    });
  }
  return copy;
}

function applyTx(accounts, tx, height, time) {
  const { amount, fee } = inspectTx(tx);
  if (tx.type === 'coinbase') {
    credit(accounts, tx.to).pending.push({ amount, unlock: height + MATURITY });
    return 0n;
  }
  const sender = credit(accounts, tx.from);
  mature(sender, height);
  if (sender.nonce !== tx.nonce) throw new Error('bad nonce');
  if (tx.type === 'faucet') {
    if (time - sender.lastFaucet < FAUCET_COOLDOWN) throw new Error('faucet opens once an hour');
    sender.nonce += 1;
    sender.lastFaucet = time;
    sender.balance += amount;
    return 0n;
  }
  if (sender.balance < amount + fee) throw new Error('not enough tTALLY');
  sender.balance -= amount + fee;
  sender.nonce += 1;
  credit(accounts, tx.to).balance += amount;
  return fee;
}

function presentTx(tx, block) {
  return {
    id: tx.id,
    type: tx.type,
    from: tx.from,
    to: tx.to,
    amount: tx.amount,
    fee: tx.fee,
    nonce: tx.nonce,
    memo: tx.memo,
    ref: tx.ref || '',
    notch: tx.notch,
    sig: tx.sig || '',
    height: block?.height ?? null,
    time: block?.time ?? null,
    blockHash: block?.hash ?? null,
    confirmations: block ? undefined : 0,
  };
}

export function createChain(opts = {}) {
  const stored = opts.blocks?.length ? opts.blocks : null;
  let blocks = [stored ? stored[0] : genesisBlock(opts.difficulty ?? INITIAL_DIFF)];
  let accounts = new Map();
  let supply = 0n;
  let mempool = [];
  const issued = new Map();

  function commit(block, { live }) {
    const prev = blocks.at(-1);
    if (block.prev !== prev.hash || block.height !== prev.height + 1) throw new Error('block does not extend the chain');
    const expectDiff = prev.height === 0 ? BigInt(prev.diff) : retarget(BigInt(prev.diff), block.time - prev.time);
    if (BigInt(block.diff) !== expectDiff) throw new Error('bad difficulty');
    if (block.time < prev.time) throw new Error('block time goes backwards');
    if (live && block.time > Date.now() + 120_000) throw new Error('block time is in the future');
    const digest = powHash(block, block.nonce);
    const hash = hex(digest);
    if (hash !== block.hash) throw new Error('bad block hash');
    if (!belowTarget(digest, BigInt(block.diff))) throw new Error('proof of work is too weak');
    if (!block.txs?.length || block.txs[0].type !== 'coinbase') throw new Error('block is missing its coinbase');
    if (txRoot(block.txs) !== block.txRoot) throw new Error('transaction root mismatch');
    const saved = cloneAccounts(accounts);
    const savedSupply = supply;
    try {
      let fees = 0n;
      const used = new Set();
      for (const tx of block.txs.slice(1)) {
        if (used.has(tx.from)) throw new Error('one receipt per address in a block');
        used.add(tx.from);
        fees += applyTx(accounts, tx, block.height, block.time);
      }
      const coin = block.txs[0];
      if (coin.to !== block.miner) throw new Error('coinbase does not pay the miner');
      if (BigInt(coin.amount) !== BLOCK_REWARD + fees) throw new Error('bad block reward');
      applyTx(accounts, coin, block.height, block.time);
      supply += BLOCK_REWARD + fees;
      for (const tx of block.txs) if (tx.type === 'faucet') supply += FAUCET_DRIP;
      blocks.push(block);
      const ids = new Set(block.txs.map((tx) => tx.id));
      mempool = mempool.filter((tx) => !ids.has(tx.id));
      issued.clear();
    } catch (error) {
      accounts = saved;
      supply = savedSupply;
      throw error;
    }
  }

  if (stored) {
    for (const block of stored.slice(1)) commit(block, { live: false });
  }

  function stage(time) {
    const nextHeight = blocks.at(-1).height + 1;
    const copy = cloneAccounts(accounts);
    for (const account of copy.values()) mature(account, nextHeight);
    return { copy, nextHeight, time };
  }

  function takeTxs(time) {
    const { copy, nextHeight } = stage(time);
    const taken = [];
    const used = new Set();
    let fees = 0n;
    for (const tx of mempool) {
      if (used.has(tx.from)) continue;
      try {
        fees += applyTx(copy, tx, nextHeight, time);
        taken.push(tx);
        used.add(tx.from);
      } catch {
        // Keep it for a later block.
      }
    }
    return { taken, fees, nextHeight };
  }

  function viewAccount(address) {
    const heightNow = blocks.at(-1).height;
    const account = accounts.get(address) || emptyAccount();
    const view = cloneAccounts(new Map([[address, account]])).get(address);
    mature(view, heightNow);
    const stillLocked = account.pending.filter((item) => item.unlock > heightNow);
    const maturing = stillLocked.reduce((sum, item) => sum + item.amount, 0n);
    const queued = mempool.filter((tx) => tx.from === address).length;
    return {
      address,
      balance: view.balance.toString(),
      maturing: maturing.toString(),
      nonce: account.nonce + queued,
      included: account.nonce,
      lastFaucet: account.lastFaucet,
      pending: stillLocked.map((item) => ({ amount: item.amount.toString(), unlock: item.unlock })),
    };
  }

  return {
    get blocks() { return blocks; },
    get mempool() { return mempool; },
    tip() { return blocks.at(-1); },
    export() { return blocks; },
    supply() { return supply; },
    account: viewAccount,
    block(id) {
      if (/^\d+$/.test(String(id))) return blocks[Number(id)] || null;
      return blocks.find((block) => block.hash === id) || null;
    },
    tx(id) {
      for (let i = blocks.length - 1; i >= 0; i--) {
        const tx = blocks[i].txs.find((item) => item.id === id);
        if (tx) {
          const row = presentTx(tx, blocks[i]);
          row.confirmations = blocks.at(-1).height - blocks[i].height + 1;
          return row;
        }
      }
      const pending = mempool.find((item) => item.id === id);
      return pending ? presentTx(pending, null) : null;
    },
    receipts(address, limit = 80) {
      const rows = [];
      for (let i = blocks.length - 1; i >= 1 && rows.length < limit; i--) {
        for (let j = blocks[i].txs.length - 1; j >= 0; j--) {
          const tx = blocks[i].txs[j];
          if (tx.from !== address && tx.to !== address) continue;
          const row = presentTx(tx, blocks[i]);
          row.confirmations = blocks.at(-1).height - blocks[i].height + 1;
          rows.push(row);
          if (rows.length >= limit) break;
        }
      }
      return rows;
    },
    submit(tx) {
      inspectTx(tx);
      if (mempool.some((item) => item.id === tx.id)) throw new Error('already in mempool');
      for (const block of blocks) {
        if (block.txs.some((item) => item.id === tx.id)) throw new Error('already in a block');
      }
      if (mempool.length >= 100) throw new Error('mempool is full');
      const { copy, nextHeight } = stage(Date.now());
      for (const pending of mempool) {
        try { applyTx(copy, pending, nextHeight, Date.now()); } catch { /* skipped */ }
      }
      applyTx(copy, tx, nextHeight, Date.now());
      mempool.push(tx);
      return { id: tx.id };
    },
    issue(miner, now = Date.now()) {
      const prev = blocks.at(-1);
      const { taken, fees, nextHeight } = takeTxs(now);
      const diff = prev.height === 0 ? BigInt(prev.diff) : retarget(BigInt(prev.diff), now - prev.time);
      const reward = BLOCK_REWARD + fees;
      const txs = [coinbase(miner, reward), ...taken];
      const header = {
        v: 1,
        height: nextHeight,
        prev: prev.hash,
        time: now,
        diff: diff.toString(),
        miner,
        txRoot: txRoot(txs),
      };
      const id = hashHex(`${header.height}|${header.prev}|${header.time}|${header.diff}|${header.miner}|${header.txRoot}`);
      const work = { id, header, txs, reward: reward.toString() };
      issued.set(id, work);
      if (issued.size > 40) {
        const oldest = issued.keys().next().value;
        issued.delete(oldest);
      }
      return work;
    },
    accept(workId, nonce) {
      const work = issued.get(workId);
      if (!work) throw new Error('stale work');
      if (!Number.isInteger(nonce) || nonce < 0 || nonce > 0xffffffff) throw new Error('bad nonce');
      const digest = powHash(work.header, nonce);
      if (!belowTarget(digest, BigInt(work.header.diff))) throw new Error('proof of work is too weak');
      const block = { ...work.header, nonce, hash: hex(digest), txs: work.txs };
      commit(block, { live: true });
      return blocks.at(-1);
    },
    stats() {
      const tip = blocks.at(-1);
      const recent = blocks.slice(-12);
      const gaps = [];
      for (let i = 1; i < recent.length; i++) {
        const gap = recent[i].time - recent[i - 1].time;
        if (gap > 0 && gap < 30 * 60 * 1000) gaps.push(gap);
      }
      const blockTime = gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length / 1000 : TARGET_MS / 1000;
      let receipts = 0;
      let drips = 0;
      let marks = 0;
      for (const block of blocks) {
        for (const tx of block.txs) {
          if (tx.type === 'pay') receipts += 1;
          if (tx.type === 'faucet') drips += 1;
          if (tx.ref) marks += 1;
        }
      }
      const diff = Number(tip.diff);
      return {
        name: 'Tally Chain',
        ticker: 'tTALLY',
        network: 'testnet',
        height: tip.height,
        hash: tip.hash,
        time: tip.time,
        difficulty: tip.diff,
        supply: supply.toString(),
        receipts,
        drips,
        marks,
        accounts: accounts.size,
        mempool: mempool.length,
        blockTime: Math.round(blockTime * 10) / 10,
        hashrate: blockTime > 0 ? Math.round(diff / blockTime) : 0,
        targetTime: TARGET_MS / 1000,
        reward: BLOCK_REWARD.toString(),
        faucet: FAUCET_DRIP.toString(),
        maturity: MATURITY,
        pow: 'SHA-256',
      };
    },
  };
}

export { MATURITY };
