import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { extractChannelLinks } from "./links";
import { normalizeChannelName } from "./parser";
import { readChannelPosts } from "./storage";
import type {
  ChannelIndex,
  ChannelSummary,
  LuckyConfig,
  LuckyMode,
} from "./types";
import { renderIndexHtml } from "./web";

export interface BuildOptions {
  dataDir?: string;
  outDir?: string;
  configPath?: string;
  defaultChannel?: string;
  defaultMode?: LuckyMode;
}

export interface BuildResult {
  channels: ChannelSummary[];
  defaultChannel: string | null;
  defaultMode: LuckyMode;
  outDir: string;
}

export async function loadLuckyConfig(
  configPath = "lucky.config.json"
): Promise<LuckyConfig> {
  if (!existsSync(configPath)) {
    return {};
  }
  const raw = await readFile(configPath, "utf8");
  return JSON.parse(raw) as LuckyConfig;
}

function resolveMode(value: string | undefined): LuckyMode | undefined {
  if (value === "post" || value === "link") {
    return value;
  }
  return undefined;
}

export async function buildSite(options: BuildOptions = {}): Promise<BuildResult> {
  const dataDir = options.dataDir ?? "data";
  const outDir = options.outDir ?? "dist";
  const fileConfig = await loadLuckyConfig(options.configPath);

  const outDataDir = join(outDir, "data");
  await mkdir(outDataDir, { recursive: true });

  const entries = existsSync(dataDir) ? await readdir(dataDir) : [];
  const jsonlFiles = entries
    .filter((name) => name.endsWith(".jsonl"))
    .sort((a, b) => a.localeCompare(b));

  const summaries: ChannelSummary[] = [];

  for (const fileName of jsonlFiles) {
    const channel = basename(fileName, ".jsonl");
    const posts = await readChannelPosts(join(dataDir, fileName));
    const postIds = posts.map((p) => p.id);
    const links = extractChannelLinks(posts, channel);

    const indexData: ChannelIndex = {
      channel,
      postCount: postIds.length,
      linkCount: links.length,
      posts: postIds,
      links,
    };

    await writeFile(
      join(outDataDir, `${channel}.json`),
      `${JSON.stringify(indexData, null, 2)}\n`,
      "utf8"
    );

    summaries.push({
      channel,
      postCount: postIds.length,
      linkCount: links.length,
    });
  }

  await writeFile(
    join(outDataDir, "channels.json"),
    `${JSON.stringify(summaries, null, 2)}\n`,
    "utf8"
  );

  const rawDefaultChannel =
    options.defaultChannel ??
    process.env.LUCKY_DEFAULT_CHANNEL ??
    fileConfig.defaultChannel;

  let defaultChannel: string | null = null;
  if (rawDefaultChannel && rawDefaultChannel.trim()) {
    defaultChannel = normalizeChannelName(rawDefaultChannel);
  } else if (summaries.length === 1 && summaries[0]) {
    defaultChannel = summaries[0].channel;
  }

  const defaultMode: LuckyMode =
    options.defaultMode ??
    resolveMode(process.env.LUCKY_DEFAULT_MODE) ??
    fileConfig.defaultMode ??
    "post";

  const html = renderIndexHtml({
    defaultChannel,
    defaultMode,
    channels: summaries,
  });

  await writeFile(join(outDir, "index.html"), html, "utf8");

  return {
    channels: summaries,
    defaultChannel,
    defaultMode,
    outDir,
  };
}
