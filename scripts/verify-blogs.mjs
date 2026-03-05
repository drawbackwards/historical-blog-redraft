import fs from "fs/promises";
import path from "path";

// ── Config ────────────────────────────────────────────────────────────────────
const CONTENT_DIR  = "../content/blog";
const REPORT_FILE  = "../blog-verification-report.md";

// Required frontmatter fields
const REQUIRED_FIELDS = ["title", "date", "metaDescription", "slug"];

// metaDescription target range (characters)
const META_MIN = 150;
const META_MAX = 160;

// A post is flagged as thin if its word count is below this fraction of the median
const THIN_CONTENT_THRESHOLD = 0.5;

// ── The exact standard style block (from add-missing-ascii-blocks.mjs) ────────
const REQUIRED_STYLE_RULES = [
  ".blog-header-ascii",
  "color: white",
  "background: transparent",
  "font-family: monospace",
  "white-space: pre",
  "line-height: 1.2",
  "prefers-color-scheme: light",
  "color: black",
  "@media print",
  "color: black !important",
];

// ── Repeating pattern characters (from update-ascii-patterns.mjs styles A/B/C) ─
// A real pattern will be built from a small set of repeated characters tiling
// across every line. Rich illustration art uses a much wider character variety.
const MIN_PATTERN_LINE_REPETITION = 0.6; // 60% of a line must be repeated chars

// ── Read all markdown files ───────────────────────────────────────────────────
async function getBlogFiles() {
  const entries = await fs.readdir(CONTENT_DIR);
  return entries
    .filter(f => f.endsWith(".md"))
    .map(f => path.join(CONTENT_DIR, f));
}

// ── Parse frontmatter into key/value map ─────────────────────────────────────
function parseFrontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
    fields[key] = val;
  }
  return fields;
}

// ── Extract body content (strips frontmatter and ASCII block) ─────────────────
function extractBody(markdown) {
  let body = markdown.replace(/^---[\s\S]*?---\n/, "");
  body = body.replace(/<style>[\s\S]*?<\/style>\s*<pre[^>]*>[\s\S]*?<\/pre>/, "");
  body = body.replace(/<[^>]+>/g, "");
  return body.trim();
}

// ── Count words in a string ───────────────────────────────────────────────────
function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

// ── Calculate median of an array of numbers ──────────────────────────────────
function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ── Validate the <style> block matches the standard format ────────────────────
function checkStyleBlock(markdown) {
  const styleMatch = markdown.match(/<style>([\s\S]*?)<\/style>/);
  if (!styleMatch) return { hasStyle: false, missingRules: REQUIRED_STYLE_RULES };

  const styleContent = styleMatch[1];
  const missingRules = REQUIRED_STYLE_RULES.filter(rule => !styleContent.includes(rule));
  return { hasStyle: true, missingRules };
}

// ── Check ASCII <pre> block presence and whether it looks like a pattern ──────
function checkAsciiBlock(markdown) {
  const preMatch = markdown.match(/<pre[^>]*class="blog-header-ascii"[^>]*>([\s\S]*?)<\/pre>/);
  if (!preMatch) return { hasPreTag: false, hasContent: false, looksLikePattern: false };

  const preContent = preMatch[1].trim();
  if (!preContent || preContent.length < 20) {
    return { hasPreTag: true, hasContent: false, looksLikePattern: false };
  }

  // Detect whether this looks like a repeating pattern (styles A/B/C from
  // update-ascii-patterns.mjs) vs. a rich illustration (update-ascii-art.mjs).
  // Repeating patterns have lines dominated by a very small set of unique chars.
  const lines = preContent.split("\n").filter(l => l.trim().length > 0);
  const patternLineCount = lines.filter(line => {
    if (line.length < 10) return true;
    const uniqueChars = new Set(line.replace(/ /g, "").split("")).size;
    // Pattern lines use very few unique characters relative to line length
    return uniqueChars <= 6;
  }).length;

  const patternRatio = patternLineCount / lines.length;
  const looksLikePattern = patternRatio >= MIN_PATTERN_LINE_REPETITION;

  return {
    hasPreTag: true,
    hasContent: true,
    looksLikePattern,
    patternRatio: Math.round(patternRatio * 100),
    lineCount: lines.length,
  };
}

