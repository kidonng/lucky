# Telegram Channel "I'm Feeling Lucky" (`lucky`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript (`mise` + `bun` + `bun:test` + `unified`) CLI and static web application that scrapes public Telegram channel posts into `data/<channel>.jsonl` (initial full mirror and incremental updates) and compiles them into a static site (`dist/`) supporting random post and random in-post link redirection.

**Architecture:** Two-stage pipeline powered by `bun` and the `unified` AST ecosystem. Stage 1 (`scrape`) fetches `https://t.me/s/<channel>` pages, selects post DOM nodes via `rehype-parse` + `hast-util-select`, converts `.tgme_widget_message_text` HTML to Markdown via `rehype-remark` + `remark-gfm` + `remark-stringify`, and writes sorted JSONL records (`id`, `date`, `text`) to `data/<channel>.jsonl`. Stage 2 (`build`) parses each post's Markdown via `remark-parse` + `remark-gfm`, visits mdast `link` nodes to collect/filter/deduplicate external URLs, emits compact JSON indexes (`dist/data/<channel>.json`, `dist/data/channels.json`), and generates a zero-dependency static HTML frontend (`dist/index.html`) with baked-in default `channel` and `mode`.

**Tech Stack:** `mise`, `bun`, `bun:test`, `unified`, `rehype-parse`, `rehype-remark`, `remark-parse`, `remark-gfm`, `remark-stringify`, `unist-util-visit`, `hast-util-select`, `hast-util-to-text`.

**Spec:** `.superpowers/specs/2026-11-18-telegram-channel-lucky-design.md`

## Global Constraints

- Managed with `mise` (`mise.toml` pinning `bun`), executed with `bun`, tested with `bun:test`.
- HTML and Markdown processing MUST use the `unified` ecosystem (`rehype` / `remark` / `hast` / `mdast`).
- Source JSONL records in `data/<channel>.jsonl` MUST contain exact keys `id` (`number`), `date` (`string`), `text` (`string`), sorted ascending by `id` with no duplicates and no `links` key.
- `--full` scrape mode performs mirror replacement (overwrites `data/<channel>.jsonl` with current channel snapshot); default scrape mode performs incremental update (`?after=<maxId>`) when `data/<channel>.jsonl` already exists and is non-empty.
- When instructed to use `docs/superpowers`, use `.superpowers` instead.
- Commit messages MUST follow Linux Kernel commit style (`scope: Short imperative summary` + `### Problem` / `### Solution` / `### References`).

## Review Focus

1. **Telegram pagination overlap / boundary posts**: `t.me/s/<channel>?before=<id>` or `?after=<id>` can return empty pages, service messages without `<time datetime>`, or duplicate boundary messages; scraper must terminate cleanly without infinite loops and deduplicate by `id`.
2. **HTML formatting & special anchors in Telegram posts**: `<br>` tags inside `.tgme_widget_message_text`, hashtag search links (`?q=%23tag`), protocol-relative links (`//example.com`), and URLs containing parentheses (`https://en.wikipedia.org/wiki/Rust_(programming_language)`) must survive HTML → Markdown → mdast URL extraction without truncation or corruption.
3. **Truncated visible URL text in Telegram anchors**: Telegram shortens long plain URLs in anchor text (`<a href="https://example.com/very/long/path">https://example.com/very/lo…</a>`); conversion and extraction must preserve the full `href` target rather than the truncated label.
4. **Channel self-link filtering**: Links pointing to the channel itself (`https://t.me/<channel>`, `https://t.me/<channel>/123`, `https://t.me/s/<channel>?before=10`, case-insensitive, including `telegram.me`) must be excluded from `links`, while links to *other* Telegram channels (`https://t.me/other_channel/45`) and external sites are kept.
5. **Empty link pool or missing default channel on frontend**: When `mode=link` is requested on a channel with 0 extracted links, or when no channel is specified and multiple channels exist, the frontend must not crash or loop-redirect; it must render an actionable fallback state.

---

### Task 1: Project Scaffolding & HTML-to-Markdown Post Parser

