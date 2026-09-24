// Per-language sketch rules, tried as a replacement for src/sketch.ts. On the benchmark it tied on recall
// and sent more tokens, so it was not shipped; it stays here so that result can be reproduced.
import path from "node:path";

export const MAX_SKETCH_CHARS = 1_200;
/** Deeper lines are bodies, not declarations worth listing. */
const MAX_INDENT = 8;
/** Long docs crowd out declarations under the length cap. */
const MAX_DOC_CHARS = 80;
/** Tool directives, not documentation. */
const DIRECTIVE = /^(?:eslint|@ts-|prettier|biome-ignore|istanbul|c8 |noinspection|nolint|type:\s*ignore|noqa|pylint|pragma|region|endregion|#\[)/i;

interface Rule {
  re: RegExp;
  /** Declarations like Go's `var` or a TypeScript `const` only count at the top level. */
  topOnly?: boolean;
}

interface Language {
  rules: Rule[];
  /** Where a signature ends: the rest of the line is body. */
  end: RegExp;
  /** Comment lines that document the declaration below them, e.g. `///` or `#`. */
  lineDoc?: RegExp;
  /** Lines never listed: private members, imports. */
  skip?: RegExp;
  docstrings?: boolean;
}

const JVM_MODIFIERS = "(?:@\\w+(?:\\([^)]*\\))?\\s+)*(?:(?:public|protected|internal|static|final|abstract|sealed|override|open|data|inline|value|enum|annotation|companion|suspend|operator|infix|lateinit|const|virtual|async|partial|readonly|implicit|lazy|case|default|synchronized|external|expect|actual)\\s+)*";
const CONTROL = "(?!(?:if|for|while|switch|catch|return|else|do|try|new|throw|await|yield|typeof|delete|void|case|function)\\b)";

const C_STYLE_END = /\s[{=]\s|\s\{$|\{$/;

const KOTLIN: Language = {
  rules: [{ re: /^(?:[\w@]+(?:\([^)]*\))?\s+)*?(class|interface|object|fun|typealias|val|var)\b/ }],
  end: /\s[{=]\s|\s\{$|\{$/,
  lineDoc: /^\/\/\/?\s?/,
  skip: /^private\s/,
};

const JVM: Language = {
  rules: [
    { re: new RegExp(`^${JVM_MODIFIERS}(?:class|interface|enum|record|struct|object|trait|namespace|def|val|var|fun|typealias|extension|mixin|delegate|event)\\b`) },
    // A method needs a type before its name, so calls such as `foo.bar(` are never mistaken for one.
    { re: new RegExp(`^${JVM_MODIFIERS}${CONTROL}[\\w<>\\[\\],.?]+\\s+\\w+\\s*\\(`) },
    { re: /^(?:public|protected|internal)\s[^=;(]*\{\s*get/ },
  ],
  end: /\s[{=]\s|\s\{$|\{$|\s=>\s|\sthrows\s/,
  lineDoc: /^\/\/\/?\s?/,
  skip: /^(?:private|fileprivate)\s|^using\s/,
};

const SWIFT: Language = {
  rules: [{ re: /^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|open|internal|static|final|override|mutating|nonmutating|convenience|required|indirect|lazy|weak|class|async|nonisolated)\s+)*(?:class|struct|enum|protocol|extension|actor|func|init|var|let|typealias|case|subscript)\b/ }],
  end: /\s\{\s|\s\{$|\{$|\s=\s/,
  lineDoc: /^\/\/\/?\s?/,
  skip: /^(?:private|fileprivate)\s/,
};

const SCRIPT: Language = {
  rules: [
    { re: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|interface|enum|function\*?|namespace|module)\b/ },
    { re: /^(?:export\s+)?(?:declare\s+)?(?:type|const|let|var)\s/, topOnly: true },
    { re: /^(?:export\s+)(?:default|\{)/, topOnly: true },
    { re: new RegExp(`^(?:(?:public|protected|static|async|readonly|get|set|override|abstract|declare)\\s+)*${CONTROL}[A-Za-z_$][\\w$]*\\s*(?:<[^>]*>)?\\s*\\(.*\\)[^;]*\\{$`) },
  ],
  end: C_STYLE_END,
  lineDoc: /^\/\/\s?/,
  skip: /^(?:private\s|#\w)|^(?:import|require)\b/,
};

const PYTHON: Language = {
  // Single-underscore names are private by convention; dunders such as __call__ are kept.
  rules: [{ re: /^(?:async\s+)?def\s+(?!_[^_])\w|^class\s+(?!_[^_])\w/ }],
  end: /:\s*(?:#.*)?$/,
  lineDoc: /^#\s?/,
  skip: /^(?:from|import)\s/,
  docstrings: true,
};

const GO: Language = {
  rules: [{ re: /^(?:func|type|var|const)\b/, topOnly: true }, { re: /^[A-Z]\w*\s+(?:struct|interface|func)\b|^[A-Z]\w*\(.*\)/ }],
  end: /\s\{$|\{$|\s=\s/,
  lineDoc: /^\/\/\s?/,
};

const RUST: Language = {
  rules: [{ re: /^(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:(?:async|const|unsafe|default|extern\s+"[^"]*")\s+)*(?:fn|struct|enum|trait|impl|mod|type|const|static|union|macro_rules!)(?:\s|<|$)/ }],
  end: /\s\{$|\{$|\s=\s|;$|\swhere$/,
  lineDoc: /^\/\/[\/!]\s?/,
  skip: /^use\s/,
};

const RUBY: Language = {
  rules: [{ re: /^(?:def|class|module)\s|^attr_(?:reader|writer|accessor)\s/ }],
  end: /\s*$/,
  lineDoc: /^#\s?/,
  skip: /^(?:require|require_relative)\s/,
};

const PHP: Language = {
  rules: [{ re: /^(?:(?:abstract|final|public|protected|static|readonly)\s+)*(?:class|interface|trait|enum|function|namespace)\b/ }],
  end: C_STYLE_END,
  lineDoc: /^\/\/\s?/,
  skip: /^(?:private\s|use\s)/,
};

const C: Language = {
  rules: [
    { re: /^(?:typedef\s+)?(?:struct|class|enum|union|namespace)\b|^#define\s+\w|^template\s*</ },
    { re: new RegExp(`^${CONTROL}(?:[A-Za-z_][\\w:<>,*&]*\\s+)+[*&]*[A-Za-z_][\\w:~]*\\s*\\([^;]*$`), topOnly: true },
  ],
  end: /\s\{$|\{$/,
  lineDoc: /^\/\/\/?\s?/,
  skip: /^#(?:include|import|pragma)\b/,
};

const SHELL: Language = {
  rules: [{ re: /^(?:function\s+[\w-]+|[\w-]+\s*\(\))/ }],
  end: /\s*\{$|\s*\(\)\s*\{?$/,
  lineDoc: /^#\s?/,
};

const OTHER: Language = {
  rules: [{ re: /^(?:[\w@]+(?:\([^)]*\))?\s+)*?(class|interface|object|fun|func|typealias|val|var|def|defmodule|function|struct|enum|trait|impl|module)\b/ }],
  end: /\s[{=]\s|\s\{$|\{$|:$/,
  lineDoc: /^(?:\/\/|#|--)\s?/,
};

const BY_EXTENSION: Record<string, Language> = {
  kt: KOTLIN, kts: KOTLIN,
  java: JVM, scala: JVM, groovy: JVM, gradle: JVM, cs: JVM, fs: JVM, dart: JVM,
  swift: SWIFT,
  ts: SCRIPT, tsx: SCRIPT, js: SCRIPT, jsx: SCRIPT, mjs: SCRIPT, cjs: SCRIPT, vue: SCRIPT, svelte: SCRIPT,
  py: PYTHON,
  go: GO,
  rs: RUST,
  rb: RUBY,
  php: PHP,
  c: C, h: C, cc: C, cpp: C, cxx: C, hpp: C, hh: C, m: C, mm: C, zig: C,
  sh: SHELL, bash: SHELL, zsh: SHELL,
};

/**
 * A ~300-token summary of a file: its path, package, and top-level and member declarations, each with the
 * first line of its doc comment. The rules are per language, chosen by extension.
 */
export function sketch(filePath: string, text: string): string {
  const lang = BY_EXTENSION[path.extname(filePath).slice(1).toLowerCase()] ?? OTHER;
  const lines = text.split(/\r\n|\r|\n/);
  const out = [`path: ${filePath}`];
  if (lang.docstrings) {
    const first = lines.find((l) => l.trim() !== "")?.trim();
    const doc = first && docstring(first);
    if (doc) out.push(`doc: ${doc}`);
  }
  let blockDoc: string | null = null;
  let lineDoc: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\t/g, "    ").trimEnd();
    const s = line.trim();
    if (s === "") {
      lineDoc = null;
      continue;
    }
    if (s.startsWith("/**")) blockDoc = asDoc(s.slice(3).replace(/\*\/$/, ""));
    const indent = line.length - line.trimStart().length;
    if (lang.lineDoc?.test(s) && !s.startsWith("/**")) {
      if (lineDoc === null) lineDoc = asDoc(s.replace(lang.lineDoc, ""));
      continue;
    }
    if (indent > MAX_INDENT || s.startsWith("*") || s.startsWith("/*") || s.startsWith("//") || lang.skip?.test(s)) {
      if (s.startsWith("* ") && blockDoc === null) blockDoc = asDoc(s.slice(2));
      continue;
    }
    const matched = lang.rules.some((r) => (!r.topOnly || indent === 0) && r.re.test(s));
    if (!matched && /^(?:package|namespace)\s/.test(s)) out.push(s.replace(/[;{]\s*$/, "").trim());
    if (matched) {
      const sig = s.split(lang.end)[0]!.trim();
      const doc = blockDoc ?? lineDoc ?? (lang.docstrings ? followingDocstring(lines, i) : null);
      out.push("  ".repeat(Math.floor(indent / 4)) + "- " + sig + (doc ? `  // ${doc}` : ""));
      blockDoc = null;
    }
    lineDoc = null;
  }
  return out.join("\n").slice(0, MAX_SKETCH_CHARS);
}

function followingDocstring(lines: string[], at: number): string | null {
  for (let j = at + 1; j < lines.length && j <= at + 3; j++) {
    const s = lines[j]!.trim();
    if (s !== "") return docstring(s);
  }
  return null;
}

function docstring(s: string): string | null {
  const m = /^[rRbBuU]?("""|''')(.*?)(?:\1)?$/.exec(s);
  return m ? asDoc(m[2]!) : null;
}

function asDoc(raw: string): string | null {
  const s = raw.trim();
  if (!/\p{L}/u.test(s) || DIRECTIVE.test(s)) return null;
  return s.length > MAX_DOC_CHARS ? s.slice(0, MAX_DOC_CHARS - 1).trimEnd() + "…" : s;
}
