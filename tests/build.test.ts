import { BunServices } from "@effect/platform-bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Layer } from "effect";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite, loadLuckyConfig } from "../src/build";
import { writeChannelPosts } from "../src/storage";

const runWithBun = <A, E>(
  effect: Effect.Effect<A, E, BunServices.BunServices>,
  extraLayer?: Layer.Layer<never>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        extraLayer
          ? Layer.mergeAll(BunServices.layer, extraLayer)
          : BunServices.layer,
      ),
    ),
  );

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
    const configPath = join(tempDir, "lucky.config.json");

    await runWithBun(
      writeChannelPosts(join(dataDir, "alpha.jsonl"), [
        {
          id: 10,
          date: "2024-01-01T00:00:00Z",
          text: "Hello https://a.example.com",
        },
        { id: 12, date: "2024-01-02T00:00:00Z", text: "Media only" },
      ]),
    );

    const res = await runWithBun(
      buildSite({
        dataDir,
        outDir,
        configPath,
        defaultMode: "link",
      }),
    );

    expect(res.defaultChannel).toBe("alpha");
    expect(res.defaultMode).toBe("link");

    const chanJson = JSON.parse(
      await readFile(join(outDir, "data", "alpha.json"), "utf8"),
    );
    expect(chanJson).toEqual({
      channel: "alpha",
      postCount: 2,
      linkCount: 1,
      posts: [10, 12],
      links: ["https://a.example.com/"],
    });

    const channelsList = JSON.parse(
      await readFile(join(outDir, "data", "channels.json"), "utf8"),
    );
    expect(channelsList).toEqual([
      { channel: "alpha", postCount: 2, linkCount: 1 },
    ]);

    const indexHtml = await readFile(join(outDir, "index.html"), "utf8");
    expect(indexHtml).toContain('"defaultChannel":"alpha"');
    expect(indexHtml).toContain('"defaultMode":"link"');
  });

  test("resolves defaultChannel case-insensitively against built channel filenames", async () => {
    const dataDir = join(tempDir, "data");
    const outDir = join(tempDir, "dist");
    const configPath = join(tempDir, "lucky.config.json");

    await runWithBun(
      writeChannelPosts(join(dataDir, "MyChan.jsonl"), [
        { id: 1, date: "2024-01-01T00:00:00Z", text: "Post 1" },
      ]),
    );

    const res = await runWithBun(
      buildSite({
        dataDir,
        outDir,
        configPath,
        defaultChannel: "mychan",
      }),
    );

    expect(res.defaultChannel).toBe("MyChan");
  });

  test("loadLuckyConfig fails with ConfigParseError on malformed JSON or invalid defaultMode", async () => {
    const badJsonPath = join(tempDir, "bad.json");
    await writeFile(badJsonPath, "{not-json", "utf8");

    const jsonErr = await runWithBun(Effect.flip(loadLuckyConfig(badJsonPath)));
    expect(jsonErr._tag).toBe("ConfigParseError");

    const badModePath = join(tempDir, "bad-mode.json");
    await writeFile(
      badModePath,
      JSON.stringify({ defaultMode: "bad" }),
      "utf8",
    );

    const modeErr = await runWithBun(Effect.flip(loadLuckyConfig(badModePath)));
    expect(modeErr._tag).toBe("ConfigParseError");
  });

  test("honors LUCKY_DEFAULT_CHANNEL and LUCKY_DEFAULT_MODE env config and rejects invalid LUCKY_DEFAULT_MODE", async () => {
    const dataDir = join(tempDir, "data");
    const outDir = join(tempDir, "dist");
    const configPath = join(tempDir, "lucky.config.json");

    await runWithBun(
      writeChannelPosts(join(dataDir, "alpha.jsonl"), [
        { id: 1, date: "2024-01-01T00:00:00Z", text: "Post 1" },
      ]),
    );
    await runWithBun(
      writeChannelPosts(join(dataDir, "beta.jsonl"), [
        { id: 2, date: "2024-01-02T00:00:00Z", text: "Post 2" },
      ]),
    );

    const envRes = await runWithBun(
      buildSite({ dataDir, outDir, configPath }),
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          LUCKY_DEFAULT_CHANNEL: "beta",
          LUCKY_DEFAULT_MODE: "link",
        }),
      ),
    );
    expect(envRes.defaultChannel).toBe("beta");
    expect(envRes.defaultMode).toBe("link");

    const invalidEnvErr = await runWithBun(
      Effect.flip(buildSite({ dataDir, outDir, configPath })),
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          LUCKY_DEFAULT_MODE: "invalid",
        }),
      ),
    );
    expect(invalidEnvErr._tag).toBe("ConfigError");
  });

  test("fails with InvalidChannelError when defaultChannel is invalid or whitespace, without creating outDir", async () => {
    const dataDir = join(tempDir, "data");
    const outDir = join(tempDir, "dist");
    const configPath = join(tempDir, "lucky.config.json");

    const err = await runWithBun(
      Effect.flip(
        buildSite({
          dataDir,
          outDir,
          configPath,
          defaultChannel: "https://example.com/bad",
        }),
      ),
    );
    expect(err._tag).toBe("InvalidChannelError");
    expect(existsSync(outDir)).toBe(false);

    const blankErr = await runWithBun(
      Effect.flip(
        buildSite({
          dataDir,
          outDir,
          configPath,
          defaultChannel: "   ",
        }),
      ),
    );
    expect(blankErr._tag).toBe("InvalidChannelError");
    expect(existsSync(outDir)).toBe(false);
  });

  test("treats blank LUCKY_DEFAULT_CHANNEL env var as unset and avoids creating outDir on invalid LUCKY_DEFAULT_MODE", async () => {
    const dataDir = join(tempDir, "data");
    const outDir = join(tempDir, "dist");
    const configPath = join(tempDir, "lucky.config.json");

    await writeFile(
      configPath,
      JSON.stringify({ defaultChannel: "alpha" }),
      "utf8",
    );
    await runWithBun(
      writeChannelPosts(join(dataDir, "alpha.jsonl"), [
        { id: 1, date: "2024-01-01T00:00:00Z", text: "Post 1" },
      ]),
    );

    const invalidModeOutDir = join(tempDir, "dist-invalid-mode");
    const invalidEnvErr = await runWithBun(
      Effect.flip(
        buildSite({ dataDir, outDir: invalidModeOutDir, configPath }),
      ),
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          LUCKY_DEFAULT_MODE: "invalid",
        }),
      ),
    );
    expect(invalidEnvErr._tag).toBe("ConfigError");
    expect(existsSync(invalidModeOutDir)).toBe(false);

    const res = await runWithBun(
      buildSite({ dataDir, outDir, configPath }),
      ConfigProvider.layer(
        ConfigProvider.fromEnvRecord({
          LUCKY_DEFAULT_CHANNEL: "   ",
        }),
      ),
    );
    expect(res.defaultChannel).toBe("alpha");
  });

  test("fails with InvalidChannelError without creating outDir when dataDir has an invalid channel filename", async () => {
    const dataDir = join(tempDir, "data");
    const outDir = join(tempDir, "dist");
    const configPath = join(tempDir, "lucky.config.json");

    await runWithBun(
      writeChannelPosts(join(dataDir, "my-channel.jsonl"), [
        {
          id: 1,
          date: "2024-01-01T00:00:00Z",
          text: "Hello https://example.com",
        },
      ]),
    );

    const err = await runWithBun(
      Effect.flip(buildSite({ dataDir, outDir, configPath })),
    );
    expect(err._tag).toBe("InvalidChannelError");
    expect(existsSync(outDir)).toBe(false);
  });

  test("built index.html is a standard static Tailwind+Preact site with emitted CSS/JS assets and embedded config JSON", async () => {
    const dataDir = join(tempDir, "data");
    const outDir = join(tempDir, "dist");
    const configPath = join(tempDir, "lucky.config.json");

    await runWithBun(
      writeChannelPosts(join(dataDir, "alpha.jsonl"), [
        {
          id: 10,
          date: "2024-01-01T00:00:00Z",
          text: "Hello https://a.example.com/target",
        },
      ]),
    );

    await runWithBun(
      buildSite({
        dataDir,
        outDir,
        configPath,
        defaultChannel: "alpha",
        defaultMode: "post",
      }),
    );

    const html = await readFile(join(outDir, "index.html"), "utf8");
    expect(html).not.toContain("__LUCKY_CONFIG_JSON__");

    const cssMatch = html.match(/<link\b[^>]*\bhref="\.\/([^"]+\.css)"/);
    const jsMatch = html.match(/<script\b[^>]*\bsrc="\.\/([^"]+\.js)"/);
    expect(cssMatch?.[1]).toBeDefined();
    expect(jsMatch?.[1]).toBeDefined();
    expect(existsSync(join(outDir, cssMatch![1]!))).toBe(true);
    expect(existsSync(join(outDir, jsMatch![1]!))).toBe(true);

    const configMatch = html.match(
      /<script id="lucky-config" type="application\/json">([\s\S]*?)<\/script>/,
    );
    expect(configMatch?.[1]).toBeDefined();
    expect(JSON.parse(configMatch![1]!)).toEqual({
      defaultChannel: "alpha",
      defaultMode: "post",
      channels: [{ channel: "alpha", postCount: 1, linkCount: 1 }],
    });
  });

  test("reads mirrors from lucky.config.json, normalizes/deduplicates them, and embeds them into dist/index.html", async () => {
    const dataDir = join(tempDir, "data");
    const outDir = join(tempDir, "dist");
    const configPath = join(tempDir, "lucky.config.json");

    await writeFile(
      configPath,
      JSON.stringify({
        mirrors: [
          "tg.example.com",
          "https://TG.EXAMPLE.COM/",
          "http://localhost:8787/s/",
        ],
      }),
      "utf8",
    );
    await runWithBun(
      writeChannelPosts(join(dataDir, "alpha.jsonl"), [
        { id: 10, date: "2024-01-01T00:00:00Z", text: "Post 10" },
      ]),
    );

    const res = await runWithBun(buildSite({ dataDir, outDir, configPath }));
    expect(res.mirrors).toEqual([
      "https://tg.example.com",
      "http://localhost:8787/s",
    ]);

    const html = await readFile(join(outDir, "index.html"), "utf8");
    const configMatch = html.match(
      /<script id="lucky-config" type="application\/json">([\s\S]*?)<\/script>/,
    );
    expect(configMatch?.[1]).toBeDefined();
    expect(JSON.parse(configMatch![1]!)).toEqual({
      defaultChannel: "alpha",
      defaultMode: "post",
      channels: [{ channel: "alpha", postCount: 1, linkCount: 0 }],
      mirrors: ["https://tg.example.com", "http://localhost:8787/s"],
    });
  });

  test("fails with InvalidMirrorError before creating outDir when configured mirrors contain an invalid entry", async () => {
    const dataDir = join(tempDir, "data");
    const outDir = join(tempDir, "dist");
    const configPath = join(tempDir, "lucky.config.json");

    await writeFile(
      configPath,
      JSON.stringify({ mirrors: ["ftp://bad.example.com"] }),
      "utf8",
    );

    const fileErr = await runWithBun(
      Effect.flip(buildSite({ dataDir, outDir, configPath })),
    );
    expect(fileErr._tag).toBe("InvalidMirrorError");
    expect(existsSync(outDir)).toBe(false);

    const optOutDir = join(tempDir, "dist-opt");
    const optErr = await runWithBun(
      Effect.flip(
        buildSite({
          dataDir,
          outDir: optOutDir,
          configPath: join(tempDir, "missing.json"),
          mirrors: ["   "],
        }),
      ),
    );
    expect(optErr._tag).toBe("InvalidMirrorError");
    expect(existsSync(optOutDir)).toBe(false);
  });
});