**Files:**
- Create: `mise.toml`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/types.ts`
- Create: `src/parser.ts`
- Test: `tests/parser.test.ts`

**Interfaces:**
- Produces:
  - `src/types.ts`:
    - `export type LuckyMode = "post" | "link";`
    - `export interface ChannelPost { id: number; date: string; text: string; }`
    - `export interface ChannelIndex { channel: string; postCount: number; linkCount: number; posts: number[]; links: string[]; }`
    - `export interface ChannelSummary { channel: string; postCount: number; linkCount: number; }`
    - `export interface LuckyConfig { channels?: string[]; defaultChannel?: string; defaultMode?: LuckyMode; }`
  - `src/parser.ts`:
    - `export function normalizeChannelName(input: string): string`
    - `export function messageHtmlToMarkdown(htmlFragment: string): string`
    - `export function parseChannelPageHtml(pageHtml: string, channel: string): ChannelPost[]`

- [ ] **Step 1: Initialize `mise.toml`, `package.json`, `tsconfig.json`, `.gitignore`, and install `unified` dependencies**

Create `mise.toml` pinning `bun = "latest"`, `package.json` with scripts (`"scrape": "bun run src/cli.ts scrape"`, `"build": "bun run src/cli.ts build"`, `"test": "bun test"`), and install dependencies via `mise exec bun -- bun add unified rehype-parse rehype-remark remark-parse remark-gfm remark-stringify unist-util-visit hast-util-select hast-util-to-text hast-util-to-html` and `@types/bun` as devDependency.

- [ ] **Step 2: Write the failing tests in `tests/parser.test.ts`**

```typescript
import { describe, expect, test } from "bun:test";
import {
  messageHtmlToMarkdown,
  normalizeChannelName,
  parseChannelPageHtml,
} from "../src/parser";

describe("normalizeChannelName", () => {
  test("strips @ and t.me URLs", () => {
    expect(normalizeChannelName("@my_channel")).toBe("my_channel");
    expect(normalizeChannelName("https://t.me/s/my_channel?before=10")).toBe("my_channel");
    expect(normalizeChannelName("https://t.me/my_channel/42")).toBe("my_channel");
  });
});

describe("messageHtmlToMarkdown", () => {
  test("converts br, formatting, hashtags, protocol-relative URLs, and parenthesized URLs", () => {
    const html = [
      `<b>Hello</b> <i>world</i>!<br/>`,
      `Check <a href="https://en.wikipedia.org/wiki/Rust_(programming_language)">Rust Wiki</a> `,
      `and <a href="https://example.com/very/long/path/to/article">https://example.com/very/long/…</a> `,
      `and <a href="//cdn.example.com/file.pdf">PDF</a> `,
      `<a href="?q=%23golang">#golang</a>`,
    ].join("");

    const md = messageHtmlToMarkdown(html);
    expect(md).toContain("**Hello** *world*!");
    expect(md).toContain("https://en.wikipedia.org/wiki/Rust_(programming_language)");
    expect(md).toContain("https://example.com/very/long/path/to/article");
    expect(md).not.toContain("https://example.com/very/long/…");
    expect(md).toContain("[PDF](https://cdn.example.com/file.pdf)");
    expect(md).toContain("#golang");
    expect(md).not.toContain("?q=%23golang");
  });
});

