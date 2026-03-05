import fs from "fs/promises";
import path from "path";

// ── Config ────────────────────────────────────────────────────────────────────
const CONTENT_DIR = "./content/blog";

// ── The one true standard format ─────────────────────────────────────────────
const STANDARD_STYLE = `<style>
  .blog-header-ascii {
    color: white;
    background: transparent;
    font-family: monospace;
    white-space: pre;
    line-height: 1.2;
    font-size: clamp(6px, 1.1vw, 13px);
    display: block;
  }
  @media (prefers-color-scheme: light) {
    .blog-header-ascii { color: black; }
  }
  @media print {
    .blog-header-ascii { color: black !important; }
  }
</style>

<pre class="blog-header-ascii">
</pre>`;

// ── Strip everything non-content from markdown ────────────────────────────────
function extractCleanContent(markdown) {
  let text = markdown;

  // Remove ```markdown ... ``` fences wrapping frontmatter
  text = text.replace(/^```markdown\s*/m, "");
  text = text.replace(/^```\s*$/m, "");

  // Remove any code fences wrapping CSS or style blocks
  text = text.replace(/```[\s\S]*?```/g, "");

  // Remove <style> blocks
  text = text.replace(/<style>[\s\S]*?<\/style>/g, "");

  // Remove <pre> blocks of any kind
  text = text.replace(/<pre[^>]*>[\s\S]*?<\/pre>/g, "");

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // Remove bare CSS blocks (lines starting with . or @ that look like CSS)
  text = text.replace(/^[.@][^{\n]+\{[^}]*\}/gm, "");

  // Collapse multiple blank lines into one
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

// ── Extract frontmatter from content ─────────────────────────────────────────
function extractFrontmatter(content) {
  const match = content.match(/^(---[\s\S]*?---)/);
  return match ? match[1] : null;
}

// ── Rebuild file in standard format ──────────────────────────────────────────
function rebuild(markdown) {
  const clean = extractCleanContent(markdown);
  const frontmatter = extractFrontmatter(clean);

  if (!frontmatter) {
    // No frontmatter found -- just prepend standard block
    return `${STANDARD_STYLE}\n\n${clean}`;
  }

  const body = clean.slice(frontmatter.length).trim();
  return `${frontmatter}\n\n${STANDARD_STYLE}\n\n${body}`;
}

// ── Check if file is already in correct format ────────────────────────────────
function isCorrect(markdown) {
  return (
    markdown.includes('<pre class="blog-header-ascii">') &&
    !markdown.includes("```markdown") &&
    !markdown.includes('<pre class="ascii-header"') &&
    !/color: white;[\s\S]{0,200}color: black/.test(markdown.replace(/<style>[\s\S]*?<\/style>/g, ""))
  );
}

// ── Get list of blog files ────────────────────────────────────────────────────
async function getBlogFiles() {
  const entries = await fs.readdir(CONTENT_DIR);
  return entries
    .filter(f => f.endsWith(".md"))
    .map(f => path.join(CONTENT_DIR, f));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const files = await getBlogFiles();
  let normalized = 0;
  let skipped = 0;

  for (const filePath of files) {
    const filename = path.basename(filePath);
    const markdown = await fs.readFile(filePath, "utf8");

    if (isCorrect(markdown)) {
      skipped++;
      continue;
    }

    const updated = rebuild(markdown);
    await fs.writeFile(filePath, updated, "utf8");
    console.log(`Normalized: ${filename}`);
    normalized++;
  }

  console.log(`\nDone. Normalized: ${normalized} | Already correct: ${skipped}`);
}

main();