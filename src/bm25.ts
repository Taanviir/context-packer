const WORD = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g;

/** Splits camelCase and snake_case, so `cachedContentTokenCount` matches "token count". */
export function tokens(text: string): string[] {
  return (text.match(WORD) ?? []).map((t) => t.toLowerCase()).filter((t) => t.length > 1);
}

/** Keyword ranking over paths and full source. It's the baseline the models have to beat, and half of the re-rank pool. */
export function rankBm25(query: string, docs: Map<string, string>, k1 = 1.2, b = 0.75): string[] {
  if (docs.size === 0) return [];
  const counts = new Map<string, Map<string, number>>();
  const lengths = new Map<string, number>();
  const df = new Map<string, number>();
  for (const [path, text] of docs) {
    const c = new Map<string, number>();
    const words = tokens(`${path} ${text}`);
    for (const w of words) c.set(w, (c.get(w) ?? 0) + 1);
    counts.set(path, c);
    lengths.set(path, words.length);
    for (const w of c.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  }
  let total = 0;
  for (const len of lengths.values()) total += len;
  const avg = total / docs.size;
  const n = docs.size;
  const terms = new Set(tokens(query));
  const scores = new Map<string, number>();
  for (const [path, c] of counts) {
    const len = lengths.get(path)!;
    let score = 0;
    for (const t of terms) {
      const tf = c.get(t);
      if (tf === undefined) continue;
      const d = df.get(t)!;
      score += Math.log(1 + (n - d + 0.5) / (d + 0.5)) * tf * (k1 + 1) / (tf + k1 * (1 - b + b * len / avg));
    }
    scores.set(path, score);
  }
  return [...docs.keys()].sort((x, y) => scores.get(y)! - scores.get(x)! || compare(x, y));
}

export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
