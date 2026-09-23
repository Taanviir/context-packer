export const MAX_SKETCH_CHARS = 1_200;

// Kotlin-shaped declaration keywords. Other languages keep only lines that happen to use them.
const DECL = /^(?:[\w@]+(?:\([^)]*\))?\s+)*?(class|interface|object|fun|typealias|val|var)\b/;
const SIGNATURE_END = /\s[{=]\s|\s\{$|\{$/;
// Laya's sketches use a wider keyword set that also covers Python, JS and Rust declarations.
const LAYA_DECL = /^(?:[\w@]+(?:\([^)]*\))?\s+)*?(class|interface|object|fun|typealias|val|var|def|function|struct|enum|trait|impl)\b/;
const LAYA_SIGNATURE_END = /\s[{=]\s|\s\{$|\{$|:$/;

/** A ~300-token summary of a file: its path, package, and declarations with the first line of each doc comment. */
export function sketch(path: string, text: string): string {
  return sketchWith(path, text, DECL, SIGNATURE_END);
}

export function layaSketch(path: string, text: string): string {
  return sketchWith(path, text, LAYA_DECL, LAYA_SIGNATURE_END);
}

function sketchWith(path: string, text: string, declaration: RegExp, signatureEnd: RegExp): string {
  const out = [`path: ${path}`];
  let doc: string | null = null;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trimEnd();
    const s = line.trim();
    if (s.startsWith("package ")) out.push(s);
    if (s.startsWith("/**")) doc = removeSuffix(s.slice(3), "*/").trim() || null;
    const indent = line.length - line.trimStart().length;
    if (indent > 8 || s.startsWith("private ") || s.startsWith("//") || s.startsWith("*") || s.startsWith("import ")) {
      if (s.startsWith("* ") && doc === null) doc = s.slice(2).trim();
      continue;
    }
    if (declaration.test(s)) {
      const sig = s.split(signatureEnd)[0];
      out.push("  ".repeat(Math.floor(indent / 4)) + "- " + sig + (doc !== null ? `  // ${doc}` : ""));
      doc = null;
    }
  }
  return out.join("\n").slice(0, MAX_SKETCH_CHARS);
}

function removeSuffix(s: string, suffix: string): string {
  return s.endsWith(suffix) ? s.slice(0, -suffix.length) : s;
}
