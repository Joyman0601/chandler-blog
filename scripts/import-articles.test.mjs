import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const importer = process.env.IMPORT_ARTICLES_SCRIPT ?? fileURLToPath(new URL("./import-articles.mjs", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "blog-import-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, "blog/scripts/import-articles.mjs");
  const source = path.join(root, "md");
  const output = path.join(root, "blog/src/content/blog/testing");
  await mkdir(path.dirname(script), { recursive: true });
  await mkdir(path.join(source, "posts/testing"), { recursive: true });
  await copyFile(importer, script);
  return {
    source,
    output,
    async article(slug, fields = {}, body = "正文\n") {
      const data = { title: "测试文章", description: "导入日期测试", date: "2026-10-01", category: "testing", tags: ["测试"], draft: false, ...fields };
      const metadata = Object.entries(data).map(([key, value]) => `${key}: ${typeof value === "string" && !["date", "pubDate", "updated", "category"].includes(key) ? JSON.stringify(value) : Array.isArray(value) ? JSON.stringify(value) : value}`);
      await writeFile(path.join(source, `posts/testing/${slug}.md`), `---\n${metadata.join("\n")}\n---\n${body}`);
    },
    async read(slug) {
      return readFile(path.join(output, `${slug}.md`), "utf8");
    },
    async saved(slug, pubDate = "2026-08-17", extraHeader = "") {
      const unsigned = `---\n# Imported by scripts/import-articles.mjs from posts/testing/${slug}.md\n# Source date: 2026-10-01\ntitle: "测试文章"\ndescription: "导入日期测试"\npubDate: ${pubDate}\n${extraHeader}tags: ["测试"]\nseries: testing\nseriesLabel: "测试与验收"\n---\n正文\n`;
      const digest = createHash("sha256").update(unsigned).digest("hex");
      const content = unsigned.replace("---\n", `---\n# import-articles-sha256: ${digest}\n`);
      await mkdir(output, { recursive: true });
      await writeFile(path.join(output, `${slug}.md`), content);
      return content;
    },
    run(...args) {
      return spawnSync(process.execPath, [script, source, ...args], { encoding: "utf8" });
    },
  };
}

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function failure(result, message) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, message);
}

