import { belowTarget, powHash } from '/protocol.js';

let stop = false;
self.onmessage = (event) => {
  if (event.data.stop) { stop = true; return; }
  stop = false;
  const { work, start, step } = event.data;
  const diff = BigInt(work.header.diff);
  let nonce = start >>> 0;
  let hashes = 0;
  const t0 = performance.now();
  while (!stop) {
    const digest = powHash(work.header, nonce);
    hashes += 1;
    if (belowTarget(digest, diff)) {
      self.postMessage({ solution: nonce, hashes, ms: performance.now() - t0 });
      return;
    }
    nonce = (nonce + step) >>> 0;
    if (hashes % 1500 === 0) {
      self.postMessage({ hashes, ms: performance.now() - t0 });
      hashes = 0;
    }
  }
};
