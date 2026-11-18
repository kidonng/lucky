import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  test("scrape subcommand reads channels from config when none are passed as args", async () => {
    const configPath = join(tempDir, "lucky.config.json");
    await writeFile(
      configPath,
      JSON.stringify({ channels: [], defaultMode: "post" }),
      "utf8"
    );

    const code = await runCli(["scrape", "--config", configPath]);
    expect(code).toBe(1);
  });
});
