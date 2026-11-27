// Fast drop-in replacement for makefun-diff 1.0.0.
//
// How it stays byte-identical to the reference while running faster:
//  * Lines are interned to integer ids through one shared Map (built on
//    String.split, the cheapest tokenizer V8 has), so every equality
//    test in the search is an integer compare on typed arrays.  A final
//    line without "\n" gets its id shifted by a large offset, which
//    keeps it distinct from the same text with a newline while letting
//    two bare final lines compare equal.  Line offsets are recorded so
//    patch output slices the original texts lazily — only lines that
//    land in a hunk are ever sliced.
//  * Common prefix / suffix are trimmed on the id arrays first.
//  * The middle is solved with the reference's own Myers greedy search:
//    furthest-reaching paths, deletion wins ties, no edge pruning,
//    snakes followed to their end.  The reference allocates a linked
//    list node per diagonal per edit distance; here V lives in two flat
//    Int32Arrays (only the band around the diagonal is ever read or
//    written, so nothing is cleared between distances), and the history
//    the backtrack needs — one V snapshot plus one choice byte per
//    state — is written into two flat triangular buffers indexed by
//    d*d + k + d and grown by doubling.  Positions fit in Uint16 while
//    the middle has at most 65535 lines (contest cases have 20k-40k),
//    Int32 otherwise.
//  * Patch assembly follows the reference exactly: deletions before
//    insertions inside a change run, 3 lines of context, runs at most
//    6 kept lines apart share a hunk, "%" after a final line that has
//    no newline, identical texts produce the header line alone.

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;
const BARE = 0x40000000;

/** Intern one text: returns { ids, offsets, count } using the shared map. */
function intern(text, map) {
  const parts = text.split('\n');
  const bareLast = parts[parts.length - 1] !== '';
  const count = bareLast ? parts.length : parts.length - 1;
  const ids = new Int32Array(count);
  const offsets = new Int32Array(count + 1);
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const part = parts[i];
    let id = map.get(part);
    if (id === undefined) {
      id = map.size;
      map.set(part, id);
    }
    ids[i] = bareLast && i === count - 1 ? id + BARE : id;
    offsets[i] = pos;
    pos += part.length + 1;
  }
  offsets[count] = text.length;
  return { ids, offsets, count };
}

/**
 * The exact Myers greedy search of the reference over the middle slices
 * a[0..na) and b[0..nb) (integer ids).  Returns merged runs.
 */
