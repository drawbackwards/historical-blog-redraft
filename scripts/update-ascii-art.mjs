import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";

// ── Config ────────────────────────────────────────────────────────────────────
const CONTENT_DIR = "./content/blog";
const MODEL       = "claude-sonnet-4-6";
const TEST_MODE   = true; // set to false to process all files

const ASCII_PROMPT = `Read the blog post carefully. You are going to create a dense, richly detailed ASCII art scene that evokes the emotional or conceptual essence of the post. This is not an illustration of the topic -- it is an atmospheric scene that makes someone feel the idea before they read a word.

## The Creative Philosophy

Think like a film director choosing a visual metaphor for an opening scene, or a poet choosing an image to carry an emotion. The connection between your illustration and the blog post should be felt, not explained. It can be abstract. It should never be literal.

A post about prototyping is not a scene of wireframes. It could be a rocket being assembled on a launchpad under a vast night sky -- because both are about building something carefully before committing to launch.

A post about UX research is not a scene of surveys. It could be a lone figure standing at the edge of a cliff looking out over an uncharted ocean -- because both are about venturing into the unknown to find truth.

A post about design systems is not a scene of components. It could be a vast ancient library where every book is perfectly ordered -- because both are about creating structure that scales.

A post about user retention is not a scene of graphs. It could be a harbour full of ships all returning to the same lighthouse -- because both are about the force that brings people back.

The more unexpected and resonant the connection, the better. Trust the abstraction.

## What Makes a Great Scene

- A strong sense of place -- the viewer should immediately know where they are
- Atmosphere -- time of day, weather, mood, light and shadow
- A focal point -- one dominant element the eye is drawn to first
- Supporting detail that fills the world around that focal point
- A feeling of life -- the scene should feel inhabited or alive
- No text labels, no annotations, no explanatory words of any kind inside the art

## ASCII Rendering Style

Build the scene using the isometric, architectural style of a dense ASCII cityscape:
- Construct recognizable objects from repeated structural characters so well that they are identifiable without labels -- a bus should look like a bus, a lighthouse like a lighthouse, a rocket like a rocket
- Use consistent diagonal lines / and \\ to create depth and perspective throughout
- Layer foreground, midground and background to create a sense of space
- Fill every part of the canvas with purposeful detail -- texture, pattern, environment
- Use the full character set: / \\ | _ . : ; ~ = + - * # @ ! ( ) [ ] { } < > ^ v

## Composition
- Width: exactly 80 characters wide -- every line must be exactly 80 characters
- Height: 30-40 lines tall
- Fill the entire canvas -- no large empty regions
- One clear focal point surrounded by rich environmental detail
- Create depth through layering -- things in the distance should feel smaller and less dense

## What to Avoid
- Any text, labels, or words inside the illustration
- Literal representations of the blog topic -- no wireframes for UX posts, no coins for ROI posts
- Diagrams, flowcharts, arrows, or anything that looks like an infographic
- Simple or sparse compositions -- density and detail are essential
- Generic or cliched imagery -- push past the first obvious idea

## Technical Requirements
- Output only the raw ASCII art -- no explanation, no code fences, no labels, no title
- Every line must be exactly 80 characters wide, padded with spaces if needed
- The art will be displayed in a monospace font inside a <pre> tag
- It will appear as white text on a dark background in dark mode, and black text on white in light mode and print
- Produce clean, high-contrast art that works legibly in both contexts

Here is the blog post content:`;

// ── Get list of blog files ────────────────────────────────────────────────────
async function getBlogFiles() {
  const entries = await fs.readdir(CONTENT_DIR);
  return entries
    .filter(f => f.endsWith(".md"))
    .map(f => path.join(CONTENT_DIR, f));
}

// ── Extract blog content (everything after frontmatter) ───────────────────────
function extractContent(markdown) {
  const withoutFrontmatter = markdown.replace(/^---[\s\S]*?---\n/, "");
  const withoutAscii = withoutFrontmatter.replace(
    /<style>[\s\S]*?<\/style>\s*<pre class="blog-header-ascii">[\s\S]*?<\/pre>/,
    ""
  );
  return withoutAscii.trim();
}

// ── Generate new ASCII art via Claude ─────────────────────────────────────────
async function generateAsciiArt(client, content) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [
      { role: "user", content: `${ASCII_PROMPT}\n\n${content}` }
    ],
  });
  return msg.content[0].text.trim();
}

// ── Replace ASCII art in markdown file ───────────────────────────────────────
function replaceAsciiArt(markdown, newArt) {
  const prePattern = /(<pre class="blog-header-ascii">)([\s\S]*?)(<\/pre>)/;
  if (!prePattern.test(markdown)) {
    throw new Error("Could not find <pre class=\"blog-header-ascii\"> block");
  }
  return markdown.replace(prePattern, `$1\n${newArt}\n$3`);
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
    files = [files[0]];
    console.log(`TEST MODE -- processing 1 file only: ${path.basename(files[0])}\n`);
  } else {
    console.log(`Found ${files.length} file(s). Starting ASCII art update...\n`);
  }

  for (const filePath of files) {
    const filename = path.basename(filePath);
    console.log(`Processing: ${filename}`);
    try {
      const markdown = await fs.readFile(filePath, "utf8");
      const content = extractContent(markdown);
      const newArt = await generateAsciiArt(anthropic, content);
      const updated = replaceAsciiArt(markdown, newArt);
      await fs.writeFile(filePath, updated, "utf8");
      console.log(`  Done: ${filename}\n`);

      if (TEST_MODE) {
        console.log("── Preview of generated ASCII art ──");
        console.log(newArt);
        console.log("────────────────────────────────────");
      }
    } catch (err) {
      console.error(`  Error processing ${filename}:`, err.message);
    }
  }

  console.log(TEST_MODE
    ? "\nTest complete. Check the output above and the file to review quality."
    : "\nAll done. ASCII art updated across all blog posts."
  );
}

main();