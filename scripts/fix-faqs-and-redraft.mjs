import { google } from "googleapis";
import Anthropic from "@anthropic-ai/sdk";
import mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import fs from "fs/promises";
import path from "path";
import { Readable } from "stream";

// ── Config ────────────────────────────────────────────────────────────────────
const CONTENT_DIR      = "../content/blog";
const FOLDER_ID        = "11p6yreT-oRKeDKZzpf2xCq6l0Fstu0kx";
const OUTPUT_FOLDER_ID = "1tb5IStkDLbGksx0Cip5MtW92obFshcwH";
const KEY_FILE         = "/Users/michaelsidler/Sites/db-historical-blog-redraft/redrafted-blogs-e64a8b003ede.json";
const MODEL            = "claude-sonnet-4-6";

// Posts that need a FAQ section appended
const FAQ_TARGETS = [
  "2018.07-the-12-competencies-of-ux-design.md",
  "2019.12-3-ux-design-predictions-for-2020.md",
  "2020.05-four-common-ux-needs-and-six-ways-to-solve-them.md",
  "2020.08-how-to-train-and-develop-the-12-competencies-of-ux-design.md",
  "2025.05-personalized-ux-how-to-design-software-that-feels-like-it-knows-you.md",
  "2025.07-ux-debt-the-silent-killer-of-product-momentum.md",
];

// Post that needs a full body redraft from Drive source
const REDRAFT_TARGET = "2021.04d-how-to-know-if-your-voice-of-the-customer-program-is-working.md";
const REDRAFT_DATE_PREFIX = "2021.04d";

const FAQ_PROMPT = `Read this blog post carefully and write a FAQ section for it.

Requirements:
- 4 to 5 questions and answers
- Questions must be phrased as natural language queries someone would type or speak into a search engine or AI tool
- Each answer must be concise and self-contained -- 2 to 4 sentences
- Answers must directly address the question without preamble
- Do not use em dashes
- Do not repeat content already covered in the post -- add genuine additional value
- Match the tone and voice of the post exactly

Output format -- use exactly this structure, nothing else:

## Frequently Asked Questions

**[Question one?]**
[Answer one.]

**[Question two?]**
[Answer two.]

(and so on)

Output only the FAQ section. No preamble, no closing note.

Here is the blog post:`;

const BODY_REDRAFT_PROMPT = `I am uploading a blog post from our company. Please redraft this blog post to optimize it for Answer Engine Optimization (AEO) while preserving the original tone, voice, and brand personality exactly as written.

When redrafting, please apply the following:

## Structure & Format
1. Open with a concise, direct answer to the core question the post addresses
2. Use clear H2 and H3 headings framed as questions where natural
3. Break content into short, scannable sections with one clear idea per section
4. Include a FAQ section at the end (4-5 questions and concise answers)

## Content
1. Ensure every section answers a specific question a user might type or speak into a search engine or AI tool
2. Lead each section with the answer, then follow with supporting detail (inverted pyramid style)
3. Use plain, direct language -- avoid fluff, filler, and unnecessary preamble
4. Base FAQ questions on natural language queries someone would type or speak

## Tone & Voice
1. Match the tone and voice of the original post precisely
2. Preserve any brand personality or stylistic quirks present in the original

## Output
1. Never use em dashes
2. Do not use horizontal lines to break sections
3. Format the output as Markdown body content only -- no frontmatter, no style blocks, no pre tags, no ASCII art
4. Output only the blog post body starting from the first heading or opening paragraph
5. Do not include any preamble, commentary, or closing notes

Here is the blog post content:`;

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractBody(markdown) {
  let body = markdown.replace(/^---[\s\S]*?---\n/, "");
  body = body.replace(/<style>[\s\S]*?<\/style>\s*<pre[^>]*>[\s\S]*?<\/pre>/, "");
  body = body.replace(/<[^>]+>/g, "");
  return body.trim();
}

function extractHeader(markdown) {
  const preEnd = markdown.indexOf("</pre>");
  if (preEnd === -1) return null;
  return markdown.slice(0, preEnd + 6);
}