describe("parseChannelPageHtml", () => {
  test("extracts text posts, media-only posts, and skips service messages without id/date", () => {
    const samplePage = `
      <div class="tgme_widget_message_wrap">
        <div class="tgme_widget_message service_message" data-post="demo/1">
          <div class="tgme_widget_message_service_body">Channel created</div>
        </div>
      </div>
      <div class="tgme_widget_message_wrap">
        <div class="tgme_widget_message" data-post="demo/2">
          <div class="tgme_widget_message_bubble">
            <div class="tgme_widget_message_text js-message_text">First post with <a href="https://example.org">link</a></div>
            <div class="tgme_widget_message_footer">
              <a class="tgme_widget_message_date" href="https://t.me/demo/2">
                <time datetime="2024-05-01T10:00:00+00:00">May 1</time>
              </a>
            </div>
          </div>
        </div>
      </div>
      <div class="tgme_widget_message_wrap">
        <div class="tgme_widget_message" data-post="demo/3">
          <div class="tgme_widget_message_bubble">
            <div class="tgme_widget_message_photo_wrap"></div>
            <div class="tgme_widget_message_footer">
              <a class="tgme_widget_message_date" href="https://t.me/demo/3">
                <time datetime="2024-05-02T12:00:00+00:00">May 2</time>
              </a>
            </div>
          </div>
        </div>
      </div>
    `;

    const posts = parseChannelPageHtml(samplePage, "demo");
    expect(posts).toEqual([
      {
        id: 2,
        date: "2024-05-01T10:00:00+00:00",
        text: "First post with [link](https://example.org)",
      },
      {
        id: 3,
        date: "2024-05-02T12:00:00+00:00",
        text: "",
      },
    ]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `mise exec bun -- bun test tests/parser.test.ts`
Expected: FAIL with module not found `../src/parser`.

- [ ] **Step 4: Implement `src/types.ts` and `src/parser.ts`**

In `src/parser.ts`:
- `normalizeChannelName(input)` extracts the channel handle from `@handle`, `https://t.me/s/handle...`, `https://t.me/handle...`, or plain `handle`.
- `messageHtmlToMarkdown(htmlFragment)` parses with `unified().use(rehypeParse, { fragment: true })`, transforms the hast AST before `rehypeRemark`:
  - Unwraps `<a href="?q=%23...">` or empty/javascript hrefs into plain text children.
  - Normalizes `href` starting with `//` to `https://...`.
  - When an `<a>`'s visible text (trimmed, with trailing `…` or `...` stripped) is a prefix of `href` or equal to `href`, replaces the anchor's text child with the full `href` so GFM autolink/stringify preserves the full untruncated URL.
  - Pipes through `rehypeRemark`, `remarkGfm`, and `remarkStringify` and trims trailing whitespace.
- `parseChannelPageHtml(pageHtml, channel)` parses the document with `rehypeParse`, uses `selectAll(".tgme_widget_message[data-post]", tree)`, checks `data-post` matches `<channel>/<id>` (case-insensitive channel match), extracts `<time datetime="...">` via `select("time[datetime]", msgNode)` (skipping service widgets without a `<time datetime>`), selects `.tgme_widget_message_text.js-message_text` (or `.tgme_widget_message_text` inside the message bubble, excluding `.tgme_widget_message_reply` quoted blocks), converts its inner HTML via `messageHtmlToMarkdown`, and returns `ChannelPost[]` sorted ascending by `id`.

- [ ] **Step 5: Run test to verify it passes**

Run: `mise exec bun -- bun test tests/parser.test.ts`
Expected: PASS (3 tests passing).

- [ ] **Step 6: Commit**

Commit via eval `commit` namespace with Linux Kernel style message (`parser: Add Telegram HTML post parser and Markdown converter`).

---

### Task 2: JSONL Storage & Incremental / Full Mirror Scraper

**Files:**
- Create: `src/storage.ts`
- Create: `src/scrape.ts`
- Test: `tests/scrape.test.ts`

**Interfaces:**
- Consumes:
  - `ChannelPost` from `src/types.ts`
  - `normalizeChannelName`, `parseChannelPageHtml` from `src/parser.ts`
- Produces:
  - `src/storage.ts`:
    - `export async function readChannelPosts(jsonlPath: string): Promise<ChannelPost[]>`
    - `export async function writeChannelPosts(jsonlPath: string, posts: ChannelPost[]): Promise<void>`
    - `export function serializePostJsonlLine(post: ChannelPost): string`
  - `src/scrape.ts`:
    - `export interface ScrapeOptions { channel: string; dataDir?: string; full?: boolean; delayMs?: number; fetcher?: (url: string) => Promise<string>; }`
    - `export interface ScrapeResult { channel: string; mode: "full" | "incremental"; fetchedPages: number; addedOrUpdatedCount: number; totalCount: number; filePath: string; }`
    - `export async function scrapeChannel(options: ScrapeOptions): Promise<ScrapeResult>`

- [ ] **Step 1: Write the failing tests in `tests/scrape.test.ts`**

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrapeChannel } from "../src/scrape";
import { readChannelPosts, writeChannelPosts } from "../src/storage";

function makePageHtml(channel: string, items: Array<{ id: number; date: string; html: string }>): string {
  return items
    .map(
      (item) => `
      <div class="tgme_widget_message" data-post="${channel}/${item.id}">
        <div class="tgme_widget_message_text js-message_text">${item.html}</div>
        <div class="tgme_widget_message_footer">
          <a class="tgme_widget_message_date" href="https://t.me/${channel}/${item.id}">
            <time datetime="${item.date}">Date</time>
          </a>
        </div>
      </div>`
    )
    .join("\n");
}

describe("scrapeChannel", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "lucky-scrape-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("initial full scrape paginates backward with ?before= until exhausted and writes sorted JSONL", async () => {
    const pages: Record<string, string> = {
      "https://t.me/s/testchan": makePageHtml("testchan", [
        { id: 3, date: "2024-01-03T00:00:00+00:00", html: "Post 3" },
        { id: 4, date: "2024-01-04T00:00:00+00:00", html: "Post 4" },
      ]),
      "https://t.me/s/testchan?before=3": makePageHtml("testchan", [
        { id: 1, date: "2024-01-01T00:00:00+00:00", html: "Post 1" },
        { id: 2, date: "2024-01-02T00:00:00+00:00", html: "Post 2" },
      ]),
      "https://t.me/s/testchan?before=1": "",
    };

    const res = await scrapeChannel({
      channel: "testchan",
      dataDir: tempDir,
      delayMs: 0,
      fetcher: async (url) => pages[url] ?? "",
    });

    expect(res.mode).toBe("full");
    expect(res.totalCount).toBe(4);

    const raw = await readFile(res.filePath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('{"id":1,"date":"2024-01-01T00:00:00+00:00","text":"Post 1"}');

    const posts = await readChannelPosts(res.filePath);
    expect(posts.map((p) => p.id)).toEqual([1, 2, 3, 4]);
  });

  test("incremental scrape paginates forward with ?after=<maxId> when JSONL exists", async () => {
    const filePath = join(tempDir, "testchan.jsonl");
    await writeChannelPosts(filePath, [
      { id: 1, date: "2024-01-01T00:00:00+00:00", text: "Post 1" },
      { id: 2, date: "2024-01-02T00:00:00+00:00", text: "Post 2" },
    ]);

    const pages: Record<string, string> = {
      "https://t.me/s/testchan?after=2": makePageHtml("testchan", [
        { id: 3, date: "2024-01-03T00:00:00+00:00", html: "Post 3" },
        { id: 4, date: "2024-01-04T00:00:00+00:00", html: "Post 4" },
      ]),
      "https://t.me/s/testchan?after=4": "",
    };

    const res = await scrapeChannel({
      channel: "testchan",
      dataDir: tempDir,
      delayMs: 0,
      fetcher: async (url) => pages[url] ?? "",
    });

    expect(res.mode).toBe("incremental");
    expect(res.addedOrUpdatedCount).toBe(2);
    expect(res.totalCount).toBe(4);

    const posts = await readChannelPosts(filePath);
    expect(posts.map((p) => p.id)).toEqual([1, 2, 3, 4]);
  });

  test("full mode (--full) performs mirror replacement, removing deleted posts and updating edited text", async () => {
    const filePath = join(tempDir, "testchan.jsonl");
    await writeChannelPosts(filePath, [
      { id: 1, date: "2024-01-01T00:00:00+00:00", text: "Old Post 1" },
      { id: 2, date: "2024-01-02T00:00:00+00:00", text: "Deleted Post 2" },
    ]);

    const pages: Record<string, string> = {
      "https://t.me/s/testchan": makePageHtml("testchan", [
        { id: 1, date: "2024-01-01T00:00:00+00:00", html: "Edited Post 1" },
        { id: 3, date: "2024-01-03T00:00:00+00:00", html: "New Post 3" },
      ]),
      "https://t.me/s/testchan?before=1": "",
    };

    const res = await scrapeChannel({
      channel: "testchan",
      dataDir: tempDir,
      full: true,
      delayMs: 0,
      fetcher: async (url) => pages[url] ?? "",
    });

    expect(res.mode).toBe("full");
    const posts = await readChannelPosts(filePath);
    expect(posts).toEqual([
      { id: 1, date: "2024-01-01T00:00:00+00:00", text: "Edited Post 1" },
      { id: 3, date: "2024-01-03T00:00:00+00:00", text: "New Post 3" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `mise exec bun -- bun test tests/scrape.test.ts`
Expected: FAIL with module not found `../src/scrape`.

- [ ] **Step 3: Implement `src/storage.ts` and `src/scrape.ts`**

In `src/storage.ts`:
- `serializePostJsonlLine(post)` outputs `JSON.stringify({ id: post.id, date: post.date, text: post.text })`.
- `readChannelPosts(jsonlPath)` returns `[]` if file does not exist, otherwise parses non-empty lines, deduplicates by `id` (last wins), and sorts ascending by `id`.
- `writeChannelPosts(jsonlPath, posts)` ensures parent directory exists, deduplicates by `id`, sorts ascending by `id`, and writes lines joined by `\n` with a trailing `\n`.

In `src/scrape.ts`:
- Default `fetcher` performs `fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; LuckyBot/1.0)" } })` with up to 3 retries on network / 429 / 5xx errors.
- Determines mode: if `options.full` is true or existing posts in `<dataDir>/<channel>.jsonl` is empty, runs `"full"` mode; otherwise runs `"incremental"` mode.
- In `"full"` mode: starts at `https://t.me/s/${channel}`, collects posts, tracks `minId`, loops `https://t.me/s/${channel}?before=${minId}` while `minId > 1` and new posts with `id < minId` are returned. Overwrites `<dataDir>/<channel>.jsonl` with collected posts.
- In `"incremental"` mode: finds `maxId` from existing posts, loops `https://t.me/s/${channel}?after=${maxId}` while new posts with `id > maxId` are returned, updates `maxId`, merges with existing posts, and writes `<dataDir>/<channel>.jsonl`.

- [ ] **Step 4: Run test to verify it passes**

Run: `mise exec bun -- bun test tests/scrape.test.ts`
Expected: PASS (3 tests passing).

- [ ] **Step 5: Commit**

Commit via eval `commit` namespace with Linux Kernel style message (`scrape: Add JSONL storage and full/incremental Telegram scraper`).

---

### Task 3: Build-Time `unified` Link Extractor & Static Site Builder

**Files:**
- Create: `src/links.ts`
- Create: `src/web.ts`
- Create: `src/build.ts`
- Test: `tests/links.test.ts`
- Test: `tests/build.test.ts`

**Interfaces:**
- Consumes:
  - `ChannelPost`, `ChannelIndex`, `ChannelSummary`, `LuckyConfig`, `LuckyMode` from `src/types.ts`
  - `readChannelPosts` from `src/storage.ts`
- Produces:
  - `src/links.ts`:
    - `export function extractLinksFromMarkdown(markdown: string, channel: string): string[]`
    - `export function extractChannelLinks(posts: ChannelPost[], channel: string): string[]`
  - `src/web.ts`:
    - `export function renderIndexHtml(config: { defaultChannel: string | null; defaultMode: LuckyMode; channels: ChannelSummary[] }): string`
  - `src/build.ts`:
    - `export interface BuildOptions { dataDir?: string; outDir?: string; configPath?: string; defaultChannel?: string; defaultMode?: LuckyMode; }`
    - `export interface BuildResult { channels: ChannelSummary[]; defaultChannel: string | null; defaultMode: LuckyMode; outDir: string; }`
    - `export async function buildSite(options?: BuildOptions): Promise<BuildResult>`

- [ ] **Step 1: Write the failing tests in `tests/links.test.ts` and `tests/build.test.ts`**

In `tests/links.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { extractChannelLinks, extractLinksFromMarkdown } from "../src/links";

describe("extractLinksFromMarkdown", () => {
  test("extracts Markdown links and GFM autolinks while ignoring code blocks and self-channel links", () => {
    const md = [
      "Read [Rust](https://en.wikipedia.org/wiki/Rust_(programming_language)) and bare https://example.com/path?a=1.",
      "Self link: https://t.me/my_chan/42 and [Self Preview](https://t.me/s/MY_CHAN?before=10) and https://telegram.me/my_chan",
      "Other channel: https://t.me/other_chan/99",
      "Inline `https://ignored-in-code.example.com` and:\n```\nhttps://ignored-in-fence.example.com\n```",
    ].join("\n\n");

    const links = extractLinksFromMarkdown(md, "my_chan");
    expect(links).toEqual([
      "https://en.wikipedia.org/wiki/Rust_(programming_language)",
      "https://example.com/path?a=1",
      "https://t.me/other_chan/99",
    ]);
  });
});

describe("extractChannelLinks", () => {
  test("deduplicates normalized URLs across posts preserving first-seen order", () => {
    const posts = [
      { id: 1, date: "2024-01-01T00:00:00Z", text: "https://example.com and https://foo.bar/a" },
      { id: 2, date: "2024-01-02T00:00:00Z", text: "[Ex](https://example.com/) and https://baz.qux" },
    ];
    expect(extractChannelLinks(posts, "demo")).toEqual([
      "https://example.com/",
      "https://foo.bar/a",
      "https://baz.qux/",
    ]);
  });
});
```

In `tests/build.test.ts`:
```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "../src/build";
import { writeChannelPosts } from "../src/storage";

describe("buildSite", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "lucky-build-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("compiles data/*.jsonl into dist/data/*.json, channels.json, and dist/index.html with default config", async () => {
    const dataDir = join(tempDir, "data");
    const outDir = join(tempDir, "dist");

    await writeChannelPosts(join(dataDir, "alpha.jsonl"), [
      { id: 10, date: "2024-01-01T00:00:00Z", text: "Hello https://a.example.com" },
      { id: 12, date: "2024-01-02T00:00:00Z", text: "Media only" },
    ]);

    const res = await buildSite({
      dataDir,
      outDir,
      defaultMode: "link",
    });

    expect(res.defaultChannel).toBe("alpha");
    expect(res.defaultMode).toBe("link");

    const chanJson = JSON.parse(await readFile(join(outDir, "data", "alpha.json"), "utf8"));
    expect(chanJson).toEqual({
      channel: "alpha",
      postCount: 2,
      linkCount: 1,
      posts: [10, 12],
      links: ["https://a.example.com/"],
    });

    const channelsList = JSON.parse(await readFile(join(outDir, "data", "channels.json"), "utf8"));
    expect(channelsList).toEqual([
      { channel: "alpha", postCount: 2, linkCount: 1 },
    ]);

    const indexHtml = await readFile(join(outDir, "index.html"), "utf8");
    expect(indexHtml).toContain('"defaultChannel":"alpha"');
    expect(indexHtml).toContain('"defaultMode":"link"');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `mise exec bun -- bun test tests/links.test.ts tests/build.test.ts`
Expected: FAIL with module not found `../src/links` and `../src/build`.

- [ ] **Step 3: Implement `src/links.ts`, `src/web.ts`, and `src/build.ts`**

In `src/links.ts`:
- Parse `markdown` with `unified().use(remarkParse).use(remarkGfm)`.
- Visit `link` and `definition` nodes via `unist-util-visit` to collect `node.url`.
- Validate with `new URL(rawUrl)`; allow only `http:` and `https:`.
- Filter out self-channel links where hostname is `t.me` or `telegram.me` (or `www.t.me`) and pathname matches `/<channel>(/...)?` or `/s/<channel>(/...)?` (case-insensitive).
- Deduplicate using `url.toString()`.

In `src/web.ts`:
- `renderIndexHtml` produces a standalone HTML5 page embedding `window.__LUCKY_CONFIG__ = { defaultChannel, defaultMode, channels }`.
- Frontend script logic:
  - Parses `URLSearchParams(window.location.search)`:
    - `channel` = `params.get("channel") || params.get("c") || config.defaultChannel || (config.channels.length === 1 ? config.channels[0].channel : null)`
    - `mode` = `params.get("mode") || params.get("m") || config.defaultMode || "post"` (validated to `"post" | "link"`)
    - `ui` = `params.get("ui") === "1"`
  - When `channel` is set and `!ui`: fetches `./data/${encodeURIComponent(channel)}.json`, selects a random item from `posts` (redirecting to `https://t.me/${data.channel}/${id}`) or `links` (redirecting to the link URL) via `window.location.replace(target)`, and updates the visible fallback anchor. If the chosen pool is empty (e.g. `links.length === 0` in `link` mode), renders the interactive UI card with a clear notice and a button to jump to a random post instead.
  - Interactive UI mode renders channel selector, mode radio toggle (`随机帖子 (Post)` / `帖中链接 (Link)`), "🎲 手气不错" jump button, and copyable share links (`?c=<channel>&m=post` and `?c=<channel>&m=link`).

In `src/build.ts`:
- Reads optional `lucky.config.json` (if present) and merges with environment variables (`LUCKY_DEFAULT_CHANNEL`, `LUCKY_DEFAULT_MODE`) and explicit `BuildOptions`.
- Scans `<dataDir>/*.jsonl`, reads posts, extracts links via `extractChannelLinks`, writes `<outDir>/data/<channel>.json`, `<outDir>/data/channels.json`, and `<outDir>/index.html`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `mise exec bun -- bun test tests/links.test.ts tests/build.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

Commit via eval `commit` namespace with Linux Kernel style message (`build: Add unified Markdown link extractor and static site builder`).

---

### Task 4: CLI Entrypoint, Configuration, GitHub Actions Workflow & End-to-End Verification

**Files:**
- Create: `src/cli.ts`
- Create: `lucky.config.json`
- Create: `.github/workflows/lucky.yml`
- Create: `README.md`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes:
  - `scrapeChannel` from `src/scrape.ts`
  - `buildSite` from `src/build.ts`
  - `LuckyConfig`, `LuckyMode` from `src/types.ts`
- Produces:
  - `src/cli.ts`:
    - `export async function runCli(argv: string[]): Promise<number>`

- [ ] **Step 1: Write the failing CLI integration test in `tests/cli.test.ts`**

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { writeChannelPosts } from "../src/storage";

describe("runCli", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "lucky-cli-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("build subcommand builds dist with --default-channel and --default-mode flags", async () => {
    const dataDir = join(tempDir, "data");
    const outDir = join(tempDir, "dist");
    await writeChannelPosts(join(dataDir, "mychan.jsonl"), [
      { id: 1, date: "2024-01-01T00:00:00Z", text: "Visit https://example.com" },
    ]);

    const code = await runCli([
      "build",
      "--data-dir",
      dataDir,
      "--out-dir",
      outDir,
      "--default-channel",
      "mychan",
      "--default-mode",
      "link",
    ]);

    expect(code).toBe(0);
    const html = await readFile(join(outDir, "index.html"), "utf8");
    expect(html).toContain('"defaultChannel":"mychan"');
    expect(html).toContain('"defaultMode":"link"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `mise exec bun -- bun test tests/cli.test.ts`
Expected: FAIL with module not found `../src/cli`.

- [ ] **Step 3: Implement `src/cli.ts`, `lucky.config.json`, `.github/workflows/lucky.yml`, and `README.md`**

In `src/cli.ts`:
- Supports subcommands:
  - `scrape [channels...] [--full] [--data-dir <dir>] [--config <path>] [--delay <ms>]`: scrapes specified channels (or `channels` array from `lucky.config.json` if none passed on CLI).
  - `build [--data-dir <dir>] [--out-dir <dir>] [--config <path>] [--default-channel <name>] [--default-mode <post|link>]`: runs `buildSite`.
- Prints clear summary counts for each scraped/built channel.
- Create default `lucky.config.json`, `.github/workflows/lucky.yml` (scheduled cron + manual `workflow_dispatch` to run `bun run scrape`, commit updated `data/*.jsonl`, run `bun run build`, and deploy `dist/` to GitHub Pages), and concise `README.md`.

- [ ] **Step 4: Run full test suite and verify frontend in browser**

Run: `mise exec bun -- bun test`
Expected: All test files (`parser.test.ts`, `scrape.test.ts`, `links.test.ts`, `build.test.ts`, `cli.test.ts`) PASS.

- [ ] **Step 5: Commit**

Commit via eval `commit` namespace with Linux Kernel style message (`cli: Add scrape/build CLI entrypoint, GitHub Actions workflow, and docs`).
