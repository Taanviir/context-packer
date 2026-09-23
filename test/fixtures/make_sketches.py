"""Writes sketches.json: the expected output of both sketchers for every file in sketch-sources/.

This is an independent Python implementation of the sketch rules, so the TypeScript sketcher is
checked against a second implementation rather than against its own earlier output.
Run: python3 test/fixtures/make_sketches.py
"""

import json
import re
from pathlib import Path

HERE = Path(__file__).parent
CAP = 1200
JEV_DECL = re.compile(r"^(?:[\w@]+(?:\([^)]*\))?\s+)*?(class|interface|object|fun|typealias|val|var)\b")
JEV_END = re.compile(r"\s[{=]\s|\s\{$|\{$")
LAYA_DECL = re.compile(r"^(?:[\w@]+(?:\([^)]*\))?\s+)*?(class|interface|object|fun|typealias|val|var|def|function|struct|enum|trait|impl)\b")
LAYA_END = re.compile(r"\s[{=]\s|\s\{$|\{$|:$")


def sketch(path: str, text: str, decl: re.Pattern, end: re.Pattern) -> str:
    out, doc = [f"path: {path}"], None
    for raw in re.split(r"\r\n|\r|\n", text):
        line = raw.rstrip()
        s = line.strip()
        if s.startswith("package "):
            out.append(s)
        if s.startswith("/**"):
            doc = s.removeprefix("/**").removesuffix("*/").strip() or None
        indent = len(line) - len(line.lstrip())
        if indent > 8 or s.startswith(("private ", "//", "*", "import ")):
            if s.startswith("* ") and doc is None:
                doc = s[2:].strip()
            continue
        if decl.search(s):
            sig = end.split(s, maxsplit=1)[0]
            out.append("  " * (indent // 4) + "- " + sig + (f"  // {doc}" if doc else ""))
            doc = None
    return "\n".join(out)[:CAP]


cases = []
for file in sorted((HERE / "sketch-sources").iterdir()):
    text = file.read_bytes().decode("utf-8")
    path = f"src/{file.name}"
    cases.append({
        "file": file.name,
        "path": path,
        "jev": sketch(path, text, JEV_DECL, JEV_END),
        "laya": sketch(path, text, LAYA_DECL, LAYA_END),
    })
(HERE / "sketches.json").write_text(json.dumps({"cases": cases}, indent=1) + "\n")
print(f"wrote {len(cases)} cases")
