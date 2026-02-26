#!/usr/bin/env node
/**
 * redraft-blogs.mjs
 *
 * Reads draft blog posts from the blogs/ directory, redrafts each one using
 * Claude, and writes the improved version back to disk.
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLOGS_DIR = path.join(__dirname, "..", "blogs");

const client = new Anthropic();

const SYSTEM_PROMPT = `You are an expert content writer and editor for Drawbackwards, a premier design and branding agency.
Your task is to redraft blog posts to be polished, engaging, and reflective of the agency's expertise and voice.

Guidelines:
- Maintain the same core topics, key points, and structure (headings, sections)
- Elevate the writing quality: use precise language, vivid examples, and confident prose
- Reflect Drawbackwards' authoritative voice as design leaders and strategic thinkers
- Keep the frontmatter (title, date, author) unchanged, but update status from "draft" to "published"
- The tone should be professional yet approachable — expert but never condescending
- Expand thin sections with concrete insights, real-world context, or actionable advice
- Fix any grammatical or stylistic issues
- Return only the complete redrafted markdown document with no extra commentary`;

async function getBlogFiles() {
  const entries = await fs.readdir(BLOGS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => path.join(BLOGS_DIR, e.name));
}

async function redraftBlog(filePath) {
  const filename = path.basename(filePath);
  console.log(`\nRedrafting: ${filename}`);

  const content = await fs.readFile(filePath, "utf-8");

  const message = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Please redraft the following blog post:\n\n${content}`,
      },
    ],
  });

  const redrafted = message.content[0].text;
  await fs.writeFile(filePath, redrafted, "utf-8");
  console.log(`  Done: ${filename}`);
}

async function main() {
  console.log("=== Drawbackwards Blog Redraft Tool ===");

  const files = await getBlogFiles();
  if (files.length === 0) {
    console.log("No blog files found in blogs/");
    process.exit(0);
  }

  console.log(`Found ${files.length} blog(s) to redraft.`);

  for (const file of files) {
    await redraftBlog(file);
  }

  console.log("\nAll blogs redrafted successfully.");
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
