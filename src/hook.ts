import { projectRoot } from "./files.js";
import { renderText } from "./render.js";
import { STOPWORDS } from "./words.js";
import { ContextPacker, parseProvider } from "./service.js";

/** Replies to the agent rather than new work: "thanks", "commit that", "looks good". */
const CONVERSATIONAL = /^(?:thanks|thank you|thx|ok(?:ay)?|yes|yep|no|nope|sure|great|nice|cool|perfect|continue|go ahead|go on|proceed|looks good|lgtm|sounds good|do it|commit|push|undo|stop|wait)\b/i;

export type Skip = "short" | "command" | "conversational" | "no-match";

/** Why the hook would add nothing for this prompt, before any files are read. */
export function skipReason(prompt: string): Skip | null {
  if (prompt.startsWith("/")) return "command";
  if (prompt.split(/\s+/).length < 4) return "short";
  // Only short ones: "Stop writing to the stream after the client aborts" is a task, not a reply.
  if (CONVERSATIONAL.test(prompt) && prompt.split(/\s+/).length <= 8) return "conversational";
  return null;
}

/**
 * Claude Code UserPromptSubmit hook. Agents tend to trust their own search and skip an offered tool,
 * so this ranks the project before the agent sees the prompt and hands it the files as context.
 * Returns null, meaning "add nothing", for prompts that aren't about this code and for every failure.
 */
export async function runHook(input: string, env: NodeJS.ProcessEnv = process.env, packer = new ContextPacker(env)): Promise<string | null> {
  try {
    const payload = JSON.parse(input) as { prompt?: string; cwd?: string };
    const prompt = (payload.prompt ?? "").trim();
    if (skipReason(prompt)) return null;
    const root = projectRoot(payload.cwd || env.CLAUDE_PROJECT_DIR || process.cwd());
    const provider = parseProvider(env.CONTEXT_PACKER_HOOK_PROVIDER || "keywords");
    const limit = Number(env.CONTEXT_PACKER_HOOK_LIMIT || 8);
    const deadline = Number(env.CONTEXT_PACKER_HOOK_DEADLINE || 25);
    const code = Number(env.CONTEXT_PACKER_HOOK_CODE || 0);
    if (!Number.isInteger(code) || code < 0 || code > 10) return null;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return null;
    if (!Number.isFinite(deadline) || deadline <= 0) return null;

    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deadline * 1000); });
    const work = async () => {
      // A free keyword pass first: if no distinctive word of the prompt occurs in the project, there is
      // nothing to point at, and a model provider would only spend money ranking noise.
      const keywords = await packer.pack({ task: prompt, root, provider: "keywords", limit });
      if (!keywords.result.files.some((f) => Object.keys(f.matches).some((w) => !STOPWORDS.has(w)))) return null;
      if (provider === "keywords" && code === 0) return keywords;
      return packer.pack({ task: prompt, root, provider, limit, code });
    };
    const report = await Promise.race([work(), timeout]).finally(() => clearTimeout(timer));
    if (!report || report.result.files.length === 0) return null;
    const seconds = (performance.now() - started) / 1000;
    return JSON.stringify({
      systemMessage: `Context Packer ranked the project for this request in ${seconds.toFixed(1)} s`,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "Context Packer selected likely source files for this task. Start with these files and verify relevance by reading them.\n\n"
          + renderText(report, limit, root),
      },
    });
  } catch {
    return null;
  }
}
