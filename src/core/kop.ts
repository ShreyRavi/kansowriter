/**
 * KOP: Kansowriter op format, "v1-draft" until the v0.1 freeze (R19).
 *
 *   op   = [dt, d, ...runs]
 *   dt   = ms from the end of the previous op to the start of this one (integer >= 0)
 *   d    = ms this op took to type (0 for single edits)            (R18)
 *   run  = n >= 0 (retain n)  |  "text" (insert)  |  -n (delete n)
 *
 * Lengths and positions are UTF-16 code units (R2-5). The retained and deleted
 * runs of an op must cover exactly the document length before it.
 *
 *   before: "Hello world"      op: [120, 0, 6, -5, "there"]
 *            └retain 6┘└del 5┘ + insert "there"  →  "Hello there"
 */

export type Run = number | string;
export type Op = [dt: number, d: number, ...runs: Run[]];

export function runsOf(op: Op): Run[] {
  return op.slice(2) as Run[];
}

/** Length of the document after the op (retain + insert). */
export function targetLength(runs: Run[]): number {
  let n = 0;
  for (const r of runs) {
    if (typeof r === 'string') n += r.length;
    else if (r > 0) n += r;
  }
  return n;
}

/**
 * Shape of an untrusted op, without a document: dt and d are non-negative safe integers, each run
 * is a non-empty string or a non-zero safe integer. Returns the length it covers, or null.
 */
export function opCoverage(op: unknown): number | null {
  if (!Array.isArray(op) || op.length < 2) return null;
  const [dt, d] = op;
  if (!Number.isSafeInteger(dt) || dt < 0 || !Number.isSafeInteger(d) || d < 0) return null;
  let covered = 0;
  for (let i = 2; i < op.length; i++) {
    const r = op[i];
    if (typeof r === 'string') {
      if (r.length === 0) return null;
    } else if (typeof r === 'number') {
      if (!Number.isSafeInteger(r) || r === 0) return null;
      covered += Math.abs(r);
    } else return null;
  }
  return covered;
}

/** Structural validation of an untrusted op against the current document length. */
export function isValidOp(op: unknown, docLength: number): op is Op {
  return opCoverage(op) === docLength;
}

export function apply(doc: string, op: Op): string {
  let pos = 0;
  let out = '';
  for (const r of runsOf(op)) {
    if (typeof r === 'string') out += r;
    else if (r > 0) {
      out += doc.slice(pos, pos + r);
      pos += r;
    } else pos -= r;
  }
  if (pos !== doc.length) throw new Error(`KOP op covers ${pos} of ${doc.length} code units`);
  return out;
}

/** Merge adjacent runs of the same kind and drop empties; inserts precede deletes at the same point. */
export function normalize(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (r === 0 || r === '') continue;
    const last = out[out.length - 1];
    if (typeof r === 'string') {
      if (typeof last === 'string') out[out.length - 1] = last + r;
      else if (typeof last === 'number' && last < 0) {
        // keep canonical order: insert before an adjacent delete
        const prev = out[out.length - 2];
        if (typeof prev === 'string') out[out.length - 2] = prev + r;
        else out.splice(out.length - 1, 0, r);
      } else out.push(r);
    } else if (typeof last === 'number' && Math.sign(last) === Math.sign(r)) out[out.length - 1] = last + r;
    else out.push(r);
  }
  return out;
}

/** Compose runs a then b (b applies to the result of a) into one run list. */
export function compose(a: Run[], b: Run[]): Run[] {
  const A = normalize(a);
  const B = normalize(b);
  const out: Run[] = [];
  let i = 0;
  let j = 0;
  let x: Run | undefined = A[i++];
  let y: Run | undefined = B[j++];
  while (x !== undefined || y !== undefined) {
    if (typeof x === 'number' && x < 0) {
      out.push(x);
      x = A[i++];
      continue;
    }
    if (typeof y === 'string') {
      out.push(y);
      y = B[j++];
      continue;
    }
    if (x === undefined || y === undefined) throw new Error('compose: length mismatch');
    if (typeof x === 'string') {
      const n = x.length;
      if (y > 0) {
        // b retains over text a inserted
        if (n > y) {
          out.push(x.slice(0, y));
          x = x.slice(y);
          y = B[j++];
        } else if (n === y) {
          out.push(x);
          x = A[i++];
          y = B[j++];
        } else {
          out.push(x);
          y = y - n;
          x = A[i++];
        }
      } else {
        // b deletes text a inserted: they cancel
        const del = -y;
        if (n > del) {
          x = x.slice(del);
          y = B[j++];
        } else if (n === del) {
          x = A[i++];
          y = B[j++];
        } else {
          y = -(del - n);
          x = A[i++];
        }
      }
      continue;
    }
    // x is a retain (> 0)
    if (y > 0) {
      const m = Math.min(x, y);
      out.push(m);
      x = x - m || A[i++];
      y = y - m || B[j++];
    } else {
      const m = Math.min(x, -y);
      out.push(-m);
      x = x - m || A[i++];
      y = y + m || B[j++];
    }
  }
  return normalize(out);
}

/** The single insertion `{at, text}` when runs only insert text at one position, else null (used for typing merges). */
export function insertionOf(runs: Run[]): { at: number; text: string } | null {
  let at = 0;
  let text: string | null = null;
  for (const r of runs) {
    if (typeof r === 'string') {
      if (text !== null) return null;
      text = r;
    } else if (r < 0) return null;
    else if (text === null) at += r;
  }
  return text === null ? null : { at, text };
}

export function makeOp(dt: number, d: number, runs: Run[]): Op {
  return [Math.max(0, Math.round(dt)), Math.max(0, Math.round(d)), ...normalize(runs)];
}