function datePrefix(filename) {
  const m = filename.match(/^(\d{4}\.\d{2}[a-z]?)/i);
  return m ? m[1] : null;
}

// ── Google Drive auth ─────────────────────────────────────────────────────────
async function getDriveClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
  return google.drive({ version: "v3", auth });
}

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

// ── Task 1: Append FAQ to posts missing one ───────────────────────────────────
async function appendFaqs(anthropic) {
  console.log("── Appending FAQs ───────────────────────────────────");
  let done = 0, errors = 0;

  for (const filename of FAQ_TARGETS) {
    // Handle quoted filenames
    const possibleNames = [filename, `"${filename.replace(/\.md$/, '')}.md"`];
    let filePath = null;
    for (const name of possibleNames) {
      const candidate = path.join(CONTENT_DIR, name);
      try {
        await fs.access(candidate);
        filePath = candidate;
        break;
      } catch {}
    }

    // Also try a glob-style match for quoted filenames on disk
    if (!filePath) {
      const entries = await fs.readdir(CONTENT_DIR);
      const base = filename.replace(/\.md$/, "").replace(/^"|"$/g, "");
      const match = entries.find(e => e.replace(/^"|"$/g, "").replace(/\.md$/, "") === base);
      if (match) filePath = path.join(CONTENT_DIR, match);
    }

    if (!filePath) {
      console.log(`  Not found on disk: ${filename}`);
      errors++;
      continue;
    }

    console.log(`Processing: ${path.basename(filePath)}`);
    try {
      const markdown = await fs.readFile(filePath, "utf8");
      const body = extractBody(markdown);

      const msg = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        messages: [{ role: "user", content: `${FAQ_PROMPT}\n\n${body}` }],
      });

      const faq = msg.content[0].text.trim();
      const updated = `${markdown.trimEnd()}\n\n${faq}\n`;
      await fs.writeFile(filePath, updated, "utf8");
      console.log(`  FAQ appended: ${path.basename(filePath)}\n`);
      done++;
    } catch (err) {
      console.error(`  Error: ${err.message}`);
      errors++;
    }
  }

  console.log(`FAQs done: ${done} | Errors: ${errors}\n`);
}

// ── Task 2: Full body redraft for 2021.04d ────────────────────────────────────
async function redraftThinPost(anthropic, drive) {
  console.log("── Redrafting thin post ─────────────────────────────");
  console.log(`Target: ${REDRAFT_TARGET}`);

  const entries = await fs.readdir(CONTENT_DIR);
  const localName = entries.find(e => e.includes("2021.04d"));
  if (!localName) {
    console.error("Could not find 2021.04d file locally.");
    return;
  }

  const filePath = path.join(CONTENT_DIR, localName);
  const markdown = await fs.readFile(filePath, "utf8");
  const header = extractHeader(markdown);
  if (!header) {
    console.error("Could not extract header block.");
    return;
  }

  const sourceFiles = await listSourceFiles(drive);
  const match = sourceFiles.find(f => {
    const src = datePrefix(f.name.replace(/\s+/g, "-").toLowerCase());
    return src === REDRAFT_DATE_PREFIX;
  });

  if (!match) {
    console.error(`No Drive source found for prefix: ${REDRAFT_DATE_PREFIX}`);
    return;
  }

  console.log(`  Matched Drive source: ${match.name}`);

  try {
    const downloaded = await downloadFile(drive, match);
    const sourceText = await extractText(downloaded);

    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: `${BODY_REDRAFT_PROMPT}\n\n${sourceText}` }],
    });

    const newBody = msg.content[0].text.trim();
    const updatedMarkdown = `${header}\n\n${newBody}\n`;

    await fs.writeFile(filePath, updatedMarkdown, "utf8");
    console.log(`  Saved locally: ${localName}`);

    await uploadToDrive(drive, localName, updatedMarkdown);
    console.log(`  Uploaded to Drive: ${localName}\n`);
  } catch (err) {
    console.error(`  Error: ${err.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const anthropic = new Anthropic();
  const drive = await getDriveClient();

  await appendFaqs(anthropic);
  await redraftThinPost(anthropic, drive);

  console.log("All done. Run verify-blogs.mjs to confirm.\n");
}

main();