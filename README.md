# Drawbackwards Historical Blog Redraft

This repository contains 148 historical Drawbackwards blog posts, redrafted for Answer Engine Optimization (AEO) and normalized for use in the new Next.js website build.

## What Is In This Repo

All blog content lives in `content/blog/`. Each file is a Markdown document ready to be imported directly into the Next.js site.

Every post contains:

- A frontmatter block at the top with `title`, `date`, `metaDescription`, and `slug`
- An ASCII art header image inside a `<pre class="blog-header-ascii">` tag with an accompanying `<style>` block that handles dark mode, light mode, and print rendering
- A full AEO-optimized blog post body with H2/H3 question-based headings, inverted pyramid structure, and a FAQ section at the end
- No em dashes, no horizontal rules, clean Markdown throughout

## Frontmatter Structure

Each file opens with:

```
---
title: Post Title Here
date: YYYY-MM-DD
metaDescription: 150-160 character description including primary keyword
slug: lowercase-hyphenated-slug
---
```

## File Naming Convention

Files are named with a date prefix followed by the slug:

```
YYYY.MM-slug-of-the-post.md
```

Some months have multiple posts using suffixes like `a`, `b`, `c`:

```
2021.04a-why-listen-to-the-voice-of-the-customer.md
2021.04b-what-is-customer-experience-really.md
```

Some filenames contain quotes inherited from the original source filenames. These are valid on disk and in git but should be renamed to remove the quotes when importing if your file system or build tool has trouble with them.

## How to Import Into the Next.js Site

If you are working in Claude Code on the main site build and need to bring these blog posts in, follow these steps:

**Step 1 -- Clone this repo alongside the main project:**
```bash
git clone git@github.com:drawbackwards/historical-blog-redraft.git
```

**Step 2 -- Copy the content folder into the Next.js project:**
```bash
cp -r historical-blog-redraft/content/blog/* your-nextjs-project/content/blog/
```

**Step 3 -- Parse frontmatter in Next.js**

Use a library like `gray-matter` to parse the frontmatter from each `.md` file. The fields available are `title`, `date`, `metaDescription`, and `slug`.

Example using `gray-matter`:
```js
import matter from 'gray-matter';
import fs from 'fs';
import path from 'path';

const files = fs.readdirSync('./content/blog');
const posts = files.map(filename => {
  const raw = fs.readFileSync(path.join('./content/blog', filename), 'utf8');
  const { data, content } = matter(raw);
  return { ...data, content };
});
```

**Step 4 -- Render the ASCII art header**

Each post body contains a raw `<style>` block and a `<pre class="blog-header-ascii">` block at the top. These need to be rendered as raw HTML, not escaped. If you are using `next-mdx-remote` or `remark`/`rehype`, make sure HTML passthrough is enabled.

The style block handles three rendering contexts automatically:
- Dark mode: white text on transparent background
- Light mode: black text via `prefers-color-scheme: light` media query
- Print/PDF: black text via `@media print`

**Step 5 -- Use the slug for routing**

The `slug` field in frontmatter is the canonical URL path for each post. Use it to generate dynamic routes in Next.js:

```js
// pages/blog/[slug].js or app/blog/[slug]/page.js
export async function generateStaticParams() {
  return posts.map(post => ({ slug: post.slug }));
}
```

## Known Intentional Exceptions

The following posts will show as flagged by the `verify-blogs.mjs` script but are correct as-is:

- 5 posts with `metaDescription` at 149 characters (1 char under the 150 target -- acceptable)
- 3 posts that are intentionally short because they serve as series intro posts leading into multi-part sequences:
  - `2021.02a-how-do-you-boost-user-engagement.md`
  - `2021.03a-framing-ux-problems-how-to-reframe-your-problems-to-find-the-right-solutions.md`
  - `2021.06a-3-very-human-reasons-software-projects-fail.md`

## Verification Script

To verify the health of the blog content at any time, run from the `scripts/` folder:

```bash
node verify-blogs.mjs
```

This will generate a `blog-verification-report.md` at the project root with a full breakdown of any issues found across all posts.

## Scripts Reference

All pipeline scripts live in `scripts/`:

| Script | Purpose |
|--------|---------|
| `redraft-blogs.mjs` | Pull source docs from Google Drive and redraft via Claude API |
| `redraft-thin-blogs.mjs` | Re-run body redraft for posts with missing content, preserving existing frontmatter and ASCII art |
| `fix-blogs.mjs` | Fix em dashes and metaDescription length across all posts |
| `fix-faqs-and-redraft.mjs` | Append FAQ sections to specific posts and redraft targeted thin posts |
| `update-ascii-patterns.mjs` | Generate or regenerate repeating ASCII art patterns for post headers |
| `add-missing-ascii-blocks.mjs` | Normalize the style and pre block structure across all files |
| `verify-blogs.mjs` | Audit all posts and generate a verification report |