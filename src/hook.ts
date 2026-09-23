import { renderText } from "./render.js";
import { ContextPacker, parseProvider } from "./service.js";

/**
 * Claude Code UserPromptSubmit hook. Strong agents tend to trust their own search and skip an offered
 * tool, so this ranks the project before the agent sees the prompt and hands it the files as context.
 * Returns null, meaning "add nothing", for short prompts, slash commands and every failure.
 */
export async function runHook(input: string, env: NodeJS.ProcessEnv = process.env, packer = new ContextPacker(env)): Promise<string | null> {
  try {
    const payload = JSON.parse(input) as { prompt?: string; cwd?: string };
    const prompt = (payload.prompt ?? "").trim();
    if (prompt.split(/\s+/).length < 4 || prompt.startsWith("/")) return null;
    const root = payload.cwd || process.cwd();
    const provider = parseProvider(env.CONTEXT_PACKER_HOOK_PROVIDER || "keywords");
    const limit = Number(env.CONTEXT_PACKER_HOOK_LIMIT || 8);
    const deadline = Number(env.CONTEXT_PACKER_HOOK_DEADLINE || 25);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return null;
    if (!Number.isFinite(deadline) || deadline <= 0) return null;

    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), deadline * 1000); });
    const report = await Promise.race([packer.pack({ task: prompt, root, provider, limit }), timeout]).finally(() => clearTimeout(timer));
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