function myersRuns(a, na, b, nb) {
  const maxD = na + nb;
  const width = 2 * maxD + 3;
  const offset = maxD + 1;
  let vPrev = new Int32Array(width);
  let vCur = new Int32Array(width);

  // Triangular history buffers, index d*d + (k + d), grown by doubling.
  const Small = na <= 65535;
  let capD = na + nb > 20000 ? 4096 : 1024;
  let histV = Small ? new Uint16Array((capD + 1) * (capD + 1)) : new Int32Array((capD + 1) * (capD + 1));
  let histC = new Uint8Array((capD + 1) * (capD + 1));

  // d = 0: the initial snake from (0, 0).
  let x = 0;
  while (x < na && x < nb && a[x] === b[x]) x++;
  vPrev[offset] = x;
  histV[0] = x;
  if (x >= na && x >= nb) return x > 0 ? [{ kind: KEEP, count: x }] : [];

  let foundD = -1;
  for (let d = 1; d <= maxD && foundD === -1; d++) {
    if (d > capD) {
      while (d > capD) capD *= 2;
      const nv = Small ? new Uint16Array((capD + 1) * (capD + 1)) : new Int32Array((capD + 1) * (capD + 1));
      nv.set(histV);
      histV = nv;
      const nc = new Uint8Array((capD + 1) * (capD + 1));
      nc.set(histC);
      histC = nc;
    }
    const base = d * d;
    const lo = offset - d;
    const hi = offset + d;

    // Edge k = -d: insertion only, from the path on diagonal -d + 1.
    {
      const pv = vPrev[lo + 1];
      if (pv >= 0 && pv - (-d + 1) < nb) {
        let xx = pv;
        let yy = pv + d; // prev y = pv - (-d + 1); the insertion adds one
        while (xx < na && yy < nb && a[xx] === b[yy]) { xx++; yy++; }
        vCur[lo] = xx;
        histV[base] = xx;
        histC[base] = 2;
        if (xx >= na && yy >= nb) foundD = d;
      } else {
        vCur[lo] = -1;
        histV[base] = 0;
        histC[base] = 0;
      }
    }

    let hIdx = base + 2;
    for (let j = lo + 2; foundD === -1 && j < hi; j += 2, hIdx += 2) {
      const k = j - offset;
      const pvDel = vPrev[j - 1];
      const pvIns = vPrev[j + 1];
      const canDel = pvDel >= 0 && pvDel < na;
      const canIns = pvIns >= 0 && pvIns - (k + 1) < nb;
      let xx;
      let pick;
      if (canDel && (!canIns || pvDel + 1 >= pvIns)) {
        xx = pvDel + 1;
        pick = 1;
      } else if (canIns) {
        xx = pvIns;
        pick = 2;
      } else {
        vCur[j] = -1;
        histV[hIdx] = 0;
        histC[hIdx] = 0;
        continue;
      }
      let yy = xx - k;
      while (xx < na && yy < nb && a[xx] === b[yy]) { xx++; yy++; }
      vCur[j] = xx;
      histV[hIdx] = xx;
      histC[hIdx] = pick;
      if (xx >= na && yy >= nb) foundD = d;
    }

    // Edge k = d: deletion only, from the path on diagonal d - 1.
    if (foundD === -1) {
      const pv = vPrev[hi - 1];
      if (pv >= 0 && pv < na) {
        let xx = pv + 1;
        let yy = xx - d;
        while (xx < na && yy < nb && a[xx] === b[yy]) { xx++; yy++; }
        vCur[hi] = xx;
        histV[base + 2 * d] = xx;
        histC[base + 2 * d] = 1;
        if (xx >= na && yy >= nb) foundD = d;
      } else {
        vCur[hi] = -1;
        histV[base + 2 * d] = 0;
        histC[base + 2 * d] = 0;
      }
    }

    // Swap the V arrays.  Stale entries outside the band just written
    // are never read: reads at distance d + 1 touch only indices the
    // band of distance d wrote, plus edge slots handled explicitly.
    const t = vPrev;
    vPrev = vCur;
    vCur = t;
  }
  if (foundD === -1) throw new Error('makefun-diff-fast: search ended without reaching both ends');

  // Backtrack from (na, nb) through the snapshots: each step contributes
  // its snake (kept lines) and its single edit, in reverse order.
  const rev = [];
  let bx = na;
  let by = nb;
  for (let d = foundD; d >= 1; d--) {
    const k = bx - by;
    const pick = histC[d * d + k + d];
    const prevBase = (d - 1) * (d - 1);
    let prevX;
    let editKind;
    if (pick === 1) {
      prevX = histV[prevBase + (k - 1) + (d - 1)];
      editKind = DELETE;
    } else {
      prevX = histV[prevBase + (k + 1) + (d - 1)];
      editKind = INSERT;
    }
    const afterEditX = editKind === DELETE ? prevX + 1 : prevX;
    const snake = bx - afterEditX;
    if (snake > 0) rev.push(KEEP, snake);
    rev.push(editKind, 1);
    bx = prevX;
    by = prevX - (pick === 1 ? k - 1 : k + 1);
  }
  if (bx > 0) rev.push(KEEP, bx);

  const runs = [];
  for (let i = rev.length - 2; i >= 0; i -= 2) {
    const kind = rev[i];
    const count = rev[i + 1];
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === kind) last.count += count;
    else runs.push({ kind, count });
  }
  return runs;
}

/** makefun-diff 1.0.0's patch of input.old into input.new, computed fast. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const oldText = input.old;
  const newText = input.new;
  const map = new Map();
  const A = intern(oldText, map);
  const B = intern(newText, map);
  const a = A.ids;
  const b = B.ids;
  const n = A.count;
  const m = B.count;

  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;

  const na = n - prefix - suffix;
  const nb = m - prefix - suffix;
  let midRuns;
  if (na === 0 && nb === 0) midRuns = [];
  else if (na === 0) midRuns = [{ kind: INSERT, count: nb }];
  else if (nb === 0) midRuns = [{ kind: DELETE, count: na }];
  else midRuns = myersRuns(a.subarray(prefix, prefix + na), na, b.subarray(prefix, prefix + nb), nb);

  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  for (const r of midRuns) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === r.kind) last.count += r.count;
    else runs.push({ kind: r.kind, count: r.count });
  }
  if (suffix > 0) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === KEEP) last.count += suffix;
    else runs.push({ kind: KEEP, count: suffix });
  }

  // Change runs between kept lines, grouped exactly as the reference.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  const CONTEXT = 3;
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h === undefined ? undefined : h[h.length - 1];
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) pushLine(out, '=', oldText, A.offsets, at);
      for (let i = 0; i < c.dels; i++) pushLine(out, '-', oldText, A.offsets, c.o + i);
      for (let i = 0; i < c.ins; i++) pushLine(out, '+', newText, B.offsets, c.p + i);
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) pushLine(out, '=', oldText, A.offsets, at);
  }
  return out.join('');
}

/** One patch body line: op + the original line, plus "%" when it had no newline. */
function pushLine(out, op, text, offsets, i) {
  const line = text.slice(offsets[i], offsets[i + 1]);
  out.push(line.endsWith('\n') ? op + line : op + line + '\n%\n');
}
