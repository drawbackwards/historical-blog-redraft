import { google } from "googleapis";
import Anthropic from "@anthropic-ai/sdk";
import mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "fs/promises";
import path from "path";
import { Readable } from "stream";

// ── Config ────────────────────────────────────────────────────────────────────
const FOLDER_ID        = "11p6yreT-oRKeDKZzpf2xCq6l0Fstu0kx";
const OUTPUT_FOLDER_ID = "1tb5IStkDLbGksx0Cip5MtW92obFshcwH";
const KEY_FILE         = "/Users/michaelsidler/Sites/db-historical-blog-redraft/redrafted-blogs-e64a8b003ede.json";
const CONTENT_DIR      = "../content/blog";
const MODEL            = "claude-sonnet-4-6";

// Posts below this word count are considered thin and will be redrafted
const THIN_THRESHOLD   = 200;

const REDRAFT_PROMPT = `I am uploading a blog post from our company. Please redraft this blog post to optimize it for Answer Engine Optimization (AEO) while preserving the original tone, voice, and brand personality exactly as written.

When redrafting, please apply the following:

## Structure & Format
1. Open with a concise, direct answer to the core question the post addresses — this should work as a standalone answer snippet
2. Use clear H2 and H3 headings framed as questions where natural (e.g. "What is...?", "How does...?", "Why does...?")
3. Break content into short, scannable sections with one clear idea per section
4. Include a brief FAQ section at the end (3–5 questions and concise answers) covering the most likely questions someone would ask about this topic

## Content
1. Identify the primary keyword or question this post targets and ensure it appears in the opening answer, the first H2, and the meta description
2. Ensure every section answers a specific question a user might type or speak into a search engine or AI tool
3. Lead each section with the answer, then follow with supporting detail (inverted pyramid style)
4. Define any key terms clearly and early
5. Use plain, direct language — avoid fluff, filler, and unnecessary preamble
6. Where lists add clarity, use them. Keep list items specific and complete enough to stand alone as answers
7. Base FAQ questions on natural language queries someone would type or speak — not generic topic questions

## Tone & Voice
1. Match the tone and voice of the original post precisely — do not make it sound more formal, more casual, or more generic than the original
2. Preserve any brand personality, humour, or stylistic quirks present in the original

## Length
1. Aim to match the original post length unless content can be tightened without losing value
2. Never pad content to hit a word count — every sentence should earn its place

## Output
1. Never use em-dashes in any of your output
2. Do not use horizontal lines to break sections
3. Format the output as Markdown body content only -- no frontmatter, no style blocks, no pre tags, no ASCII art
4. Output only the blog post body starting from the first heading or opening paragraph
5. Do not include any preamble, commentary, or closing notes

Here is the blog post content:`;

// ── Google Drive auth ─────────────────────────────────────────────────────────
async function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

// ── List all source files in input folder ─────────────────────────────────────
async function listSourceFiles(drive) {
  let allFiles = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${FOLDER_ID}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageSize: 1000,
      pageToken,
    });
    allFiles = allFiles.concat(res.data.files);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return allFiles.filter(f =>
    f.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    f.mimeType === "application/pdf" ||
    f.mimeType === "application/vnd.google-apps.document"
  );
}

// ── Download file to buffer ───────────────────────────────────────────────────
async function downloadFile(drive, file) {
  if (file.mimeType === "application/vnd.google-apps.document") {
    const res = await drive.files.export(
      { fileId: file.id, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      { responseType: "arraybuffer" }
    );
    return { buffer: Buffer.from(res.data), mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  }
  const res = await drive.files.get(
    { fileId: file.id, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return { buffer: Buffer.from(res.data), mimeType: file.mimeType };
}

// ── Extract text from buffer ──────────────────────────────────────────────────
async function extractText({ buffer, mimeType }) {
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (mimeType === "application/pdf") {
    const pdf = await getDocument({ data: new Uint8Array(buffer) }).promise;
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(item => item.str).join(" ") + "\n";
    }
    return text;
  }
  throw new Error(`Unsupported file type: ${mimeType}`);
}

// ── Call Claude for body-only redraft ─────────────────────────────────────────
async function redraftBody(client, sourceText) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [
      { role: "user", content: `${REDRAFT_PROMPT}\n\n${sourceText}` }
    ],
  });
  return msg.content[0].text.trim();
}

