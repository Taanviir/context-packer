import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export const MAX_BYTES = 100_000;

/** Extensions of languages worth ranking. Docs, config and data files are left out on purpose. */
const SOURCE_EXTENSIONS = new Set([
  "kt", "kts", "java", "scala", "groovy", "clj", "cljs",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte",
  "py", "rb", "php", "pl", "lua", "r", "jl",
  "go", "rs", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "m", "mm", "swift", "zig",
  "cs", "fs", "vb", "dart", "ex", "exs", "erl", "hs", "ml", "mli", "elm",
  "sh", "bash", "zsh", "ps1", "gradle", "proto", "graphql", "tf", "sol",
]);

/** Skipped when walking a directory that isn't a git checkout. */
const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", "out", "target", "vendor", "coverage",
  ".venv", "venv", "__pycache__", ".gradle", ".idea", ".next", ".nuxt", ".cache", ".tox", "bin", "obj",
]);

/** Files that mark the root of a project, including one package inside a monorepo. */
const MANIFESTS = [
  "package.json", "deno.json", "pyproject.toml", "setup.py", "go.mod", "Cargo.toml", "pom.xml", "build.gradle",
  "build.gradle.kts", "settings.gradle.kts", "composer.json", "Gemfile", "mix.exs", "Package.swift", "CMakeLists.txt",
];

/**
 * The project a directory belongs to: the nearest ancestor with a project manifest, stopping at the git
 * root. Started in `repo/src`, that's the repo; started in `repo/packages/web`, it's that package.
 */
export function projectRoot(start: string): string {
  const dir = path.resolve(start);
  const top = gitTop(dir);
  if (!top) return dir;
  for (let d = dir; ; d = path.dirname(d)) {
    if (d === top || MANIFESTS.some((m) => existsSync(path.join(d, m)))) return d;
    if (path.dirname(d) === d || !isInside(top, d)) return top;
  }
}

function gitTop(dir: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export interface SourceFile {
  /** Project-relative, forward slashes. */
  path: string;
  text: string;
}

export interface CollectOptions {
  /** Allowlist such as ["kt"]. Defaults to CONTEXT_PACKER_EXTENSIONS, then every supported language. */
  extensions?: string[];
}

export function extensionsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const list = env.CONTEXT_PACKER_EXTENSIONS?.split(",")
    .map((e) => e.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean);
  return list && list.length > 0 ? list : undefined;
}

/**
 * Source files under root: tracked and untracked-but-not-ignored files in a git checkout, otherwise a
 * directory walk. Symlinks, binaries and files over 100,000 bytes are left out.
 */
export async function collect(root: string, options: CollectOptions = {}): Promise<SourceFile[]> {
  const base = await realpath(root);
  const only = options.extensions ?? extensionsFromEnv();
  const listed = (gitFiles(base) ?? (await walk(base))).filter((p) => isSourcePath(p, only));
  const files = await Promise.all(listed.map((rel) => readSource(base, rel)));
  return files.filter((f): f is SourceFile => f !== null).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function isSourcePath(p: string, only?: string[]): boolean {
  const ext = path.extname(p).slice(1).toLowerCase();
  return only ? only.includes(ext) : SOURCE_EXTENSIONS.has(ext);
}

/** A NUL byte means binary, as git decides it. */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

function gitFiles(base: string): string[] | null {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: base, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
    });
    return [...new Set(out.split("\0").filter(Boolean))];
  } catch {
    return null;
  }
}

async function walk(base: string, rel = ""): Promise<string[]> {
  const entries = await readdir(path.join(base, rel), { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...(await walk(base, child)));
    } else if (entry.isFile()) {
      found.push(child);
    }
  }
  return found;
}

const cache = new Map<string, { mtimeMs: number; size: number; text: string | null }>();

async function readSource(base: string, rel: string): Promise<SourceFile | null> {
  const full = path.join(base, rel);
  try {
    const stat = await lstat(full);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    if (!isInside(base, await realpath(full))) return null;
    const hit = cache.get(full);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text === null ? null : { path: rel, text: hit.text };
    const bytes = await readFile(full);
    const text = looksBinary(bytes) ? null : bytes.toString("utf8");
    cache.set(full, { mtimeMs: stat.mtimeMs, size: stat.size, text });
    return text === null ? null : { path: rel, text };
  } catch {
    return null;
  }
}

/** Rejects absolute paths, `..` and anything that resolves outside root, including through a symlinked parent. */
export function isInside(base: string, resolved: string): boolean {
  const relative = path.relative(base, resolved);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
