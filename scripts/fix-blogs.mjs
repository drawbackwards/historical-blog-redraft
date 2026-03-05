import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";

// ── Config ────────────────────────────────────────────────────────────────────
const CONTENT_DIR    = "../content/blog";
const REPORT_FILE    = "../blog-verification-report.md";
const MODEL          = "claude-sonnet-4-6";
const META_MIN       = 150;
const META_MAX       = 160;
const THIN_THRESHOLD = 200;

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getBlogFiles() {
  const entries = await fs.readdir(CONTENT_DIR);
  return entries.filter(f => f.endsWith(".md")).map(f => path.join(CONTENT_DIR, f));
}

function extractBody(markdown) {
  if (!markdown) return "";
  let body = markdown.replace(/^---[\s\S]*?---\n/, "");
  body = body.replace(/<style>[\s\S]*?<\/style>\s*<pre[^>]*>[\s\S]*?<\/pre>/, "");
  body = body.replace(/<[^>]+>/g, "");
  return body.trim();
}

function parseFrontmatter(markdown) {
  if (!markdown) return null;
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) fields[key] = val;
  }
  return fields;
}

function wordCount(text) {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function fixEmDashes(markdown) {
  return markdown.replace(/\u2014/g, " - ");
}

function replaceFrontmatterField(markdown, field, newValue) {
  const pattern = new RegExp(`^(${field}:\\s*)(.+)$`, "m");
  return markdown.replace(pattern, `$1${newValue}`);
}

// ── Fallback: fix meta length with pure JS (no API) ──────────────────────────
function fixMetaLengthJS(meta, title) {
  // Too long: trim at last word boundary within range
  if (meta.length > META_MAX) {
    let trimmed = meta.slice(0, META_MAX);
    const lastSpace = trimmed.lastIndexOf(" ");
    if (lastSpace > META_MIN) trimmed = trimmed.slice(0, lastSpace);
    // If still too long, hard trim
    if (trimmed.length > META_MAX) trimmed = trimmed.slice(0, META_MAX);
    // If now too short, just return hard-trimmed at META_MAX
    return trimmed.length >= META_MIN ? trimmed : meta.slice(0, META_MAX);
  }

  // Too short: append keyword phrase from title until we hit range
  if (meta.length < META_MIN) {
    const needed = META_MIN - meta.length;
    // Build a short suffix from title words
    const titleWords = (title || "").split(/\s+/).filter(Boolean);
    let suffix = "";
    for (const word of titleWords) {
      const candidate = suffix ? `${suffix} ${word}` : word;
      if ((meta + " " + candidate).length <= META_MAX) {
        suffix = candidate;
      }
      if ((meta + " " + suffix).length >= META_MIN) break;
    }
    const padded = suffix ? `${meta} ${suffix}` : meta;
    // If still short, pad with a generic phrase
    if (padded.length < META_MIN) {
      const filler = " Learn more about this topic.";
      return (padded + filler).slice(0, META_MAX);
    }
    return padded.slice(0, META_MAX);
  }

  return meta;
}

// ── Fix metaDescription via Claude with retry, JS fallback ────────────────────
async function fixMetaDescription(client, currentMeta, title, bodyText) {
  const snippet = (bodyText || "").slice(0, 300);
  const MAX_RETRIES = 4;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const tooShort = currentMeta.length < META_MIN;
    const direction = tooShort
      ? `Too short by ${META_MIN - currentMeta.length} chars. Expand it slightly.`
      : `Too long by ${currentMeta.length - META_MAX} chars. Trim it slightly.`;

    let response;
    try {
      const msg = await client.messages.create({
        model: MODEL,
        max_tokens: 200,
        messages: [{
          role: "user",
          content: `Rewrite this meta description to be between ${META_MIN} and ${META_MAX} characters.

Current (${currentMeta.length} chars): ${currentMeta}
${direction}

Post title: ${title}
Post opening: ${snippet}

Output ONLY the rewritten meta description as a single line of plain text. No quotes, no labels, no explanation, no character counts. Just the text.`
        }],
      });
      response = msg.content[0].text;
    } catch (err) {
      console.log(`    API error on attempt ${attempt}: ${err.message}`);
      continue;
    }

    const lines = response.split("\n").map(l => l.trim()).filter(l => l.length >= 50);
    if (lines.length === 0) {
      console.log(`    Attempt ${attempt}: no usable line in response, retrying...`);
      continue;
    }

    const newMeta = lines[0].replace(/^["']|["']$/g, "");

    if (newMeta.length >= META_MIN && newMeta.length <= META_MAX) {
      return newMeta;
    }
    // Accept within 1 char of range as a near-match
    if (newMeta.length >= META_MIN - 1 && newMeta.length <= META_MAX + 1) {
      console.log(`    Accepting near-match: ${newMeta.length} chars`);
      return newMeta;
    }
    console.log(`    Attempt ${attempt}: ${newMeta.length} chars -- retrying...`);
  }

  // Claude couldn't nail it -- fix with pure JS
  const jsFix = fixMetaLengthJS(currentMeta, title);
  console.log(`    JS fallback: ${currentMeta.length} -> ${jsFix.length} chars`);
  return jsFix;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const anthropic = new Anthropic();
  console.log(`\nFixing blog posts in: ${CONTENT_DIR}\n`);

  const files = await getBlogFiles();
  if (files.length === 0) {
    console.log("No .md files found.");
    return;
  }

  const stats = {
    emDashFixed: 0,
    metaFixed: 0,
    metaGaveUp: 0,
    thinSkipped: 0,
    noMeta: 0,
    errors: 0,
    unchanged: 0,
  };

  const skippedThin = [];

  for (const filePath of files) {
    const filename = path.basename(filePath);

    let markdown;
    try {
      markdown = await fs.readFile(filePath, "utf8");
    } catch (err) {
      console.error(`  Cannot read ${filename}: ${err.message}`);
      stats.errors++;
      continue;
    }

    const body = extractBody(markdown);
    const words = wordCount(body);
    const fm = parseFrontmatter(markdown);

    // Skip thin/empty posts
    if (words < THIN_THRESHOLD) {
      skippedThin.push(filename);
      stats.thinSkipped++;
      continue;
    }

    let changed = false;

    // -- Fix em dashes --
    const emCount = (markdown.match(/\u2014/g) || []).length;
    if (emCount > 0) {
      markdown = fixEmDashes(markdown);
      console.log(`  Fixed ${emCount} em dash(es): ${filename}`);
      stats.emDashFixed++;
      changed = true;
    }

    // -- Fix metaDescription --
    if (!fm || !fm.metaDescription) {
      stats.noMeta++;
    } else {
      const metaLen = fm.metaDescription.length;
      if (metaLen < META_MIN || metaLen > META_MAX) {
        console.log(`  Fixing metaDescription (${metaLen} chars): ${filename}`);
        try {
          const newMeta = await fixMetaDescription(
            anthropic,
            fm.metaDescription,
            fm.title || "",
            body
          );
          if (newMeta !== fm.metaDescription) {
            markdown = replaceFrontmatterField(markdown, "metaDescription", newMeta);
            console.log(`    ${metaLen} -> ${newMeta.length} chars`);
            if (newMeta.length >= META_MIN && newMeta.length <= META_MAX) {
              stats.metaFixed++;
            } else {
              stats.metaGaveUp++;
            }
            changed = true;
          }
        } catch (err) {
          console.error(`    Error: ${err.message}`);
          stats.errors++;
        }
      }
    }

    if (changed) {
      await fs.writeFile(filePath, markdown, "utf8");
    } else {
      stats.unchanged++;
    }
  }

  console.log(`\n── Summary ───────────────────────────────────────`);
  console.log(`Em dashes fixed:          ${stats.emDashFixed}`);
  console.log(`metaDescriptions fixed:   ${stats.metaFixed}`);
  console.log(`metaDescriptions JS fix:  ${stats.metaGaveUp}`);
  console.log(`No meta field:            ${stats.noMeta}`);
  console.log(`Thin posts skipped:       ${stats.thinSkipped}`);
  console.log(`Errors:                   ${stats.errors}`);
  console.log(`Unchanged:                ${stats.unchanged}`);

  if (skippedThin.length > 0) {
    console.log(`\n── Thin posts (skipped) ──────────────────────────`);
    skippedThin.forEach(f => console.log(`  ${f}`));
  }

  console.log(`\nDone.\n`);
}

main();