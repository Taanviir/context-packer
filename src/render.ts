import type { PackedFile } from "./packer.js";
import type { PackReport } from "./service.js";

/** The text an agent reads: ranked paths first, then what the ranking is and isn't. */
export function renderText(report: PackReport, limit: number, root: string, options: { explain?: boolean } = {}): string {
  const r = report.result;
  const files = r.files.slice(0, limit);
  const lines = [
    `Picked ${files.length} of ${r.candidates.toLocaleString("en-US")} files in ${(report.totalMs / 1000).toFixed(1)} s. Paths are relative to ${root}.`,
  ];
  if (report.provider === "keywords") {
    lines.push("rank  path");
    files.forEach((f, i) => {
      lines.push(`#${f.bm25Rank ?? i + 1}   ${f.path}${f.isTest ? "  (test)" : ""}`);
      if (options.explain) lines.push(`      ${explain(f, report.provider)}`);
    });
  } else {
    lines.push("score  path");
    for (const f of files) {
      const tag = f.role ?? (f.isTest ? "test" : null);
      lines.push(`${f.score.toFixed(2)}   ${f.path}${tag ? `  (${tag})` : ""}`);
      if (options.explain) lines.push(`       ${explain(f, report.provider)}`);
    }
  }
  const notes = [`Provider: ${report.model}; ${report.provider === "keywords" ? "ranked" : "scored"} ${report.scored} candidates.`];
  if (report.provider === "keywords") {
    notes.push("BM25 over paths and full source; ranks are lexical, not model relevance. No model requests, API fee $0.");
  } else if (report.provider === "laya") {
    notes.push(`Laya scored short excerpts from a ${report.scored}-file keyword shortlist in ${report.calls} local requests. API fee $0.`);
    notes.push("Scores combine model relevance and keyword rank.");
  } else {
    notes.push(report.costUsd === null
      ? `${report.calls} Jev requests; token usage and API fee are unavailable.`
      : `${report.calls} Jev requests, ${report.inputTokens.toLocaleString("en-US")} input tokens, about $${report.costUsd.toFixed(4)}.`);
    notes.push("Scores combine model relevance, keyword rank, and a comparison of the top files when available.");
  }
  if (r.failedBatches > 0) notes.push(`WARNING: ${r.failedBatches} scoring batches failed; ranking is incomplete.`);
  notes.push("Read the top files before changing code; request more context if needed.");
  return [...lines, notes.join(" ")].join("\n");
}

/** One line on why a file ranked where it did. */
function explain(f: PackedFile, provider: PackReport["provider"]): string {
  const parts: string[] = [];
  if (provider !== "keywords") {
    parts.push(`${provider} ${f.relevance.toFixed(2)}`);
    parts.push(f.bm25Rank ? `keyword #${f.bm25Rank}` : "no keyword match");
    if (f.choice !== undefined) parts.push(`compared ${f.choice.toFixed(2)}`);
    if (f.roleConfidence !== undefined && f.role) parts.push(`${f.role} ${f.roleConfidence.toFixed(2)}`);
  }
  const words = Object.entries(f.matches).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w, n]) => `${w}×${n}`);
  parts.push(words.length ? `words: ${words.join(" ")}` : "no task words");
  return parts.join(" · ");
}

export function renderJson(report: PackReport, limit: number, root: string): string {
  return JSON.stringify({ root, ...report, result: { ...report.result, files: report.result.files.slice(0, limit) } }, null, 2);
}
