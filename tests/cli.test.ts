import { BunServices } from "@effect/platform-bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { CliError } from "effect/cli";
import { HttpClient, HttpClientResponse } from "effect/http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli";
import { writeChannelPosts } from "../src/storage";

function makeMockHttpClientLayer(
  handler: (url: string) => { status?: number; body: string },
): Layer.Layer<HttpClient.HttpClient> {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      const res = handler(url.toString());
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(res.body, { status: res.status ?? 200 }),
        ),
      );
    }),
  );
}

const runCliWithEnv = <A, E>(
  effect: Effect.Effect<A, E, BunServices.BunServices | HttpClient.HttpClient>,
  httpLayer: Layer.Layer<HttpClient.HttpClient> = makeMockHttpClientLayer(
    () => ({
      body: "",
    }),
  ),
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, httpLayer))),
  );

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
    const configPath = join(tempDir, "lucky.config.json");

    await Effect.runPromise(
      writeChannelPosts(join(dataDir, "mychan.jsonl"), [
        {
          id: 1,
          date: "2024-01-01T00:00:00Z",
          text: "Visit https://example.com",
        },
      ]).pipe(Effect.provide(BunServices.layer)),
    );

    await runCliWithEnv(
      runCli([
        "build",
        "--data-dir",
        dataDir,
        "--out-dir",
        outDir,
        "--config",
        configPath,
        "--default-channel",
        "mychan",
        "--default-mode",
        "link",
      ]),
    );

    const html = await readFile(join(outDir, "index.html"), "utf8");
    expect(html).toContain('"defaultChannel":"mychan"');
    expect(html).toContain('"defaultMode":"link"');
  });

  test("scrape subcommand fails with NoChannelsConfiguredError when config has empty channels", async () => {
    const configPath = join(tempDir, "lucky.config.json");
    await writeFile(
      configPath,
      JSON.stringify({ channels: [], defaultMode: "post" }),
      "utf8",
    );

    const err = await runCliWithEnv(
      Effect.flip(runCli(["scrape", "--config", configPath])),
    );
    expect(err._tag).toBe("NoChannelsConfiguredError");
  });

  test("rejects invalid --delay and --default-mode flags with CliError", async () => {
    const delayErr = await runCliWithEnv(
      Effect.flip(runCli(["scrape", "mychan", "--delay", "abc"])),
    );
    expect(CliError.isCliError(delayErr)).toBe(true);

    const modeErr = await runCliWithEnv(
      Effect.flip(runCli(["build", "--default-mode", "bad"])),
    );
    expect(CliError.isCliError(modeErr)).toBe(true);
  });

  test("scrape subcommand scrapes positional channels using HttpClient", async () => {
    const dataDir = join(tempDir, "data");
    const configPath = join(tempDir, "lucky.config.json");

    await runCliWithEnv(
      runCli([
        "scrape",
        "testchan",
        "--data-dir",
        dataDir,
        "--config",
        configPath,
        "--delay",
        "0",
      ]),
      makeMockHttpClientLayer((url) => {
        if (url === "https://t.me/s/testchan") {
          return {
            body: `
              <div class="tgme_widget_message" data-post="testchan/1">
                <div class="tgme_widget_message_text js-message_text">Hello CLI</div>
                <div class="tgme_widget_message_footer">
                  <a class="tgme_widget_message_date" href="https://t.me/testchan/1">
                    <time datetime="2024-01-01T00:00:00+00:00">Date</time>
                  </a>
                </div>
              </div>`,
          };
        }
        return { body: "" };
      }),
    );

    const raw = await readFile(join(dataDir, "testchan.jsonl"), "utf8");
    expect(raw.trim()).toBe(
      '{"id":1,"date":"2024-01-01T00:00:00+00:00","text":"Hello CLI"}',
    );
  });
});
