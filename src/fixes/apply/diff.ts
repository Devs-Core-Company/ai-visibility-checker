/**
 * Minimal unified diff (git-style) for showing planned file changes. Line-based LCS after
 * trimming the common prefix/suffix; very large rewrites fall back to a whole-file hunk.
 */

type Op = { t: ' ' | '-' | '+'; line: string };

const MAX_CELLS = 4_000_000;

function splitLines(s: string): string[] {
  if (!s) return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function editScript(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const mid: Op[] = [];
  if (A.length * B.length > MAX_CELLS) {
    for (const l of A) mid.push({ t: '-', line: l });
    for (const l of B) mid.push({ t: '+', line: l });
  } else {
    const n = A.length;
    const m = B.length;
    const dp = new Int32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i * (m + 1) + j] =
          A[i] === B[j]
            ? dp[(i + 1) * (m + 1) + j + 1] + 1
            : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) {
        mid.push({ t: ' ', line: A[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
        mid.push({ t: '-', line: A[i++] });
      } else {
        mid.push({ t: '+', line: B[j++] });
      }
    }
    while (i < n) mid.push({ t: '-', line: A[i++] });
    while (j < m) mid.push({ t: '+', line: B[j++] });
  }
  return [
    ...a.slice(0, pre).map((line) => ({ t: ' ' as const, line })),
    ...mid,
    ...a.slice(a.length - suf).map((line) => ({ t: ' ' as const, line })),
  ];
}

export function unifiedDiff(
  path: string,
  before: string | null,
  after: string | null,
  context = 3,
): string {
  const a = splitLines(before ?? '');
  const b = splitLines(after ?? '');
  const ops = editScript(a, b);
  if (!ops.some((o) => o.t !== ' ')) return '';
  const header = [
    `--- ${before === null ? '/dev/null' : `a/${path}`}`,
    `+++ ${after === null ? '/dev/null' : `b/${path}`}`,
  ];
  // index of each op in a and b
  const pos: { ai: number; bi: number }[] = [];
  let ai = 0;
  let bi = 0;
  for (const o of ops) {
    pos.push({ ai, bi });
    if (o.t !== '+') ai++;
    if (o.t !== '-') bi++;
  }
  const changed = ops.map((o, i) => (o.t !== ' ' ? i : -1)).filter((i) => i >= 0);
  const hunks: string[] = [];
  let k = 0;
  while (k < changed.length) {
    let start = Math.max(0, changed[k] - context);
    let end = Math.min(ops.length - 1, changed[k] + context);
    while (k + 1 < changed.length && changed[k + 1] - context <= end + 1) {
      k++;
      end = Math.min(ops.length - 1, changed[k] + context);
    }
    k++;
    const slice = ops.slice(start, end + 1);
    const aLen = slice.filter((o) => o.t !== '+').length;
    const bLen = slice.filter((o) => o.t !== '-').length;
    const aStart = aLen ? pos[start].ai + 1 : pos[start].ai;
    const bStart = bLen ? pos[start].bi + 1 : pos[start].bi;
    hunks.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`, ...slice.map((o) => o.t + o.line));
    start = end + 1;
  }
  return [...header, ...hunks].join('\n') + '\n';
}
