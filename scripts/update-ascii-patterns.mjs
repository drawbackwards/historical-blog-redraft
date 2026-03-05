import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";

// ── Config ────────────────────────────────────────────────────────────────────
const CONTENT_DIR = "./content/blog";
const MODEL       = "claude-sonnet-4-6";
const TEST_MODE   = false;
const WIDTH       = 80;
const HEIGHT      = 10;

// ── Pattern styles ────────────────────────────────────────────────────────────
function generateStyleA() {
  const rows = [];
  const tiles = ["/\\/\\", "|><||><|", "\\/||\\/"];
  for (let i = 0; i < HEIGHT; i++) {
    let row = "";
    while (row.length < WIDTH + 10) row += tiles[i % 3];
    rows.push(row.slice(0, WIDTH));
  }
  return rows.join("\n");
}

function generateStyleB() {
  const base = [
    "~~~~^~~~~^~~~~^~~~~^~~~~^~~~~^~~~~^~~~~^~~~~^~~~~^~~~~^~~~~^~~~~^~~~~^~~~~^~~",
    "~~~^^^~~~^^^~~~^^^~~~^^^~~~^^^~~~^^^~~~^^^~~~^^^~~~^^^~~~^^^~~~^^^~~~^^^~~~^^",
    "~~^^^^^~~^^^^^~~^^^^^~~^^^^^~~^^^^^~~^^^^^~~^^^^^~~^^^^^~~^^^^^~~^^^^^~~^^^^^",
    "~^^^^^^^~^^^^^^^~^^^^^^^~^^^^^^^~^^^^^^^~^^^^^^^~^^^^^^^~^^^^^^^~^^^^^^^~^^^^",
    "^^~~~~~^^~~~~~^^~~~~~^^~~~~~^^~~~~~^^~~~~~^^~~~~~^^~~~~~^^~~~~~^^~~~~~^^~~~~~",
    "^~~~~~~~^~~~~~~~^~~~~~~~^~~~~~~~^~~~~~~~^~~~~~~~^~~~~~~~^~~~~~~~^~~~~~~~^~~~~",
  ];
  const rows = [];
  for (let i = 0; i < HEIGHT; i++) {
    let p = base[i % base.length];
    while (p.length < WIDTH + 10) p += p;
    rows.push(p.slice(0, WIDTH));
  }
  return rows.join("\n");
}

function generateStyleC(palette) {
  const palettes = {
    energetic:  { outer: "!~", mid: "Oo", inner: "0+", core: "#=" },
    calm:       { outer: ".-", mid: "o~", inner: "~-", core: "- " },
    technical:  { outer: ":=", mid: "+|", inner: "=+", core: "|=" },
    human:      { outer: "~o", mid: "oO", inner: "Oo", core: "@o" },
    complex:    { outer: "*~", mid: "%&", inner: "&*", core: "#%" },
    simple:     { outer: ". ", mid: " -", inner: "_ ", core: " _" },
  };
  const p = palettes[palette] || palettes.calm;
  const bands = [p.outer, p.mid, p.inner, p.core, p.inner, p.core, p.inner, p.core, p.mid, p.outer];
  const rows = [];
  for (let i = 0; i < HEIGHT; i++) {
    let row = bands[i] || p.core;
    while (row.length < WIDTH + 10) row += row;
    rows.push(row.slice(0, WIDTH));
  }
  return rows.join("\n");
}

// ── Ask Claude which palette fits the post ────────────────────────────────────
async function getPalette(client, content) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 10,
    messages: [{
      role: "user",
      content: `Read this blog post and respond with exactly one word from this list that best describes its mood or energy: energetic, calm, technical, human, complex, simple.

Blog post:
${content.slice(0, 1000)}

Respond with only the single word, nothing else.`
    }],
  });
  const word = msg.content[0].text.trim().toLowerCase();
  const valid = ["energetic", "calm", "technical", "human", "complex", "simple"];
  return valid.includes(word) ? word : "calm";
}

// ── Pick a consistent style based on filename ─────────────────────────────────
function pickStyle(filename) {
  const sum = filename.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return ["A", "B", "C"][sum % 3];
}

// ── Generate pattern based on style ──────────────────────────────────────────
async function generatePattern(client, style, content) {
  if (style === "A") return generateStyleA();
  if (style === "B") return generateStyleB();
  const palette = await getPalette(client, content);
  console.log(`  Style C palette: ${palette}`);
  return generateStyleC(palette);
}

// ── Get list of blog files ────────────────────────────────────────────────────
async function getBlogFiles() {
  const entries = await fs.readdir(CONTENT_DIR);
  return entries
    .filter(f => f.endsWith(".md"))
    .map(f => path.join(CONTENT_DIR, f));
}

// ── Extract blog content ──────────────────────────────────────────────────────
function extractContent(markdown) {
  return markdown
    .replace(/^---[\s\S]*?---\n/, "")
    .replace(/<style>[\s\S]*?<\/style>\s*<pre[^>]*>[\s\S]*?<\/pre>/, "")
    .trim();
}

// ── Check if file already has a pattern ──────────────────────────────────────
function hasPattern(markdown) {
  const match = markdown.match(/<pre[^>]*class="blog-header-ascii"[^>]*>([\s\S]*?)<\/pre>/);
  if (!match) return false;
  return match[1].trim().length > 0;
}

// ── Replace pattern in markdown file ─────────────────────────────────────────
function replacePattern(markdown, newPattern) {
  // Match any variation of the pre tag with blog-header-ascii class
  const prePattern = /(<pre[^>]*class="blog-header-ascii"[^>]*>)([\s\S]*?)(<\/pre>)/;
  if (!prePattern.test(markdown)) {
    throw new Error(`Could not find <pre class="blog-header-ascii"> block`);
  }
  return markdown.replace(prePattern, `$1\n${newPattern}\n$3`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const anthropic = new Anthropic();

  console.log("Fetching blog files...");
  let files = await getBlogFiles();

  if (files.length === 0) {
    console.log("No blog files found.");
    return;
  }

  if (TEST_MODE) {
    files = files.slice(0, 3);
    console.log(`TEST MODE -- processing 3 files\n`);
  } else {
    console.log(`Found ${files.length} file(s). Updating patterns...\n`);
  }

  let done = 0;
  let skipped = 0;
  let errors = 0;

  for (const filePath of files) {
    const filename = path.basename(filePath);
    const markdown = await fs.readFile(filePath, "utf8");

    // Skip files that already have a pattern
    if (!TEST_MODE && hasPattern(markdown)) {
      skipped++;
      continue;
    }

    const style = pickStyle(filename);
    console.log(`Processing: ${filename} (Style ${style})`);

    try {
      const content = extractContent(markdown);
      const pattern = await generatePattern(anthropic, style, content);
      const updated = replacePattern(markdown, pattern);
      await fs.writeFile(filePath, updated, "utf8");

      if (TEST_MODE) {
        console.log(`\n── Style ${style} preview ──`);
        console.log(pattern);
        console.log("─────────────────────────\n");
      } else {
        console.log(`  Done: ${filename}`);
        done++;
      }
    } catch (err) {
      console.error(`  Error processing ${filename}:`, err.message);
      errors++;
    }
  }

  console.log(`\nDone: ${done} | Skipped (already complete): ${skipped} | Errors: ${errors}`);
}

main();