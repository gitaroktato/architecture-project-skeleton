#!/usr/bin/env bash
# fix_markdown.sh
# For every .md file under content/ (except index.md):
#   1. Extract the page title and normalise it to a # Level 1 heading
#   2. Insert <!-- toc --> / <!-- tocstop --> markers after the title
#   3. Wrap all remaining body content in an HTML comment block

set -euo pipefail

python3 - <<'PYEOF'
import re
from pathlib import Path

CONTENT_ROOT = Path("content")
SKIP = {CONTENT_ROOT / "index.md"}

RE_SETEXT_H1 = re.compile(r'^=+\s*$')
RE_SETEXT_H2 = re.compile(r'^-+\s*$')
RE_ATX       = re.compile(r'^#{1,6}\s+(.*?)\s*$')
RE_HR        = re.compile(r'^---+\s*$')


def extract_title_and_body(lines):
    # Drop leading blank lines
    start = 0
    while start < len(lines) and lines[start].strip() == "":
        start += 1

    if start >= len(lines):
        return None, []

    first = lines[start]

    # ATX heading: #, ##, ### …
    m = RE_ATX.match(first)
    if m:
        title = m.group(1)
        rest = lines[start + 1:]
        # Drop optional blank lines + a stray '---' separator (Stakeholders.md)
        i = 0
        while i < len(rest) and rest[i].strip() == "":
            i += 1
        if i < len(rest) and RE_HR.match(rest[i]):
            i += 1
        return title, rest[i:]

    # Setext heading: underline with === or ---
    if start + 1 < len(lines):
        second = lines[start + 1]
        if RE_SETEXT_H1.match(second) or RE_SETEXT_H2.match(second):
            return first.strip(), lines[start + 2:]

    # Fallback: first non-blank line treated as plain title
    return first.strip(), lines[start + 1:]


def build_output(title, body_lines):
    body = "\n".join(body_lines).strip()

    out = [f"# {title}", ""]
    out += ["<!-- toc -->", "", "<!-- tocstop -->"]

    if body:
        out += ["", "<!--", body, "-->"]

    out.append("")
    return "\n".join(out)


files = sorted(p for p in CONTENT_ROOT.rglob("*.md") if p not in SKIP)

for path in files:
    original = path.read_text(encoding="utf-8")
    lines = original.splitlines()

    # Skip files that are already in the target format
    # (# Title  →  blank  →  <!-- toc -->)
    stripped = [l for l in lines if l.strip()]
    if (len(stripped) >= 2
            and RE_ATX.match(stripped[0])
            and stripped[1] == "<!-- toc -->"):
        print(f"  unchanged:   {path}")
        continue

    title, body_lines = extract_title_and_body(lines)

    if title is None:
        print(f"  SKIP (empty): {path}")
        continue

    new_content = build_output(title, body_lines)

    if new_content == original:
        print(f"  unchanged:   {path}")
    else:
        path.write_text(new_content, encoding="utf-8")
        print(f"  updated:     {path}")

PYEOF
