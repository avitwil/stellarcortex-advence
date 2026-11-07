// Line diff for skill updates (FR-SKL-04): unified-style hunks per changed file.

function lcsOps(a: string[], b: string[]): ('=' | '-' | '+')[] {
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) return [...a.map(() => '-' as const), ...b.map(() => '+' as const)];
  const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!);
  const ops: ('=' | '-' | '+')[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push('=');
      i++;
      j++;
    } else if (t[i + 1]![j]! >= t[i]![j + 1]!) {
      ops.push('-');
      i++;
    } else {
      ops.push('+');
      j++;
    }
  }
  while (i++ < n) ops.push('-');
  while (j++ < m) ops.push('+');
  return ops;
}

/** Unified diff of one file with 3 lines of context; '' when equal. */
export function unifiedDiff(path: string, before: string | null, after: string | null): string {
  if (before === after) return '';
  const a = before === null ? [] : before.split('\n');
  const b = after === null ? [] : after.split('\n');
  const ops = lcsOps(a, b);
  const lines: { op: string; text: string; ai: number; bi: number }[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    if (op === '=') lines.push({ op: ' ', text: a[ai]!, ai: ai++, bi: bi++ });
    else if (op === '-') lines.push({ op: '-', text: a[ai]!, ai: ai++, bi });
    else lines.push({ op: '+', text: b[bi]!, ai, bi: bi++ });
  }
  const out = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ ${after === null ? '/dev/null' : `b/${path}`}`];
  for (let k = 0; k < lines.length; ) {
    if (lines[k]!.op === ' ') {
      k++;
      continue;
    }
    const start = Math.max(0, k - 3);
    let end = k;
    while (end < lines.length) {
      if (lines[end]!.op !== ' ') {
        end++;
        continue;
      }
      let run = 0;
      while (end + run < lines.length && lines[end + run]!.op === ' ') run++;
      if (end + run >= lines.length || run > 6) {
        end = Math.min(lines.length, end + 3);
        break;
      }
      end += run;
    }
    const hunk = lines.slice(start, end);
    const aLen = hunk.filter((l) => l.op !== '+').length;
    const bLen = hunk.filter((l) => l.op !== '-').length;
    out.push(`@@ -${hunk[0]!.ai + (aLen ? 1 : 0)},${aLen} +${hunk[0]!.bi + (bLen ? 1 : 0)},${bLen} @@`);
    for (const l of hunk) out.push(`${l.op}${l.text}`);
    k = end;
  }
  return out.join('\n');
}

export function diffFiles(before: Map<string, string>, after: Map<string, string>): string {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.map((p) => unifiedDiff(p, before.get(p) ?? null, after.get(p) ?? null)).filter(Boolean).join('\n');
}
