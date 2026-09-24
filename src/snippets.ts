import { tokens } from "./bm25.js";
import { STOPWORDS } from "./words.js";

export interface Snippet {
  /** 1-based, inclusive. */
  start: number;
  end: number;
  text: string;
}

export interface SnippetOptions {
  /** Lines per window. */
  window?: number;
  /** Windows kept per file. */
  perFile?: number;
}

/**
 * The parts of a file most about the task: fixed windows scored by how many distinct task words they contain,
 * then by how often. Distinct words count more, so a window that mentions "retry", "backoff" and "jitter" once
 * each beats one that says "retry" twenty times. Windows never overlap and come back in file order.
 */
export function snippets(task: string, text: string, options: SnippetOptions = {}): Snippet[] {
  const window = options.window ?? 24;
  const perFile = options.perFile ?? 2;
  const terms = new Set(tokens(task).filter((t) => !STOPWORDS.has(t)));
  if (terms.size === 0) return [];
  const lines = text.split(/\r\n|\r|\n/);
  const perLine = lines.map((line) => tokens(line).filter((t) => terms.has(t)));
  const step = Math.max(1, Math.floor(window / 3));
  const scored: Array<{ start: number; score: number }> = [];
  for (let start = 0; start < lines.length; start += step) {
    const words = perLine.slice(start, start + window).flat();
    if (words.length === 0) continue;
    scored.push({ start, score: new Set(words).size * 100 + words.length });
  }
  scored.sort((a, b) => b.score - a.score || a.start - b.start);
  const picked: number[] = [];
  for (const { start } of scored) {
    if (picked.length === perFile) break;
    if (picked.every((p) => Math.abs(p - start) >= window)) picked.push(start);
  }
  return picked.sort((a, b) => a - b).map((start) => {
    const end = Math.min(lines.length, start + window);
    return { start: start + 1, end, text: lines.slice(start, end).join("\n") };
  });
}