// ── Check frontmatter fields ──────────────────────────────────────────────────
function checkFrontmatter(markdown) {
  const fields = parseFrontmatter(markdown);
  if (!fields) return { hasFrontmatter: false, missingFields: REQUIRED_FIELDS, fields: {} };

  const missingFields = REQUIRED_FIELDS.filter(f => !fields[f] || fields[f].trim() === "");
  const metaLen  = (fields.metaDescription || "").length;
  const metaShort = fields.metaDescription && metaLen < META_MIN;
  const metaLong  = fields.metaDescription && metaLen > META_MAX;
  const badSlug   = fields.slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.slug);

  return { hasFrontmatter: true, missingFields, fields, metaLen, metaShort, metaLong, badSlug };
}

// ── Check body content structure ──────────────────────────────────────────────
function checkStructure(body) {
  const hasH2  = /^##\s+/m.test(body);
  const hasFaq = /faq|frequently asked/i.test(body);
  const words  = wordCount(body);
  return { hasH2, hasFaq, words };
}

// ── Check for em dashes ───────────────────────────────────────────────────────
function checkEmDashes(markdown) {
  const count = (markdown.match(/\u2014/g) || []).length;
  return { hasEmDashes: count > 0, count };
}

// ── Format issues for report ──────────────────────────────────────────────────
function formatIssues(issues) {
  return issues.map(i => `  - ${i}`).join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nVerifying blog posts in: ${CONTENT_DIR}\n`);

  const files = await getBlogFiles();
  if (files.length === 0) {
    console.log("No .md files found.");
    return;
  }

  // First pass: collect posts and word counts for median calculation
  const posts = [];
  for (const filePath of files) {
    const markdown = await fs.readFile(filePath, "utf8");
    const body     = extractBody(markdown);
    const words    = wordCount(body);
    posts.push({ filePath, filename: path.basename(filePath), markdown, body, words });
  }

  const medianWords   = median(posts.map(p => p.words));
  const thinThreshold = Math.round(medianWords * THIN_CONTENT_THRESHOLD);

  console.log(`Total posts:     ${posts.length}`);
  console.log(`Median words:    ${medianWords}`);
  console.log(`Thin threshold:  < ${thinThreshold} words (${Math.round(THIN_CONTENT_THRESHOLD * 100)}% of median)\n`);

  // Second pass: verify each post
  const results   = [];
  let totalIssues = 0;
  let cleanCount  = 0;

  for (const post of posts) {
    const { filename, markdown, body, words } = post;
    const issues  = [];
    const notices = []; // non-blocking observations

    // -- Frontmatter --
    const fm = checkFrontmatter(markdown);
    if (!fm.hasFrontmatter) {
      issues.push("MISSING: No frontmatter block found");
    } else {
      if (fm.missingFields.length > 0)
        issues.push(`MISSING frontmatter fields: ${fm.missingFields.join(", ")}`);
      if (fm.metaShort)
        issues.push(`SHORT metaDescription: ${fm.metaLen} chars (target ${META_MIN}-${META_MAX})`);
      if (fm.metaLong)
        issues.push(`LONG metaDescription: ${fm.metaLen} chars (target ${META_MIN}-${META_MAX})`);
      if (fm.badSlug)
        issues.push(`INVALID slug format: "${fm.fields.slug}" (must be lowercase-hyphenated)`);
    }

    // -- Style block --
    const style = checkStyleBlock(markdown);
    if (!style.hasStyle) {
      issues.push("MISSING: <style> block not found");
    } else if (style.missingRules.length > 0) {
      issues.push(`INCOMPLETE <style> block -- missing rules: ${style.missingRules.join(", ")}`);
    }

    // -- ASCII block --
    const ascii = checkAsciiBlock(markdown);
    if (!ascii.hasPreTag) {
      issues.push(`MISSING: <pre class="blog-header-ascii"> tag not found`);
    } else if (!ascii.hasContent) {
      issues.push("EMPTY: ASCII art block is empty or near-empty");
    } else if (!ascii.looksLikePattern) {
      issues.push(
        `WRONG ASCII STYLE: Block looks like a rich illustration (${ascii.patternRatio}% pattern lines). ` +
        `Should be a repeating pattern -- re-run update-ascii-patterns.mjs on this file.`
      );
    }

    // -- Content --
    const structure = checkStructure(body);
    if (words < thinThreshold)
      issues.push(`THIN CONTENT: ${words} words (median ${medianWords}, threshold ${thinThreshold})`);
    if (!structure.hasH2)
      issues.push("MISSING: No H2 headings found in post body");
    if (!structure.hasFaq)
      issues.push("MISSING: No FAQ section detected");

    // -- Em dashes --
    const em = checkEmDashes(markdown);
    if (em.hasEmDashes)
      issues.push(`EM DASHES: Found ${em.count} in content -- must be removed`);

    results.push({ filename, words, issues, notices });
    totalIssues += issues.length;
    if (issues.length === 0) cleanCount++;
  }

  // ── Build report ──────────────────────────────────────────────────────────────
  const now         = new Date().toISOString().slice(0, 19).replace("T", " ");
  const failedPosts = results.filter(r => r.issues.length > 0);
  const cleanPosts  = results.filter(r => r.issues.length === 0);

  // Group failures by issue type for the summary
  const issueCounts = {};
  for (const r of failedPosts) {
    for (const issue of r.issues) {
      const key = issue.split(":")[0].trim();
      issueCounts[key] = (issueCounts[key] || 0) + 1;
    }
  }

  const lines = [
    `# Blog Verification Report`,
    `Generated: ${now}`,
    `Directory: ${CONTENT_DIR}`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total posts | ${posts.length} |`,
    `| Clean (no issues) | ${cleanCount} |`,
    `| Posts with issues | ${failedPosts.length} |`,
    `| Total issues found | ${totalIssues} |`,
    `| Median word count | ${medianWords} |`,
    `| Thin content threshold | < ${thinThreshold} words |`,
    ``,
  ];

  if (Object.keys(issueCounts).length > 0) {
    lines.push(`## Issue Breakdown`);
    lines.push(``);
    lines.push(`| Issue Type | Occurrences |`);
    lines.push(`|------------|-------------|`);
    for (const [type, count] of Object.entries(issueCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${type} | ${count} |`);
    }
    lines.push(``);
  }

  if (failedPosts.length > 0) {
    lines.push(`## Posts With Issues (${failedPosts.length})`);
    lines.push(``);
    for (const r of failedPosts) {
      lines.push(`### ${r.filename}`);
      lines.push(`Words: ${r.words} | Issues: ${r.issues.length}`);
      lines.push(``);
      lines.push(formatIssues(r.issues));
      lines.push(``);
    }
  }

  if (cleanPosts.length > 0) {
    lines.push(`## Clean Posts (${cleanPosts.length})`);
    lines.push(``);
    for (const r of cleanPosts) {
      lines.push(`- ${r.filename} (${r.words} words)`);
    }
    lines.push(``);
  }

  const report = lines.join("\n");
  await fs.writeFile(REPORT_FILE, report, "utf8");

  // ── Console summary ───────────────────────────────────────────────────────────
  console.log(`Results:`);
  console.log(`  Clean posts:       ${cleanCount} / ${posts.length}`);
  console.log(`  Posts with issues: ${failedPosts.length}`);
  console.log(`  Total issues:      ${totalIssues}`);
  console.log(`\nReport written to: ${REPORT_FILE}\n`);

  if (failedPosts.length > 0) {
    console.log("Issues by file:");
    for (const r of failedPosts) {
      console.log(`\n  ${r.filename} (${r.words} words)`);
      for (const issue of r.issues) {
        console.log(`    - ${issue}`);
      }
    }
  }
}

main();