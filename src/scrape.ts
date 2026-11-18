import { join } from "node:path";
import { normalizeChannelName, parseChannelPageHtml } from "./parser";
import { readChannelPosts, writeChannelPosts } from "./storage";
import type { ChannelPost } from "./types";

export interface ScrapeOptions {
  channel: string;
  dataDir?: string;
  full?: boolean;
  delayMs?: number;
  fetcher?: (url: string) => Promise<string>;
}

export interface ScrapeResult {
  channel: string;
  mode: "full" | "incremental";
  fetchedPages: number;
  addedOrUpdatedCount: number;
  totalCount: number;
  filePath: string;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function defaultTelegramFetcher(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: "text/html",
        },
      });
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`HTTP ${response.status} fetching ${url}`);
      }
      if (!response.ok) {
        throw new Error(`Unexpected HTTP ${response.status} fetching ${url}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await sleep(300 * (attempt + 1));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function scrapeChannel(options: ScrapeOptions): Promise<ScrapeResult> {
  const channel = normalizeChannelName(options.channel);
  const dataDir = options.dataDir ?? "data";
  const delayMs = options.delayMs ?? 250;
  const fetcher = options.fetcher ?? defaultTelegramFetcher;
  const filePath = join(dataDir, `${channel}.jsonl`);

  const existingPosts = await readChannelPosts(filePath);
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
        await sleep(delayMs);
      }

      const html = await fetcher(currentUrl);
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
      throw new Error(
        `Full scrape for channel "${channel}" returned no posts; refusing to overwrite existing ${existingPosts.length} posts`
      );
    }

    const finalPosts = Array.from(collected.values()).sort((a, b) => a.id - b.id);
    await writeChannelPosts(filePath, finalPosts);

    return {
      channel,
      mode: "full",
      fetchedPages,
      addedOrUpdatedCount: finalPosts.length,
      totalCount: finalPosts.length,
      filePath,
    };
  }

  // Incremental mode
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
      await sleep(delayMs);
    }

    const currentUrl = `${baseUrl}?after=${maxId}`;
    const html = await fetcher(currentUrl);
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
  await writeChannelPosts(filePath, mergedPosts);

  return {
    channel,
    mode: "incremental",
    fetchedPages,
    addedOrUpdatedCount,
    totalCount: mergedPosts.length,
    filePath,
  };
}
