import path from "node:path";

export interface BenchRepo {
  name: string;
  url: string;
  language: string;
  /** History is mined up to this commit, so the task set never moves. */
  head: string;
  /** Jev runs cost money; the rest get keyword baselines only. */
  jev: boolean;
  /**
   * Extra subjects to skip for this repository only, added after the first six were frozen so their tasks
   * don't move. Airflow has many lint and type-check commits that aren't feature work.
   */
  skip?: RegExp;
  /** Only mine commits whose parent already had this many source files, for the large-project test. */
  minFiles?: number;
}

export const CACHE = path.join(import.meta.dirname, ".cache");
export const TASKS = path.join(import.meta.dirname, "tasks");
export const RESULTS = path.join(import.meta.dirname, "results");

export const REPOS: BenchRepo[] = [
  { name: "hono", url: "https://github.com/honojs/hono", language: "TypeScript", head: "6cadf7537385c6e3df9cbd6d05c9b84c82ae0361", jev: true },
  { name: "rich", url: "https://github.com/Textualize/rich", language: "Python", head: "9d8f9a372cc5916fd4781fec207ced7ddac2f08f", jev: true },
  { name: "gin", url: "https://github.com/gin-gonic/gin", language: "Go", head: "3b08cd7235bd5ad2f055aa9e38135f111f6c5926", jev: true },
  { name: "prometheus", url: "https://github.com/prometheus/prometheus", language: "Go + TypeScript", head: "5f325dd18c88077d00a0e54554b3433696a24664", jev: true },
  { name: "airflow", url: "https://github.com/apache/airflow", language: "Python", head: "8851f2f05d1f67668d2261ede444ae342f77fd8d", jev: true,
    skip: /\b(flake8|mypy|pylint|ruff|pre-commit|static checks?|type hints?|typing|docstrings?)\b/i, minFiles: 7_000 },
  { name: "vscode", url: "https://github.com/microsoft/vscode", language: "TypeScript", head: "ceeb50ecd8021211707307a9d44cf85120b68c02", jev: true, minFiles: 8_000 },
  { name: "httpx", url: "https://github.com/encode/httpx", language: "Python", head: "b5addb64f0161ff6bfe94c124ef76f6a1fba5254", jev: false },
  { name: "ripgrep", url: "https://github.com/BurntSushi/ripgrep", language: "Rust", head: "3fce3b5bb0236da2df6d99672afb8a719642eca7", jev: false },
];

export function repoDir(name: string): string {
  return path.join(CACHE, "repos", name);
}
