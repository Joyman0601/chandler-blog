import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    if (!["title", "description", "date", "pubDate", "updated", "category", "tags", "draft"].includes(key)) {
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
  if (data.pubDate !== undefined) validDate(data.pubDate, "pubDate", relative);
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

function existingPublicationDate(existing, relative, marker) {
  if (existing === undefined) return undefined;
  const header = existing.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
  const lines = header?.split("\n") ?? [];
  const digests = lines.filter((line) => line.startsWith(digestPrefix));
  const digestLine = digests[0];
  if (!existing.startsWith(`---\n${digestPrefix}`) || !lines.includes(marker) || digests.length !== 1
    || sha256(existing.replace(`${digestLine}\n`, "")) !== digestLine.slice(digestPrefix.length)) {
    throw new Error(`${relative}: refusing to overwrite an existing or manually edited article`);
  }
  const dates = lines.filter((line) => line.startsWith("pubDate:"));
  const date = dates.length === 1 ? dates[0].match(/^pubDate: (\d{4}-\d{2}-\d{2})$/)?.[1] : undefined;
  return validDate(date, "existing pubDate", relative);
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
  const rewriteInline = (line, tableRow) => {
    let position = 0;
    let result = "";
    const runs = /`+/g;
    for (let opening; (opening = runs.exec(line));) {
      const afterOpening = runs.lastIndex;
      let closing;
      while ((closing = runs.exec(line)) && closing[0].length !== opening[0].length) {}
      if (!closing) break;
      let code = line.slice(opening.index, runs.lastIndex);
      // GFM splits table cells at pipes even inside code spans. Escape only
      // these delimiters; the rendered code still reads exactly like the source.
      if (tableRow) code = code.replace(/(\\*)\|/g, (whole, slashes) => {
        if (slashes.length % 2) return whole;
        stats.tableCodePipes++;
        return `${slashes}\\|`;
      });
      result += rewriteProse(line.slice(position, opening.index)) + code;
      position = runs.lastIndex;
      if (position <= afterOpening) throw new Error("Invalid inline-code span");
    }
    return result + rewriteProse(line.slice(position));
  };
  let fence, table = false;
  const lines = body.split(/(?<=\n)/);
  const tableDivider = (line) => {
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
    return cells.length > 0 && cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));
  };
  return lines.map((line, index) => {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/);
    if (delimiter) {
      table = false;
      if (!fence) fence = delimiter[1];
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
      return line;
    }
    if (fence) return line;
    if (!line.trim() || !line.includes("|")) table = false;
    if (line.includes("|") && tableDivider(lines[index + 1] ?? "")) table = true;
    return rewriteInline(line, table);
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
  const published = new Set(articles.map((article) => article.absolute));
  const stats = { mode: check ? "check" : "write", articles: articles.length, drafts: drafts.length, links: 0, tableCodePipes: 0, created: 0, updated: 0, unchanged: 0, dates: {} };
  const plans = [];
  for (const article of articles) {
    const { data, relative } = article;
    const marker = `# Imported by scripts/import-articles.mjs from posts/${relative}`;
    const destination = path.join(outputRoot, relative);
    const existing = await readFile(destination, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    // Trust a saved publication date only after checking the complete imported copy.
    const previousPubDate = existingPublicationDate(existing, relative, marker);
    const pubDate = data.pubDate ?? previousPubDate ?? data.date;
    const metadata = [marker, `# Source date: ${data.date}`, `title: ${JSON.stringify(data.title)}`,
      `description: ${JSON.stringify(data.description)}`, `pubDate: ${pubDate}`];
    if (data.updated) metadata.push(`updatedDate: ${data.updated < pubDate ? pubDate : data.updated}`);
    metadata.push(`tags: ${JSON.stringify(data.tags)}`, `series: ${data.category}`, `seriesLabel: ${JSON.stringify(labels[data.category])}`);
    const body = rewriteLinks(article.body, article, sourceRoot, published, stats);
    const unsigned = `---\n${metadata.join("\n")}\n---\n${body}`;
    const output = unsigned.replace("---\n", `---\n${digestPrefix}${sha256(unsigned)}\n`);
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
