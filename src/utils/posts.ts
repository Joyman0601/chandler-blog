import type { CollectionEntry } from "astro:content";

export type BlogPost = CollectionEntry<"blog">;

export function sortByDateDesc(posts: BlogPost[]): BlogPost[] {
  return [...posts].sort(
    (a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf(),
  );
}

// 同系列文章按 id 升序（系列文件名带 00/01… 前缀，正好是阅读顺序）
export function seriesPostsSorted(posts: BlogPost[], series: string): BlogPost[] {
  return posts
    .filter((p) => p.data.series === series)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface ReadStats {
  minutes: number;
  words: number;
}

// 中英文混排阅读时长：CJK 按字、其余按词，约 320 字/分钟
export function readStats(markdown: string): ReadStats {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ") // 去掉代码块
    .replace(/`[^`]*`/g, " ")
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, " ") // 去掉图片/链接语法
    .replace(/[#>*_~|-]/g, " ");
  const cjk = (text.match(/[一-龥぀-ヿ]/g) || []).length;
  const latin = (text.match(/[A-Za-z0-9]+/g) || []).length;
  const words = cjk + latin;
  const minutes = Math.max(1, Math.round(words / 320));
  return { minutes, words };
}

export interface TocEntry {
  depth: number;
  slug: string;
  text: string;
}

// 仅保留 h2/h3 作为目录
export function buildToc(
  headings: { depth: number; slug: string; text: string }[],
): TocEntry[] {
  return headings.filter((h) => h.depth === 2 || h.depth === 3);
}
