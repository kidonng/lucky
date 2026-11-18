import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
