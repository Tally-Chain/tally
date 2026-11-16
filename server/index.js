import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addressFromSecret, belowTarget, isAddress, powHash, randomSeed, seedBytes } from '../client/protocol.js';
import { createChain } from './chain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const clientDir = path.join(root, 'client');
const dataDir = path.join(root, 'data');
const chainFile = process.env.DATA_PATH || path.join(dataDir, 'chain.json');
const port = Number(process.env.PORT || 8344);
const pause = Number(process.env.NODE_PAUSE ?? 25);

const vendor = {
  '/vendor/hashes/': path.join(root, 'node_modules', '@noble', 'hashes', 'esm'),
  '/vendor/curves/': path.join(root, 'node_modules', '@noble', 'curves', 'esm'),
};

function loadChain() {
  if (!fs.existsSync(chainFile)) return createChain();
  const blocks = JSON.parse(fs.readFileSync(chainFile, 'utf8'));
  return createChain({ blocks });
}

function save() {
  fs.mkdirSync(path.dirname(chainFile), { recursive: true });
  const tmp = `${chainFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(chain.export()));
  fs.renameSync(tmp, chainFile);
}

function minerAddress() {
  const file = path.join(dataDir, 'miner.seed');
  fs.mkdirSync(dataDir, { recursive: true });
  const seed = process.env.MINER_SEED || (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '');
  const next = /^[0-9a-f]{64}$/i.test(seed) ? seed.toLowerCase() : randomSeed();
  if (next !== seed) fs.writeFileSync(file, next);
  return addressFromSecret(seedBytes(next));
}

const chain = loadChain();
const nodeMiner = minerAddress();
let mining = true;

function within(rootDir, target) {
  const rel = path.relative(rootDir, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 100_000) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
  res.writeHead(code, {
    'content-type': type,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(payload);
}

function fail(res, error) {
  send(res, 400, { error: error.message || String(error) });
}

function summary(block) {
  return {
    height: block.height,
    hash: block.hash,
    prev: block.prev,
    time: block.time,
    diff: block.diff,
    miner: block.miner,
    nonce: block.nonce,
    txs: block.txs.length,
    txIds: block.txs.map((tx) => tx.id),
  };
}

function recent(limit) {
  const rows = [];
  for (let i = chain.blocks.length - 1; i >= 1 && rows.length < limit; i--) {
    const block = chain.blocks[i];
    for (let j = block.txs.length - 1; j >= 0 && rows.length < limit; j--) {
      const tx = block.txs[j];
      if (tx.type === 'coinbase') continue;
      rows.push({
        id: tx.id, type: tx.type, from: tx.from, to: tx.to, amount: tx.amount,
        memo: tx.memo, ref: tx.ref || '', notch: tx.notch, height: block.height, time: block.time,
      });
    }
  }
  return rows;
}

const pages = {
  '/': 'index.html',
  '/explorer': 'explorer.html',
  '/wallet': 'wallet.html',
  '/mine': 'mine.html',
  '/docs': 'docs.html',
  '/whitepaper': 'whitepaper.html',
};

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

function serveFile(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, {
    'content-type': types[path.extname(file)] || 'application/octet-stream',
    'cache-control': file.includes(`${path.sep}esm${path.sep}`) || file.includes(`${path.sep}node_modules${path.sep}`)
      ? 'public, max-age=86400'
      : 'no-store',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

function serveVendor(res, url) {
  const entry = Object.entries(vendor).find(([prefix]) => url.startsWith(prefix));
  if (!entry) return false;
  const [prefix, dir] = entry;
  const rel = decodeURIComponent(url.slice(prefix.length)).split('?')[0];
  const candidates = [path.resolve(dir, rel)];
  if (!path.extname(rel)) candidates.push(path.resolve(dir, `${rel}.js`));
  for (const file of candidates) {
    if (!within(dir, file) && path.resolve(file) !== path.resolve(dir)) continue;
    if (serveFile(res, file)) return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/stats') return send(res, 200, chain.stats());
    if (req.method === 'GET' && url.pathname === '/api/blocks') {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') || 12)));
      const before = url.searchParams.get('before');
      let list = chain.blocks.filter((block) => block.height > 0);
      if (before) list = list.filter((block) => block.height < Number(before));
      return send(res, 200, list.slice(-limit).reverse().map(summary));
    }
    if (req.method === 'GET' && url.pathname === '/api/receipts') {
      return send(res, 200, recent(Math.min(40, Number(url.searchParams.get('limit') || 12))));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/block/')) {
      const block = chain.block(decodeURIComponent(url.pathname.slice('/api/block/'.length)));
      if (!block) return send(res, 404, { error: 'block not found' });
      return send(res, 200, { ...summary(block), txRoot: block.txRoot, transactions: block.txs });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/tx/')) {
      const tx = chain.tx(decodeURIComponent(url.pathname.slice('/api/tx/'.length)));
      if (!tx) return send(res, 404, { error: 'receipt not found' });
      return send(res, 200, tx);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/account/')) {
      const address = decodeURIComponent(url.pathname.slice('/api/account/'.length));
      if (!isAddress(address)) return send(res, 400, { error: 'bad address' });
      return send(res, 200, { ...chain.account(address), receipts: chain.receipts(address) });
    }
    if (req.method === 'GET' && url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (/^\d+$/.test(q) && chain.block(q)) return send(res, 200, { type: 'block', id: q });
      if (isAddress(q)) return send(res, 200, { type: 'account', id: q });
      if (chain.tx(q)) return send(res, 200, { type: 'tx', id: q });
      const block = chain.block(q);
      if (block) return send(res, 200, { type: 'block', id: block.height });
      return send(res, 404, { error: 'nothing matched' });
    }
    if (req.method === 'GET' && url.pathname === '/api/work') {
      const address = url.searchParams.get('address') || '';
      if (!isAddress(address)) return send(res, 400, { error: 'paste a tally1 address' });
      const work = chain.issue(address);
      return send(res, 200, work);
    }
    if (req.method === 'POST' && url.pathname === '/api/tx') {
      const body = await readBody(req);
      const result = chain.submit(body.tx || body);
      return send(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/work') {
      const body = await readBody(req);
      const block = chain.accept(body.id || body.workId, Number(body.nonce));
      save();
      return send(res, 200, { height: block.height, hash: block.hash, miner: block.miner });
    }
    if (req.method === 'GET' && pages[url.pathname]) {
      return serveFile(res, path.join(clientDir, pages[url.pathname]));
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      return serveFile(res, path.join(clientDir, 'favicon.svg'));
    }
    if (req.method === 'GET' && serveVendor(res, url.pathname)) return;
    if (req.method === 'GET') {
      const file = path.resolve(clientDir, `.${decodeURIComponent(url.pathname)}`);
      if (within(clientDir, file) && serveFile(res, file)) return;
    }
    send(res, 404, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>404 · Tally</title><link rel="stylesheet" href="/style.css"></head><body class="miss"><main><p class="cap">404</p><h1>This page was never notched.</h1><a class="btn solid" href="/">Back home</a></main></body></html>`, 'text/html; charset=utf-8');
  } catch (error) {
    if (!res.headersSent) fail(res, error);
  }
});

