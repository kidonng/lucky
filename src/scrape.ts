import { Duration, Effect, Path, Schedule } from "effect";
import { HttpClient } from "effect/http";
import { normalizeChannelName, parseChannelPageHtml } from "./parser";
import { readChannelPosts, writeChannelPosts } from "./storage";
import {
  type ChannelPost,
  EmptyFullScrapeError,
  InvalidChannelError,
  ScrapeHttpError,
} from "./types";

export interface ScrapeOptions {
  channel: string;
  dataDir?: string;
  full?: boolean;
  delayMs?: number;
}

export interface ScrapeResult {
  channel: string;
  mode: "full" | "incremental";
  fetchedPages: number;
  addedOrUpdatedCount: number;
  totalCount: number;
  filePath: string;
}

const retrySchedule = Schedule.exponential("300 millis").pipe(
  Schedule.upTo({ times: 2 }),
  Schedule.setInputType<ScrapeHttpError>(),
  Schedule.while(({ input }) => input.retryable),
);

export const fetchTelegramPage = Effect.fn("scrape.fetchTelegramPage")(
  function* (url: string) {
    const client = yield* HttpClient.HttpClient;

    return yield* Effect.gen(function* () {
      const response = yield* client
        .get(url, {
          headers: {
            accept: "text/html",
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ScrapeHttpError({
                url,
                retryable: true,
                cause,
              }),
          ),
        );

      if (response.status === 429 || response.status >= 500) {
        return yield* new ScrapeHttpError({
          url,
          status: response.status,
          retryable: true,
          cause: new Error(`HTTP ${response.status} fetching ${url}`),
        });
      }

      if (response.status < 200 || response.status >= 300) {
        return yield* new ScrapeHttpError({
          url,
          status: response.status,
          retryable: false,
          cause: new Error(
            `Unexpected HTTP ${response.status} fetching ${url}`,
          ),
        });
      }

      return yield* response.text.pipe(
        Effect.mapError(
          (cause) =>
            new ScrapeHttpError({
              url,
              status: response.status,
              retryable: true,
              cause,
            }),
        ),
      );
    }).pipe(Effect.retry(retrySchedule));
  },
);

export const scrapeChannel = Effect.fn("scrape.scrapeChannel")(function* (
  options: ScrapeOptions,
) {
  const path = yield* Path.Path;
  const channel = yield* Effect.try({
    try: () => normalizeChannelName(options.channel),
    catch: (cause) =>
      new InvalidChannelError({
        input: options.channel,
        cause,
      }),
  });

  const dataDir = options.dataDir ?? "data";
  const delayMs = options.delayMs ?? 250;
  const filePath = path.join(dataDir, `${channel}.jsonl`);

  const existingPosts = yield* readChannelPosts(filePath);
  const mode: "full" | "incremental" =
    options.full || existingPosts.length === 0 ? "full" : "incremental";

  const baseUrl = `https://t.me/s/${channel}`;
  let fetchedPages = 0;

  if (mode === "full") {
    const collected = new Map<number, ChannelPost>();
    let currentUrl = baseUrl;
    let lowestId = Number.POSITIVE_INFINITY;

    while (true) {
      if (fetchedPages > 0 && delayMs > 0) {
        yield* Effect.sleep(Duration.millis(delayMs));
      }

      const html = yield* fetchTelegramPage(currentUrl);
      fetchedPages++;

      const pagePosts = parseChannelPageHtml(html, channel);
      if (pagePosts.length === 0) {
        break;
      }

      let foundOlder = false;
      for (const post of pagePosts) {
        collected.set(post.id, post);
        if (post.id < lowestId) {
          lowestId = post.id;
          foundOlder = true;
        }
      }

      if (!foundOlder || lowestId <= 1) {
        break;
      }

      currentUrl = `${baseUrl}?before=${lowestId}`;
    }

    if (collected.size === 0 && existingPosts.length > 0) {
      return yield* new EmptyFullScrapeError({
        channel,
        existingCount: existingPosts.length,
      });
    }

    const finalPosts = Array.from(collected.values()).sort(
      (a, b) => a.id - b.id,
    );
    yield* writeChannelPosts(filePath, finalPosts);

    return {
      channel,
      mode: "full",
      fetchedPages,
      addedOrUpdatedCount: finalPosts.length,
      totalCount: finalPosts.length,
      filePath,
    } satisfies ScrapeResult;
  }

  const byId = new Map<number, ChannelPost>();
  let maxId = 0;
  for (const post of existingPosts) {
    byId.set(post.id, post);
    if (post.id > maxId) {
      maxId = post.id;
    }
  }

  let addedOrUpdatedCount = 0;

  while (true) {
    if (fetchedPages > 0 && delayMs > 0) {
      yield* Effect.sleep(Duration.millis(delayMs));
    }

    const currentUrl = `${baseUrl}?after=${maxId}`;
    const html = yield* fetchTelegramPage(currentUrl);
    fetchedPages++;

    const pagePosts = parseChannelPageHtml(html, channel);
    if (pagePosts.length === 0) {
      break;
    }

    let highestNewId = maxId;
    for (const post of pagePosts) {
      if (post.id > maxId) {
        if (!byId.has(post.id)) {
          addedOrUpdatedCount++;
        }
        byId.set(post.id, post);
        if (post.id > highestNewId) {
          highestNewId = post.id;
        }
      }
    }

    if (highestNewId <= maxId) {
      break;
    }

    maxId = highestNewId;
  }

  const mergedPosts = Array.from(byId.values()).sort((a, b) => a.id - b.id);
  yield* writeChannelPosts(filePath, mergedPosts);

  return {
    channel,
    mode: "incremental",
    fetchedPages,
    addedOrUpdatedCount,
    totalCount: mergedPosts.length,
    filePath,
  } satisfies ScrapeResult;
});

export const scrapeChannels = Effect.fn("scrape.scrapeChannels")(function* (
  channels: ReadonlyArray<string>,
  options: Omit<ScrapeOptions, "channel"> & { concurrency?: number } = {},
) {
  return yield* Effect.forEach(
    channels,
    (channel) =>
      scrapeChannel({
        ...options,
        channel,
      }),
    { concurrency: options.concurrency ?? 1 },
  );
});
