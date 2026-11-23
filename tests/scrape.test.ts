import { BunServices } from "@effect/platform-bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrapeChannel, scrapeChannels } from "../src/scrape";
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

function makeMockHttpClientLayer(
  handler: (url: string) => { status?: number; body: string }
): Layer.Layer<HttpClient.HttpClient> {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      const res = handler(url.toString());
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(res.body, { status: res.status ?? 200 })
        )
      );
    })
  );
}

const runScrape = <A, E>(
  effect: Effect.Effect<A, E, BunServices.BunServices | HttpClient.HttpClient>,
  httpLayer: Layer.Layer<HttpClient.HttpClient>
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, httpLayer)))
  );

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

    const res = await runScrape(
      scrapeChannel({
        channel: "testchan",
        dataDir: tempDir,
        delayMs: 0,
      }),
      makeMockHttpClientLayer((url) => ({ body: pages[url] ?? "" }))
    );

    expect(res.mode).toBe("full");
    expect(res.totalCount).toBe(4);

    const raw = await readFile(res.filePath, "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('{"id":1,"date":"2024-01-01T00:00:00+00:00","text":"Post 1"}');

    const posts = await Effect.runPromise(
      readChannelPosts(res.filePath).pipe(Effect.provide(BunServices.layer))
    );
    expect(posts.map((p) => p.id)).toEqual([1, 2, 3, 4]);
  });

  test("incremental scrape paginates forward with ?after=<maxId> when JSONL exists", async () => {
    const filePath = join(tempDir, "testchan.jsonl");
    await Effect.runPromise(
      writeChannelPosts(filePath, [
        { id: 1, date: "2024-01-01T00:00:00+00:00", text: "Post 1" },
        { id: 2, date: "2024-01-02T00:00:00+00:00", text: "Post 2" },
      ]).pipe(Effect.provide(BunServices.layer))
    );

    const pages: Record<string, string> = {
      "https://t.me/s/testchan?after=2": makePageHtml("testchan", [
        { id: 3, date: "2024-01-03T00:00:00+00:00", html: "Post 3" },
        { id: 4, date: "2024-01-04T00:00:00+00:00", html: "Post 4" },
      ]),
      "https://t.me/s/testchan?after=4": "",
    };

    const res = await runScrape(
      scrapeChannel({
        channel: "testchan",
        dataDir: tempDir,
        delayMs: 0,
      }),
      makeMockHttpClientLayer((url) => ({ body: pages[url] ?? "" }))
    );

    expect(res.mode).toBe("incremental");
    expect(res.addedOrUpdatedCount).toBe(2);
    expect(res.totalCount).toBe(4);

    const posts = await Effect.runPromise(
      readChannelPosts(filePath).pipe(Effect.provide(BunServices.layer))
    );
    expect(posts.map((p) => p.id)).toEqual([1, 2, 3, 4]);
  });

  test("full mode (--full) performs mirror replacement, removing deleted posts and updating edited text", async () => {
    const filePath = join(tempDir, "testchan.jsonl");
    await Effect.runPromise(
      writeChannelPosts(filePath, [
        { id: 1, date: "2024-01-01T00:00:00+00:00", text: "Old Post 1" },
        { id: 2, date: "2024-01-02T00:00:00+00:00", text: "Deleted Post 2" },
      ]).pipe(Effect.provide(BunServices.layer))
    );

    const pages: Record<string, string> = {
      "https://t.me/s/testchan": makePageHtml("testchan", [
        { id: 1, date: "2024-01-01T00:00:00+00:00", html: "Edited Post 1" },
        { id: 3, date: "2024-01-03T00:00:00+00:00", html: "New Post 3" },
      ]),
      "https://t.me/s/testchan?before=1": "",
    };

    const res = await runScrape(
      scrapeChannel({
        channel: "testchan",
        dataDir: tempDir,
        full: true,
        delayMs: 0,
      }),
      makeMockHttpClientLayer((url) => ({ body: pages[url] ?? "" }))
    );

    expect(res.mode).toBe("full");
    const posts = await Effect.runPromise(
      readChannelPosts(filePath).pipe(Effect.provide(BunServices.layer))
    );
    expect(posts).toEqual([
      { id: 1, date: "2024-01-01T00:00:00+00:00", text: "Edited Post 1" },
      { id: 3, date: "2024-01-03T00:00:00+00:00", text: "New Post 3" },
    ]);
  });

  test("full mode fails with EmptyFullScrapeError without wiping existing JSONL when channel returns zero posts", async () => {
    const filePath = join(tempDir, "testchan.jsonl");
    await Effect.runPromise(
      writeChannelPosts(filePath, [
        { id: 1, date: "2024-01-01T00:00:00+00:00", text: "Existing Post" },
      ]).pipe(Effect.provide(BunServices.layer))
    );

    const err = await runScrape(
      Effect.flip(
        scrapeChannel({
          channel: "testchan",
          dataDir: tempDir,
          full: true,
          delayMs: 0,
        })
      ),
      makeMockHttpClientLayer(() => ({
        body: "<html><body>Rate limited or invalid</body></html>",
      }))
    );

    expect(err._tag).toBe("EmptyFullScrapeError");

    const posts = await Effect.runPromise(
      readChannelPosts(filePath).pipe(Effect.provide(BunServices.layer))
    );
    expect(posts).toHaveLength(1);
  });

  test("retries HTTP 429 and succeeds, and fails after 3 attempts on persistent 500", async () => {
    let rateLimitAttempts = 0;
    const okRes = await runScrape(
      scrapeChannel({
        channel: "testchan",
        dataDir: tempDir,
        delayMs: 0,
      }),
      makeMockHttpClientLayer((url) => {
        if (url === "https://t.me/s/testchan") {
          rateLimitAttempts++;
          if (rateLimitAttempts === 1) {
            return { status: 429, body: "Too Many Requests" };
          }
          return {
            body: makePageHtml("testchan", [
              { id: 1, date: "2024-01-01T00:00:00+00:00", html: "Post 1" },
            ]),
          };
        }
        return { body: "" };
      })
    );
    expect(rateLimitAttempts).toBe(2);
    expect(okRes.totalCount).toBe(1);

    let serverErrorAttempts = 0;
    const err = await runScrape(
      Effect.flip(
        scrapeChannel({
          channel: "otherchan",
          dataDir: tempDir,
          delayMs: 0,
        })
      ),
      makeMockHttpClientLayer(() => {
        serverErrorAttempts++;
        return { status: 500, body: "Internal Server Error" };
      })
    );
    expect(serverErrorAttempts).toBe(3);
    expect(err._tag).toBe("ScrapeHttpError");
  });

  test("fails fast on HTTP 404 without retrying", async () => {
    let attempts = 0;
    const err = await runScrape(
      Effect.flip(
        scrapeChannel({
          channel: "missingchan",
          dataDir: tempDir,
          delayMs: 0,
        })
      ),
      makeMockHttpClientLayer(() => {
        attempts++;
        return { status: 404, body: "Not Found" };
      })
    );

    expect(attempts).toBe(1);
    expect(err._tag).toBe("ScrapeHttpError");
    if (err._tag === "ScrapeHttpError") {
      expect(err.status).toBe(404);
      expect(err.retryable).toBe(false);
    }
  });

  test("rejects invalid channel identifiers with InvalidChannelError and scrapeChannels processes multiple channels", async () => {
    const err = await runScrape(
      Effect.flip(
        scrapeChannel({
          channel: "https://example.com/not-telegram",
          dataDir: tempDir,
          delayMs: 0,
        })
      ),
      makeMockHttpClientLayer(() => ({ body: "" }))
    );
    expect(err._tag).toBe("InvalidChannelError");

    const results = await runScrape(
      scrapeChannels(["chan_a", "chan_b"], {
        dataDir: tempDir,
        delayMs: 0,
      }),
      makeMockHttpClientLayer((url) => {
        if (url === "https://t.me/s/chan_a") {
          return {
            body: makePageHtml("chan_a", [
              { id: 1, date: "2024-01-01T00:00:00+00:00", html: "A1" },
            ]),
          };
        }
        if (url === "https://t.me/s/chan_b") {
          return {
            body: makePageHtml("chan_b", [
              { id: 1, date: "2024-01-01T00:00:00+00:00", html: "B1" },
            ]),
          };
        }
        return { body: "" };
      })
    );
    expect(results.map((r) => r.channel)).toEqual(["chan_a", "chan_b"]);
  });
});