async function mineLoop() {
  while (mining) {
    const work = chain.issue(nodeMiner);
    const diff = BigInt(work.header.diff);
    let nonce = Math.floor(Math.random() * 0x100000000);
    let hashes = 0;
    const started = Date.now();
    let found = false;
    while (Date.now() - started < 4000) {
      if (chain.tip().hash !== work.header.prev) break;
      const digest = powHash(work.header, nonce);
      hashes += 1;
      if (belowTarget(digest, diff)) {
        try {
          const block = chain.accept(work.id, nonce);
          save();
          console.log(`block ${block.height}  ${block.hash.slice(0, 12)}…  node miner  ${block.txs.length - 1} receipts`);
          found = true;
        } catch (error) {
          console.log(`node miner missed: ${error.message}`);
        }
        break;
      }
      nonce = (nonce + 1) >>> 0;
      if (hashes % 500 === 0) await new Promise((resolve) => setTimeout(resolve, pause));
    }
    if (!found) await new Promise((resolve) => setTimeout(resolve, pause));
  }
}

server.listen(port, () => {
  const tip = chain.tip();
  console.log(`Tally testnet  http://localhost:${port}`);
  console.log(`height ${tip.height}   node miner ${nodeMiner}`);
  mineLoop();
});

process.on('SIGINT', () => {
  mining = false;
  save();
  process.exit(0);
});
