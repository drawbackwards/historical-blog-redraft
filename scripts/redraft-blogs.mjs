import { google } from "googleapis";
import Anthropic from "@anthropic-ai/sdk";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import fs from "fs/promises";
import path from "path";
import { Readable } from "stream";

// ── Config ────────────────────────────────────────────────────────────────────
const FOLDER_ID        = "11p6yreT-oRKeDKZzpf2xCq6l0Fstu0kx"; // Google Drive input folder
const OUTPUT_FOLDER_ID = "1tb5IStkDLbGksx0Cip5MtW92obFshcwH"; // Google Drive output folder
const KEY_FILE         = "/home/user/db-website/redrafted-blogs-35a05540d4ad.json"; // service account key
const OUTPUT_DIR       = "./content/blog"; // local Next.js blog content folder
const MODEL            = "claude-sonnet-4-6";

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

## Blog Header Image
1. We will need a 16x9 blog header image that is a good representation of the blog content
2. It needs to be created as ASCII art
3. The site uses a dark theme by default, so the ASCII art should display as white text on the web
4. When the user switches to light mode, the ASCII art should switch to black text to remain visible against the light background
5. When the post is printed or saved to a PDF, the ASCII art should also render in black text so it is legible on a white page

## Output
1. Never use em-dashes in any of your output
2. Don't use horizontal lines to break sections. Just a normal return will do
3. Format the entire output as Markdown
4. Include a frontmatter block at the top with the following fields: title, date, metaDescription, and slug. The slug should be a lowercase, hyphenated version of the title. The metaDescription should be 150-160 characters and include the primary keyword
5. Provide the full redrafted blog post, ready to publish

Here is the blog post content:`;

// ── Google Drive auth ─────────────────────────────────────────────────────────
async function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

// ── List files in input folder ────────────────────────────────────────────────
async function listFiles(drive) {
  const res = await drive.files.list({
    q: `'${FOLDER_ID}' in parents and trashed = false`,
    fields: "files(id, name, mimeType)",
  });
  return res.data.files.filter(f =>
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

// ── Extract text from file buffer ─────────────────────────────────────────────
async function extractText({ buffer, mimeType }) {
  if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (mimeType === "application/pdf") {
    const result = await pdfParse(buffer);
    return result.text;
  }
  throw new Error(`Unsupported file type: ${mimeType}`);
}

// ── Call Claude to redraft ────────────────────────────────────────────────────
async function redraftPost(client, text) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [
      { role: "user", content: `${REDRAFT_PROMPT}\n\n${text}` }
    ],
  });
  return msg.content[0].text;
}

// ── Extract slug from frontmatter ─────────────────────────────────────────────
function extractSlug(markdown, fallback) {
  const match = markdown.match(/^slug:\s*(.+)$/m);
  return match ? match[1].trim() : fallback;
}

// ── Save output locally to Next.js content folder ────────────────────────────
async function saveLocally(markdown, slug) {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const filePath = path.join(OUTPUT_DIR, `${slug}.md`);
  await fs.writeFile(filePath, markdown, "utf8");
  console.log(`  Saved locally: ${filePath}`);
}

// ── Upload output to Google Drive output folder ───────────────────────────────
async function uploadToDrive(drive, filename, content) {
  const stream = Readable.from([content]);
  await drive.files.create({
    requestBody: {
      name: filename,
      mimeType: "text/markdown",
      parents: [OUTPUT_FOLDER_ID],
    },
    media: {
      mimeType: "text/markdown",
      body: stream,
    },
  });
  console.log(`  Uploaded to Drive: ${filename}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const drive = await getDriveClient();
  const anthropic = new Anthropic();

  console.log("Fetching files from Google Drive...");
  const files = await listFiles(drive);

  if (files.length === 0) {
    console.log("No supported files found in folder.");
    return;
  }

  console.log(`Found ${files.length} file(s). Starting redraft...\n`);

  for (const file of files) {
    console.log(`Processing: ${file.name}`);
    try {
      const downloaded = await downloadFile(drive, file);
      const text = await extractText(downloaded);
      const redrafted = await redraftPost(anthropic, text);
      const fallbackSlug = file.name.toLowerCase().replace(/\s+/g, "-").replace(/\.[^.]+$/, "");
      const slug = extractSlug(redrafted, fallbackSlug);
      await saveLocally(redrafted, slug);
      await uploadToDrive(drive, `${slug}.md`, redrafted);
      console.log(`  Done: ${file.name}\n`);
    } catch (err) {
      console.error(`  Error processing ${file.name}:`, err.message);
    }
  }

  console.log("All done. Check your content/blog folder and Google Drive output folder.");
}

main();
