import { execFileSync, spawn } from "node:child_process";
import { isSourcePath, looksBinary, MAX_BYTES, type SourceFile } from "../src/files.js";

export function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

/**
 * The tool's candidate set as it was at `sha`: the same extension, size, symlink and binary filters
 * that `collect` applies to a working tree, read straight from git objects.
 */
export async function snapshot(repo: string, sha: string): Promise<SourceFile[]> {
  const entries = git(repo, ["ls-tree", "-r", "-l", "-z", sha]).split("\0").filter(Boolean).flatMap((line) => {
    const [meta, path] = line.split("\t") as [string, string];
    const [mode, type, object, size] = meta.split(/\s+/) as [string, string, string, string];
    const ok = type === "blob" && mode !== "120000" && Number(size) <= MAX_BYTES && isSourcePath(path);
    return ok ? [{ path, object }] : [];
  });
  const blobs = await catFile(repo, entries.map((e) => e.object));
  return entries.flatMap(({ path, object }) => {
    const bytes = blobs.get(object)!;
    return looksBinary(bytes) ? [] : [{ path, text: Buffer.from(bytes).toString("utf8") }];
  });
}

async function catFile(repo: string, objects: string[]): Promise<Map<string, Uint8Array>> {
  const child = spawn("git", ["cat-file", "--batch"], { cwd: repo, stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.end(objects.join("\n") + "\n");
  const chunks: Buffer[] = [];
  for await (const chunk of child.stdout) chunks.push(chunk as Buffer);
  const out = Buffer.concat(chunks);
  const blobs = new Map<string, Uint8Array>();
  let at = 0;
  while (at < out.length) {
    const eol = out.indexOf(10, at);
    const [object, , size] = out.subarray(at, eol).toString().split(" ") as [string, string, string];
    const start = eol + 1;
    blobs.set(object, out.subarray(start, start + Number(size)));
    at = start + Number(size) + 1;
  }
  return blobs;
}
