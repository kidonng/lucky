import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrapeChannel } from "../src/scrape";
import { readChannelPosts, writeChannelPosts } from "../src/storage";

function makePageHtml(
  channel: string,
  items: Array<{ id: number; date: string; html: string }>
): string {
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

  test("full mode refuses to wipe existing JSONL if the channel page returns zero posts", async () => {
    const filePath = join(tempDir, "testchan.jsonl");
    await writeChannelPosts(filePath, [
      { id: 1, date: "2024-01-01T00:00:00+00:00", text: "Existing Post" },
    ]);

    await expect(
      scrapeChannel({
        channel: "testchan",
        dataDir: tempDir,
        full: true,
        delayMs: 0,
        fetcher: async () => "<html><body>Rate limited or invalid</body></html>",
      })
    ).rejects.toThrow(/returned no posts/i);

    const posts = await readChannelPosts(filePath);
    expect(posts).toHaveLength(1);
  });
});
