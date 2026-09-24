const WORD = /[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g;

/** Splits camelCase and snake_case, so `cachedContentTokenCount` matches "token count". */
export function tokens(text: string): string[] {
  return (text.match(WORD) ?? []).map((t) => t.toLowerCase()).filter((t) => t.length > 1);
}

/**
 * Keyword ranking over paths and full source. It's the baseline the models have to beat, and half of the re-rank pool.
 * Only the query's own terms are counted, so memory stays flat however large the vocabulary is.
 */
export function rankBm25(query: string, docs: Map<string, string>): string[] {
  return scoreBm25(query, docs).map((r) => r.path);
}

export interface Bm25Hit {
  path: string;
  score: number;
  /** Occurrences of each query term that appears in the file. */
  matches: Record<string, number>;
}

export function scoreBm25(query: string, docs: Map<string, string>, k1 = 1.2, b = 0.75): Bm25Hit[] {
  if (docs.size === 0) return [];
  const terms = [...new Set(tokens(query))];
  const index = new Map(terms.map((t, i) => [t, i]));
  const paths = [...docs.keys()];
  const tf = new Float64Array(paths.length * terms.length);
  const lengths = new Float64Array(paths.length);
  const df = new Float64Array(terms.length);
  paths.forEach((path, d) => {
    let length = 0;
    const row = d * terms.length;
    for (const m of `${path} ${docs.get(path)!}`.matchAll(WORD)) {
      const word = m[0];
      if (word.length < 2) continue;
      length++;
      const t = index.get(word.toLowerCase());
      if (t !== undefined && tf[row + t]!++ === 0) df[t]!++;
    }
    lengths[d] = length;
  });
  const avg = lengths.reduce((a, x) => a + x, 0) / paths.length;
  const idf = terms.map((_, t) => Math.log(1 + (paths.length - df[t]! + 0.5) / (df[t]! + 0.5)));
  const scores = paths.map((_, d) => {
    let score = 0;
    for (let t = 0; t < terms.length; t++) {
      const f = tf[d * terms.length + t]!;
      if (f > 0) score += idf[t]! * f * (k1 + 1) / (f + k1 * (1 - b + b * lengths[d]! / avg));
    }
    return score;
  });
  const order = paths.map((_, d) => d).sort((x, y) => scores[y]! - scores[x]! || compare(paths[x]!, paths[y]!));
  return order.map((d) => {
    const matches: Record<string, number> = {};
    terms.forEach((term, t) => {
      const f = tf[d * terms.length + t]!;
      if (f > 0) matches[term] = f;
    });
    return { path: paths[d]!, score: scores[d]!, matches };
  });
}

export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
