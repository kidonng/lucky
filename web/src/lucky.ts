import type {
  ChannelIndex,
  ChannelSummary,
  LuckyMode,
  LuckyRuntimeConfig,
} from "../../src/types.ts";

const DEFAULT_CONFIG: LuckyRuntimeConfig = {
  defaultChannel: null,
  defaultMode: "post",
  channels: [],
};

function normalizeRuntimeConfig(raw: unknown): LuckyRuntimeConfig {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_CONFIG;
  }
  const obj = raw as Record<string, unknown>;
  const defaultChannel =
    typeof obj.defaultChannel === "string" && obj.defaultChannel.trim()
      ? obj.defaultChannel
      : null;
  const defaultMode: LuckyMode = obj.defaultMode === "link" ? "link" : "post";
  const channels: Array<ChannelSummary> = Array.isArray(obj.channels)
    ? obj.channels.flatMap((item): Array<ChannelSummary> => {
        if (!item || typeof item !== "object") return [];
        const entry = item as Record<string, unknown>;
        if (typeof entry.channel !== "string") return [];
        return [
          {
            channel: entry.channel,
            postCount:
              typeof entry.postCount === "number" ? entry.postCount : 0,
            linkCount:
              typeof entry.linkCount === "number" ? entry.linkCount : 0,
          },
        ];
      })
    : [];

  return { defaultChannel, defaultMode, channels };
}

export function readEmbeddedConfig(
  doc: Pick<Document, "getElementById"> | undefined = typeof document !==
  "undefined"
    ? document
    : undefined,
  win: { __LUCKY_CONFIG__?: unknown } | undefined = typeof window !==
  "undefined"
    ? (window as unknown as { __LUCKY_CONFIG__?: unknown })
    : undefined,
): LuckyRuntimeConfig {
  if (doc) {
    const el = doc.getElementById("lucky-config");
    const rawText = el?.textContent?.trim();
    if (rawText && !rawText.startsWith("__LUCKY_CONFIG_")) {
      try {
        return normalizeRuntimeConfig(JSON.parse(rawText));
      } catch {
        // Ignore malformed embedded JSON and fall back cleanly.
      }
    }
  }

  if (win && win.__LUCKY_CONFIG__ !== undefined) {
    return normalizeRuntimeConfig(win.__LUCKY_CONFIG__);
  }

  return DEFAULT_CONFIG;
}

export function resolveInitialParams(
  search: string,
  cfg: LuckyRuntimeConfig,
): {
  resolvedChannel: string | null;
  resolvedMode: LuckyMode;
  forceUi: boolean;
} {
  const params = new URLSearchParams(search);
  const rawChannel = params.get("channel") || params.get("c");
  const rawMode = params.get("mode") || params.get("m");
  const forceUi = params.get("ui") === "1";

  const fallbackSingle =
    cfg.channels.length === 1 && cfg.channels[0]
      ? cfg.channels[0].channel
      : null;

  const resolvedChannel =
    rawChannel || cfg.defaultChannel || fallbackSingle || null;
  const resolvedMode: LuckyMode =
    rawMode === "link" || rawMode === "post"
      ? rawMode
      : cfg.defaultMode === "link"
        ? "link"
        : "post";

  return { resolvedChannel, resolvedMode, forceUi };
}

export function pickRandom<T>(
  items: readonly T[],
  rng: () => number = Math.random,
): T | null {
  if (items.length === 0) return null;
  const idx = Math.floor(rng() * items.length);
  return items[idx] ?? null;
}

export function pickTargetUrl(
  data: ChannelIndex,
  mode: LuckyMode,
  rng: () => number = Math.random,
): string | null {
  if (mode === "link") {
    return pickRandom(data.links, rng);
  }
  const postId = pickRandom(data.posts, rng);
  return postId ? `https://t.me/${data.channel}/${postId}` : null;
}

export function buildShareQuery(channel: string, mode: LuckyMode): string {
  return `?c=${encodeURIComponent(channel)}&m=${mode}`;
}

export function resolveChannelList(
  cfg: LuckyRuntimeConfig,
  initialChannel: string | null,
): ReadonlyArray<ChannelSummary> {
  if (cfg.channels.length > 0) {
    return cfg.channels;
  }
  if (initialChannel) {
    return [{ channel: initialChannel, postCount: 0, linkCount: 0 }];
  }
  return [];
}

export async function fetchChannelData(
  channel: string,
  cache: Record<string, ChannelIndex>,
  fetchImpl: typeof fetch = fetch,
): Promise<ChannelIndex> {
  const cached = cache[channel];
  if (cached) return cached;

  const res = await fetchImpl(`./data/${encodeURIComponent(channel)}.json`);
  if (!res.ok) {
    throw new Error(`无法加载频道数据: ${channel}`);
  }
  const data = (await res.json()) as ChannelIndex;
  cache[channel] = data;
  return data;
}

export type LuckyTargetResolution =
  { ok: true; target: string } | { ok: false; hasPosts: boolean };

export async function resolveLuckyTarget(
  channel: string,
  mode: LuckyMode,
  cache: Record<string, ChannelIndex>,
  options?: {
    fetchImpl?: typeof fetch;
    rng?: () => number;
  },
): Promise<LuckyTargetResolution> {
  const data = await fetchChannelData(channel, cache, options?.fetchImpl);
  const target = pickTargetUrl(data, mode, options?.rng);
  if (target) {
    return { ok: true, target };
  }
  return {
    ok: false,
    hasPosts: Array.isArray(data.posts) && data.posts.length > 0,
  };
}
