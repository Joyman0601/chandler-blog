import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keep this publication window fixed: importing again must not move existing dates.
const publicationWindow = { from: "2026-08-01", through: "2026-11-03", seed: 20261103 };
const labels = {
  "model-onboarding": "模型接入",
  "billing-regression": "计费与上线回归",
  testing: "测试与验收",
  "git-collab": "Git 与协作",
  tooling: "开发环境与工具",
  "ai-workflow": "AI 辅助开发",
  frontend: "前端实践",
  methods: "工作方法",
  journal: "工作周记",
};
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const outputRoot = path.join(repoRoot, "src/content/blog");
const digestPrefix = "# import-articles-sha256: ";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".md") ? [absolute] : [];
  }));
  return nested.flat().sort();
}

function validDate(value, field, relative) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error(`${relative}: ${field} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

// The source library uses single-line JSON strings/arrays and plain date/bool fields.
// Reject other YAML forms instead of silently importing malformed metadata.
function parseArticle(raw, relative) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match) throw new Error(`${relative}: missing frontmatter`);
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const entry = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*?)\s*$/);
    if (!entry || Object.hasOwn(data, entry[1])) throw new Error(`${relative}: invalid or duplicate metadata: ${line}`);
    const [, key, value] = entry;
    if (!["title", "description", "date", "updated", "category", "tags", "draft"].includes(key)) {
      throw new Error(`${relative}: unsupported metadata field ${key}`);
    }
    if (value.startsWith('"') || value.startsWith("[")) data[key] = JSON.parse(value);
    else if (value === "true" || value === "false") data[key] = value === "true";
    else data[key] = value;
  }
  for (const key of ["title", "description", "category"]) {
    if (typeof data[key] !== "string" || !data[key]) throw new Error(`${relative}: missing ${key}`);
  }
  validDate(data.date, "date", relative);
  if (data.updated !== undefined) validDate(data.updated, "updated", relative);
  if (!Array.isArray(data.tags) || data.tags.some((tag) => typeof tag !== "string")) {
    throw new Error(`${relative}: tags must be a JSON array of strings`);
  }
  if (typeof data.draft !== "boolean") throw new Error(`${relative}: draft must be true or false`);
  if (!Object.hasOwn(labels, data.category) || relative.split("/")[0] !== data.category) {
    throw new Error(`${relative}: unknown or mismatched category ${data.category}`);
  }
  return { data, body: raw.slice(match[0].length) };
}

function publicationDates(count) {
  const day = 86400000;
  const start = Date.parse(publicationWindow.from);
  const available = (Date.parse(publicationWindow.through) - start) / day;
  if (count > available) throw new Error(`The fixed publication window has ${available} days for ${count} articles`);
  const days = Array.from({ length: available }, (_, index) => index + 1);
  let state = publicationWindow.seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let index = days.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [days[index], days[other]] = [days[other], days[index]];
  }
  return days.slice(0, count).sort((a, b) => a - b)
    .map((offset) => new Date(start + offset * day).toISOString().slice(0, 10));
}

function rewriteLinks(body, article, sourceRoot, published, stats) {
  const rewriteProse = (text) => text.replace(/(\]\(\s*)(<[^>\n]*>|[^\s)]+)(?=[\s)])/g, (whole, prefix, wrapped) => {
    const angled = wrapped.startsWith("<");
    const url = angled ? wrapped.slice(1, -1) : wrapped;
    if (/^(?:[a-zA-Z][a-zA-Z\d+.-]*:|\/|#)/.test(url)) return whole;
    const [, pathname, suffix = ""] = url.match(/^([^?#]*)([?#][\s\S]*)?$/);
    if (!pathname.endsWith(".md")) return whole;
    const target = path.resolve(path.dirname(article.absolute), decodeURIComponent(pathname));
    const targetRelative = path.relative(sourceRoot, target).split(path.sep).join("/");
    if (!published.has(target)) throw new Error(`${article.relative}: link target is missing, unpublished, or outside posts/: ${url}`);
    const destination = `/blog/${targetRelative.slice(0, -3)}/${suffix}`;
    stats.links++;
    return prefix + (angled ? `<${destination}>` : destination);
  });
  const rewriteInline = (line) => {
    let position = 0;
    let result = "";
    const runs = /`+/g;
    for (let opening; (opening = runs.exec(line));) {
      const afterOpening = runs.lastIndex;
      let closing;
      while ((closing = runs.exec(line)) && closing[0].length !== opening[0].length) {}
      if (!closing) break;
      result += rewriteProse(line.slice(position, opening.index)) + line.slice(opening.index, runs.lastIndex);
      position = runs.lastIndex;
      if (position <= afterOpening) throw new Error("Invalid inline-code span");
    }
    return result + rewriteProse(line.slice(position));
  };
  let fence;
  return body.split(/(?<=\n)/).map((line) => {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
      return line;
    }
    return fence ? line : rewriteInline(line);
  }).join("");
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const sourceArgument = args.filter((arg) => arg !== "--check");
  if (sourceArgument.length !== 1 || sourceArgument[0].startsWith("--")) {
    throw new Error("Usage: node scripts/import-articles.mjs <md-library-directory> [--check]");
  }
  const sourceRoot = path.resolve(sourceArgument[0], "posts");
  const articles = [];
  const drafts = [];
  for (const absolute of await markdownFiles(sourceRoot)) {
    const relative = path.relative(sourceRoot, absolute).split(path.sep).join("/");
    const parsed = parseArticle(await readFile(absolute, "utf8"), relative);
    const article = { absolute, relative, ...parsed };
    (parsed.data.draft ? drafts : articles).push(article);
  }
  articles.sort((a, b) => a.data.date.localeCompare(b.data.date) || a.relative.localeCompare(b.relative, "en"));
  const dates = publicationDates(articles.length);
  const published = new Set(articles.map((article) => article.absolute));
  const stats = { mode: check ? "check" : "write", articles: articles.length, drafts: drafts.length, links: 0, created: 0, updated: 0, unchanged: 0, schedule: publicationWindow, dates: {} };
  const plans = [];
  for (const [index, article] of articles.entries()) {
    const { data, relative } = article;
    const pubDate = dates[index];
    const marker = `# Imported by scripts/import-articles.mjs from posts/${relative}`;
    const metadata = [marker, `# Source date: ${data.date}`, `title: ${JSON.stringify(data.title)}`,
      `description: ${JSON.stringify(data.description)}`, `pubDate: ${pubDate}`];
    if (data.updated) metadata.push(`updatedDate: ${data.updated < pubDate ? pubDate : data.updated}`);
    metadata.push(`tags: ${JSON.stringify(data.tags)}`, `series: ${data.category}`, `seriesLabel: ${JSON.stringify(labels[data.category])}`);
    const body = rewriteLinks(article.body, article, sourceRoot, published, stats);
    const unsigned = `---\n${metadata.join("\n")}\n---\n${body}`;
    const output = unsigned.replace("---\n", `---\n${digestPrefix}${sha256(unsigned)}\n`);
    const destination = path.join(outputRoot, relative);
    const existing = await readFile(destination, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (existing !== undefined && existing !== output) {
      const digestLine = existing.split("\n").find((line) => line.startsWith(digestPrefix));
      if (!existing.startsWith(`---\n${digestPrefix}`) || !existing.split("\n").includes(marker) || !digestLine
        || sha256(existing.replace(`${digestLine}\n`, "")) !== digestLine.slice(digestPrefix.length)) {
        throw new Error(`${relative}: refusing to overwrite an existing or manually edited article`);
      }
    }
    stats.dates[pubDate] = (stats.dates[pubDate] ?? 0) + 1;
    if (existing === output) stats.unchanged++;
    else if (existing === undefined) stats.created++;
    else stats.updated++;
    plans.push({ destination, output, existing });
  }
  for (const article of drafts) {
    try {
      await readFile(path.join(outputRoot, article.relative));
      throw new Error(`${article.relative}: a draft has an existing blog copy; remove it explicitly before importing`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (check && (stats.created || stats.updated)) throw new Error(`Import is out of date: ${stats.created} missing, ${stats.updated} changed`);
  if (!check) {
    for (const { destination, output, existing } of plans) {
      if (existing === output) continue;
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, output, "utf8");
    }
  }
  console.log(JSON.stringify(stats, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
