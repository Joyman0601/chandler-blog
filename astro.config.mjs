// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import fs from 'node:fs';
import path from 'node:path';

// 从博客 frontmatter 收集 url -> 最近更新日期，供 sitemap 输出 lastmod
const BLOG_DIR = path.resolve('./src/content/blog');

function collectMarkdown(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectMarkdown(full));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function frontmatterDate(file) {
  const text = fs.readFileSync(file, 'utf-8');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const block = fm[1];
  const pick = (key) => {
    const m = block.match(new RegExp(`^${key}:\\s*([0-9]{4}-[0-9]{2}-[0-9]{2})`, 'm'));
    return m ? m[1] : null;
  };
  const date = pick('updatedDate') ?? pick('pubDate');
  return date ? new Date(`${date}T00:00:00Z`).toISOString() : null;
}

const lastmodMap = {};
for (const file of collectMarkdown(BLOG_DIR)) {
  const id = path
    .relative(BLOG_DIR, file)
    .replace(/\\/g, '/')
    .replace(/\.md$/, '');
  const date = frontmatterDate(file);
  if (date) lastmodMap[`/blog/${id}/`] = date;
}

// https://astro.build/config
export default defineConfig({
  site: 'https://chandlerblog.com',
  integrations: [
    sitemap({
      serialize(item) {
        const { pathname } = new URL(item.url);
        if (lastmodMap[pathname]) item.lastmod = lastmodMap[pathname];
        return item;
      },
    }),
  ],
});
