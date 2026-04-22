#!/usr/bin/env node

/**
 * build-docx.mjs
 *
 * Combines all markdown files from content/ into a single DOCX document
 * using pandoc. The document follows the directory structure order:
 *
 *   content/index.md                    (title page)
 *   content/1._introduction/*           (section 1)
 *   content/2._requirements/*           (section 2)
 *   content/3._baseline_architecture/*  (section 3)
 *   content/4._data_governance/*        (section 4)
 *   content/5._architecture_decisions/* (section 5)
 *
 * Features:
 *   - Resolves relative image paths so pandoc can embed them
 *   - Strips <!-- toc --> / <!-- tocstop --> auto-generated TOC blocks
 *   - Strips HTML template comments (<!-- ... -->)
 *   - Inserts page breaks between top-level sections
 *   - Renders mermaid diagrams to PNG images via mmdc
 *   - Generates a DOCX table of contents
 */

import { readdir, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, dirname, relative, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const ROOT = resolve(import.meta.dirname, "..");
const CONTENT_DIR = join(ROOT, "content");
const OUTPUT_FILE = join(ROOT, "solution_arcitecture_assessment.docx");

// ---------------------------------------------------------------------------
// 1. Define the document structure
//    Each entry: { section (display name), files (ordered list of md paths) }
// ---------------------------------------------------------------------------

/**
 * List markdown files in a directory, sorted alphabetically.
 * README.md is placed first if present (acts as section intro).
 */
async function listMdFiles(dir) {
  const entries = await readdir(dir);
  const mdFiles = entries
    .filter((f) => f.endsWith(".md"))
    .sort((a, b) => {
      // README.md always comes first in a section
      if (a === "README.md") return -1;
      if (b === "README.md") return 1;
      return a.localeCompare(b, undefined, { numeric: true });
    });
  return mdFiles.map((f) => join(dir, f));
}

async function buildDocumentPlan() {
  const sections = [];

  // Title page: content/index.md
  sections.push({
    section: null, // no page-break before first section
    files: [join(CONTENT_DIR, "index.md")],
  });

  // Numbered sections in order
  const dirs = (await readdir(CONTENT_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  for (const dir of dirs) {
    const sectionName = dir.name
      .replace(/^\d+\._?/, "") // strip leading number prefix
      .replace(/_/g, " ") // underscores to spaces
      .replace(/\b\w/g, (c) => c.toUpperCase()); // title case

    sections.push({
      section: sectionName,
      files: await listMdFiles(join(CONTENT_DIR, dir.name)),
    });
  }

  return sections;
}

// ---------------------------------------------------------------------------
// 2. Process markdown content
// ---------------------------------------------------------------------------

/**
 * Strip HTML comments including <!-- toc -->...<!-- tocstop --> blocks
 * and general <!-- ... --> template hints.
 */
function stripHtmlComments(md) {
  // First remove toc blocks (may span multiple lines)
  let result = md.replace(/<!--\s*toc\s*-->[\s\S]*?<!--\s*tocstop\s*-->/gi, "");
  // Then remove remaining HTML comments
  result = result.replace(/<!--[\s\S]*?-->/g, "");
  return result;
}

/**
 * Convert heading text to a pandoc-style anchor ID.
 * Replicates pandoc's identifier generation algorithm:
 *   - Strip inline markdown formatting (bold, italic, code, links)
 *   - Lowercase
 *   - Strip leading numbers followed by dot+space (e.g. "5. Foo" → "foo")
 *   - Replace non-alphanumeric characters (except underscores, hyphens, dots)
 *     with hyphens
 *   - Collapse consecutive hyphens
 *   - Strip leading/trailing hyphens
 */
function pandocSlugify(text) {
  let s = text;
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
  s = s.replace(/\*([^*]+)\*/g, "$1");
  s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.toLowerCase();
  s = s.replace(/^\d+\.\s+/, "");
  s = s.replace(/[^a-z0-9_.\s-]/g, "");
  s = s.replace(/\s+/g, "-");
  s = s.replace(/-{2,}/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  return s;
}

/**
 * Build a map of absolute file paths to the pandoc anchor ID of their
 * first heading. Used to rewrite inter-file links into internal anchors.
 *
 * @param {Array<{section: string|null, files: string[]}>} plan
 * @returns {Promise<Map<string, string>>}  filePath → anchorId
 */
async function buildHeadingMap(plan) {
  const map = new Map();
  for (const { files } of plan) {
    for (const filePath of files) {
      const content = await readFile(filePath, "utf-8");
      const match = content.match(/^#{1,6}\s+(.+)$/m);
      if (match) {
        map.set(filePath, pandocSlugify(match[1].trim()));
      }
    }
  }
  return map;
}

/**
 * Rewrite relative markdown file links to internal anchor references.
 * Handles three patterns:
 *   [text](../path/file.md)        → [text](#first-heading-of-file)
 *   [text](../path/file.md#anchor) → [text](#anchor)
 *   [text](file.md)                → [text](#first-heading-of-file)
 *
 * External (http/https) and pure anchor (#heading) links are untouched.
 */
function rewriteLinks(md, mdFilePath, headingMap) {
  const mdDir = dirname(mdFilePath);
  return md.replace(
    /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g,
    (match, text, href) => {
      if (href.startsWith("http://") || href.startsWith("https://")) return match;
      if (href.startsWith("#")) return match;

      const [filePart, fragment] = href.split("#", 2);

      if (!filePart.endsWith(".md")) return match;

      const absTarget = resolve(mdDir, filePart);

      if (fragment) {
        return `[${text}](#${fragment})`;
      }

      const anchor = headingMap.get(absTarget);
      if (anchor) {
        return `[${text}](#${anchor})`;
      }

      console.warn(`  Warning: unresolvable link target: ${href} (from ${relative(ROOT, mdFilePath)})`);
      return match;
    }
  );
}

/**
 * Resolve image paths relative to the markdown file's location
 * so that pandoc (run from a temp dir) can find them.
 * Converts relative paths like ../../diagrams/foo.png to absolute paths.
 */
function resolveImagePaths(md, mdFilePath) {
  const mdDir = dirname(mdFilePath);
  return md.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (match, alt, src) => {
      // Skip URLs
      if (src.startsWith("http://") || src.startsWith("https://")) {
        return match;
      }
      const absPath = resolve(mdDir, src);
      if (existsSync(absPath)) {
        return `![${alt}](${absPath})`;
      }
      console.warn(`  Warning: image not found: ${src} (resolved to ${absPath})`);
      return match;
    }
  );
}

/**
 * Render mermaid code blocks to PNG images using mmdc (mermaid CLI).
 * Replaces each ```mermaid ... ``` block with a markdown image reference.
 * On failure, logs a warning and keeps the original code block.
 *
 * @param {string} md       - Markdown content
 * @param {string} tmpDir   - Temp directory for generated images
 * @param {string} fileId   - Unique identifier for this file (avoids collisions)
 * @returns {Promise<string>} - Markdown with mermaid blocks replaced by image refs
 */
async function renderMermaidBlocks(md, tmpDir, fileId) {
  const mermaidRegex = /```mermaid\n([\s\S]*?)```/g;
  const matches = [...md.matchAll(mermaidRegex)];

  if (matches.length === 0) return md;

  console.log(`    Rendering ${matches.length} mermaid diagram(s) ...`);

  let result = md;
  // Process in reverse order so replacement indices stay valid
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const mermaidSource = match[1];
    const inputFile = join(tmpDir, `mermaid-${fileId}-${i}.mmd`);
    const outputFile = join(tmpDir, `mermaid-${fileId}-${i}.png`);

    await writeFile(inputFile, mermaidSource, "utf-8");

    try {
      execFileSync("mmdc", [
        "-i", inputFile,
        "-o", outputFile,
        "-b", "white",
        "-w", "1200",
      ], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 30_000,
      });

      const alt = `Mermaid Diagram ${i + 1}`;
      result =
        result.slice(0, match.index) +
        `![${alt}](${outputFile})` +
        result.slice(match.index + match[0].length);
    } catch (err) {
      const stderr = err.stderr?.toString() || err.message;
      console.warn(`    Warning: mmdc failed for diagram ${i + 1}: ${stderr}`);
      // Leave the original code block in place
    }
  }

  return result;
}

/**
 * Shift all markdown headings down by one level (# -> ##, ## -> ###, etc.)
 * so that folder-level H1 headings remain the only top-level headings.
 */
function shiftHeadings(md) {
  return md.replace(/^(#{1,5})\s/gm, (match, hashes) => `#${hashes} `);
}

/**
 * Read and preprocess a markdown file.
 *
 * @param {string} filePath   - Absolute path to the markdown file
 * @param {string} tmpDir     - Temp directory for generated images
 * @param {boolean} isSection - Whether this file belongs to a subfolder section
 * @param {Map<string, string>} headingMap - File path to anchor ID map
 */
async function processFile(filePath, tmpDir, isSection = false, headingMap = new Map()) {
  const fileId = basename(filePath, ".md").replace(/[^a-zA-Z0-9_-]/g, "_");
  let content = await readFile(filePath, "utf-8");
  content = stripHtmlComments(content);
  content = await renderMermaidBlocks(content, tmpDir, fileId);
  content = resolveImagePaths(content, filePath);
  content = rewriteLinks(content, filePath, headingMap);
  if (isSection) {
    content = shiftHeadings(content);
  }
  content = content.trim();
  return content;
}

// ---------------------------------------------------------------------------
// 3. Assemble and convert
// ---------------------------------------------------------------------------

const PAGE_BREAK = "\n\n\\newpage\n\n";

async function main() {
  console.log("Building DOCX from content/ ...\n");

  const plan = await buildDocumentPlan();
  const headingMap = await buildHeadingMap(plan);
  const parts = [];

  // Create temp directory under the project root (not /tmp) because mmdc
  // installed via snap cannot access /tmp due to confinement restrictions.
  const tmpDir = await mkdtemp(join(ROOT, ".docx-build-"));

  for (const { section, files } of plan) {
    const isSection = section !== null;

    if (isSection) {
      parts.push(PAGE_BREAK);
      parts.push(`# ${section}`);
    }

    for (const file of files) {
      const relPath = relative(ROOT, file);
      console.log(`  Processing: ${relPath}`);
      const content = await processFile(file, tmpDir, isSection, headingMap);
      if (content.length > 0) {
        parts.push(content);
      }
    }
  }

  // Combine into a single markdown document
  const combined = parts.join("\n\n");

  const tmpMd = join(tmpDir, "combined.md");
  await writeFile(tmpMd, combined, "utf-8");

  console.log(`\n  Combined markdown: ${(combined.length / 1024).toFixed(1)} KB`);
  console.log(`  Running pandoc ...`);

  try {
    execFileSync("pandoc", [
      tmpMd,
      "-o", OUTPUT_FILE,
      "--from", "markdown",
      "--to", "docx",
      // Generate table of contents
      "--toc",
      "--toc-depth=3",
      // Standalone document (with metadata)
      "--standalone",
      // Resource path for images (project root + content dirs)
      "--resource-path", [ROOT, CONTENT_DIR].join(":"),
      // Metadata
      "--metadata", "title=Solution Solution Architecture Assessment",
      "--metadata", "subtitle=Architecture Documentation",
      // Shift headings: H1 in individual files become H2 in the combined doc
      // (except the title which stays H1). We handle this by keeping H1 as-is;
      // pandoc TOC will organize by heading levels as found.
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: ROOT,
    });

    console.log(`\n  Output: ${relative(ROOT, OUTPUT_FILE)}`);
    console.log("  Done!\n");
  } catch (err) {
    console.error("  Pandoc failed:", err.stderr?.toString() || err.message);
    process.exit(1);
  } finally {
    // Clean up temp directory
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