test("new articles use explicit publication dates or their source dates, including the same day", async (t) => {
  const f = await fixture(t);
  await f.article("explicit", { pubDate: "2026-11-04", updated: "2026-10-02" });
  await f.article("fallback", { date: "2026-11-04" });
  const stats = success(f.run());
  assert.equal(stats.dates["2026-11-04"], 2);
  assert.match(await f.read("explicit"), /^pubDate: 2026-11-04$/m);
  assert.match(await f.read("explicit"), /^# Source date: 2026-10-01$/m);
  assert.match(await f.read("explicit"), /^updatedDate: 2026-11-04$/m);
  assert.match(await f.read("fallback"), /^pubDate: 2026-11-04$/m);
});

test("a legacy imported article retains its publication date and bytes on repeated imports", async (t) => {
  const f = await fixture(t);
  await f.article("legacy");
  const original = await f.saved("legacy");
  const stats = success(f.run());
  assert.equal(await f.read("legacy"), original);
  assert.equal(stats.unchanged, 1);
  assert.equal(stats.updated, 0);
  assert.equal(success(f.run("--check")).unchanged, 1);
});

test("adding or backfilling articles never redistributes a saved article's publication date", async (t) => {
  const f = await fixture(t);
  await f.article("legacy");
  const original = await f.saved("legacy");
  await f.article("backfill", { date: "2026-09-01" });
  await f.article("new", { date: "2026-11-04" });
  const stats = success(f.run());
  assert.equal(await f.read("legacy"), original);
  assert.equal(stats.created, 2);
  assert.equal(stats.unchanged, 1);
  assert.match(await f.read("backfill"), /^pubDate: 2026-09-01$/m);
  assert.match(await f.read("new"), /^pubDate: 2026-11-04$/m);
});

test("source corrections update content while keeping the existing publication date", async (t) => {
  const f = await fixture(t);
  await f.article("legacy", { date: "2026-10-02", updated: "2026-11-05" }, "修正后的正文\n");
  await f.saved("legacy");
  assert.equal(success(f.run()).updated, 1);
  const content = await f.read("legacy");
  assert.match(content, /^pubDate: 2026-08-17$/m);
  assert.match(content, /^updatedDate: 2026-11-05$/m);
  assert.match(content, /^# Source date: 2026-10-02$/m);
  assert.match(content, /修正后的正文/);
  assert.equal(success(f.run()).unchanged, 1);
});

test("an explicit source publication date can intentionally replace a saved date", async (t) => {
  const f = await fixture(t);
  await f.article("legacy", { pubDate: "2026-11-04" });
  await f.saved("legacy");
  assert.equal(success(f.run()).updated, 1);
  assert.match(await f.read("legacy"), /^pubDate: 2026-11-04$/m);
  assert.equal(success(f.run("--check")).unchanged, 1);
});

test("invalid source publication dates fail before changing or creating any article", async (t) => {
  for (const pubDate of ["2026-02-30", "2026-13-01", "", true, "2026-11-04T00:00:00Z"]) {
    await t.test(JSON.stringify(pubDate), async (t) => {
      const f = await fixture(t);
      await f.article("legacy", {}, "待更新正文\n");
      const original = await f.saved("legacy");
      await f.article("a-new");
      await f.article("z-invalid", { pubDate });
      failure(f.run(), /pubDate must be a valid YYYY-MM-DD date/);
      assert.equal(await f.read("legacy"), original);
      await assert.rejects(f.read("a-new"), { code: "ENOENT" });
    });
  }
});

test("manual edits are rejected even when the source explicitly replaces the publication date", async (t) => {
  const f = await fixture(t);
  await f.article("legacy", { pubDate: "2026-11-04" });
  const edited = `${await f.saved("legacy")}手动改稿\n`;
  await writeFile(path.join(f.output, "legacy.md"), edited);
  await f.article("a-new");
  failure(f.run(), /refusing to overwrite an existing or manually edited article/);
  assert.equal(await f.read("legacy"), edited);
  await assert.rejects(f.read("a-new"), { code: "ENOENT" });
});

test("a valid digest alone cannot authorize adopting an article from a different source", async (t) => {
  const f = await fixture(t);
  await f.article("target");
  const other = await f.saved("other");
  await writeFile(path.join(f.output, "target.md"), other);
  failure(f.run(), /refusing to overwrite an existing or manually edited article/);
  assert.equal(await f.read("target"), other);
});

test("invalid or duplicate saved publication dates fail despite a valid digest", async (t) => {
  for (const [date, extra] of [["2026-02-30", ""], ["2026-08-17", "pubDate: 2026-08-18\n"]]) {
    await t.test(`${date} ${extra}`, async (t) => {
      const f = await fixture(t);
      await f.article("legacy");
      const original = await f.saved("legacy", date, extra);
      failure(f.run(), /existing pubDate must be a valid YYYY-MM-DD date/);
      assert.equal(await f.read("legacy"), original);
    });
  }
});

test("check mode reports pending imports without writing", async (t) => {
  const f = await fixture(t);
  await f.article("legacy", {}, "待更新正文\n");
  const original = await f.saved("legacy");
  await f.article("new", { pubDate: "2026-11-04" });
  failure(f.run("--check"), /Import is out of date: 1 missing, 1 changed/);
  assert.equal(await f.read("legacy"), original);
  await assert.rejects(f.read("new"), { code: "ENOENT" });
});

test("article count and same-day imports have no legacy scheduling-window limit", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 100; index++) await f.article(`article-${index}`, { date: "2026-11-04" });
  const stats = success(f.run());
  assert.equal(stats.created, 100);
  assert.equal(stats.dates["2026-11-04"], 100);
  assert.equal(success(f.run("--check")).unchanged, 100);
});

test("draft-copy and missing-link guards still prevent partial imports", async (t) => {
  const f = await fixture(t);
  await f.article("draft", { draft: true });
  const original = await f.saved("draft");
  await f.article("new");
  failure(f.run(), /a draft has an existing blog copy/);
  assert.equal(await f.read("draft"), original);
  await assert.rejects(f.read("new"), { code: "ENOENT" });
  await rm(path.join(f.output, "draft.md"));
  await f.article("new", {}, "[未发布文章](draft.md)\n");
  failure(f.run(), /link target is missing, unpublished, or outside posts/);
  await assert.rejects(f.read("new"), { code: "ENOENT" });
});

test("article links retain queries and anchors while code remains literal", async (t) => {
  const f = await fixture(t);
  await f.article("target");
  await f.article("links", {}, "[文章](target.md?from=test#section)\n`[代码](missing.md)`\n\n```md\n[代码](missing.md)\n```\n");
  success(f.run());
  const content = await f.read("links");
  assert.match(content, /\[文章\]\(\/blog\/testing\/target\/\?from=test#section\)/);
  assert.match(content, /`\[代码\]\(missing\.md\)`/);
  assert.match(content, /```md\n\[代码\]\(missing\.md\)\n```/);
});