// ── Extract the preserved header (frontmatter + style + pre block) ────────────
function extractHeader(markdown) {
  // Grab everything up to and including the closing </pre> tag
  const preEnd = markdown.indexOf("</pre>");
  if (preEnd === -1) return null;
  return markdown.slice(0, preEnd + 6); // include </pre>
}

// ── Word count helper ─────────────────────────────────────────────────────────
function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

// ── Derive a loose match key from a filename (date prefix only) ───────────────
// e.g. "2022.04-when-and-how..." -> "2022.04"
function datePrefix(filename) {
  const m = filename.match(/^(\d{4}\.\d{2}[a-z]?)/i);
  return m ? m[1] : null;
}

// ── Upload updated file to Drive output folder ────────────────────────────────
async function uploadToDrive(drive, filename, content) {
  const stream = Readable.from([content]);
  await drive.files.create({
    requestBody: {
      name: filename,
      mimeType: "text/markdown",
      parents: [OUTPUT_FOLDER_ID],
    },
    media: { mimeType: "text/markdown", body: stream },
    supportsAllDrives: true,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const drive     = await getDriveClient();
  const anthropic = new Anthropic();

  // Step 1: find all local .md files that are thin/empty
  console.log("Scanning local blog files for thin/empty posts...\n");
  const localFiles = (await fs.readdir(CONTENT_DIR))
    .filter(f => f.endsWith(".md"))
    .map(f => path.join(CONTENT_DIR, f));

  const thinFiles = [];
  for (const filePath of localFiles) {
    const markdown = await fs.readFile(filePath, "utf8");
    // Strip frontmatter + ASCII block to get body
    let body = markdown.replace(/^---[\s\S]*?---\n/, "");
    body = body.replace(/<style>[\s\S]*?<\/style>\s*<pre[^>]*>[\s\S]*?<\/pre>/, "");
    body = body.replace(/<[^>]+>/g, "").trim();
    if (wordCount(body) < THIN_THRESHOLD) {
      thinFiles.push({ filePath, filename: path.basename(filePath), markdown });
    }
  }

  if (thinFiles.length === 0) {
    console.log("No thin/empty posts found. Nothing to do.");
    return;
  }

  console.log(`Found ${thinFiles.length} thin/empty post(s) to redraft.\n`);

  // Step 2: load all source files from Drive once
  console.log("Fetching source file list from Google Drive...");
  const sourceFiles = await listSourceFiles(drive);
  console.log(`Found ${sourceFiles.length} source file(s) in Drive.\n`);

  // Step 3: process each thin file
  let done = 0, skipped = 0, errors = 0;

  for (const { filePath, filename, markdown } of thinFiles) {
    const prefix = datePrefix(filename);

    // Match Drive source file by date prefix
    const match = sourceFiles.find(f => {
      const srcPrefix = datePrefix(f.name.replace(/\s+/g, "-").toLowerCase());
      return srcPrefix && prefix && srcPrefix === prefix;
    });

    if (!match) {
      console.log(`No Drive source found for: ${filename} (prefix: ${prefix})`);
      skipped++;
      continue;
    }

    console.log(`Processing: ${filename}`);
    console.log(`  Matched source: ${match.name}`);

    try {
      // Download and extract original text from Drive
      const downloaded  = await downloadFile(drive, match);
      const sourceText  = await extractText(downloaded);

      // Redraft body only
      const newBody = await redraftBody(anthropic, sourceText);

      // Preserve the existing header (frontmatter + style + ASCII art)
      const header = extractHeader(markdown);
      if (!header) throw new Error("Could not extract header block from local file");

      // Splice together: preserved header + blank line + new body
      const updatedMarkdown = `${header}\n\n${newBody}\n`;

      // Save locally
      await fs.writeFile(filePath, updatedMarkdown, "utf8");
      console.log(`  Saved locally: ${filename}`);

      // Update Drive output folder (overwrite by uploading with same name)
      await uploadToDrive(drive, filename, updatedMarkdown);
      console.log(`  Uploaded to Drive: ${filename}\n`);

      done++;
    } catch (err) {
      console.error(`  Error processing ${filename}:`, err.message);
      errors++;
    }
  }

  console.log(`── Done ─────────────────────────────────────────`);
  console.log(`Redrafted:        ${done}`);
  console.log(`No source found:  ${skipped}`);
  console.log(`Errors:           ${errors}`);
  console.log(`\nRun verify-blogs.mjs to confirm all posts are now clean.\n`);
}

main();