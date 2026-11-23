import { Config, Effect, FileSystem, Option, Path, Schema } from "effect";
import { extractChannelLinks } from "./links";
import { normalizeChannelName } from "./parser";
import { readChannelPosts } from "./storage";
import {
  type ChannelIndex,
  type ChannelSummary,
  ConfigParseError,
  InvalidChannelError,
  type LuckyConfig,
  LuckyConfigJson,
  type LuckyMode,
} from "./types";

const INDEX_HTML_TEMPLATE_URL = new URL("./index.html", import.meta.url);
const decodeLuckyConfigJson = Schema.decodeUnknownEffect(LuckyConfigJson);

export interface BuildOptions {
  dataDir?: string;
  outDir?: string;
  configPath?: string;
  defaultChannel?: string;
  defaultMode?: LuckyMode;
}

export interface BuildResult {
  channels: Array<ChannelSummary>;
  defaultChannel: string | null;
  defaultMode: LuckyMode;
  outDir: string;
}

const normalizeChannelEffect = (input: string) =>
  Effect.try({
    try: () => normalizeChannelName(input),
    catch: (cause) =>
      new InvalidChannelError({
        input,
        cause,
      }),
  });

export const loadLuckyConfig = Effect.fn("build.loadLuckyConfig")(function* (
  configPath = "lucky.config.json",
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(configPath))) {
    return {} satisfies LuckyConfig;
  }

  const raw = yield* fs.readFileString(configPath);
  return yield* decodeLuckyConfigJson(raw).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigParseError({
          path: configPath,
          cause,
        }),
    ),
  );
});

export const renderIndexHtml = Effect.fn("build.renderIndexHtml")(
  function* (config: {
    defaultChannel: string | null;
    defaultMode: LuckyMode;
    channels: ReadonlyArray<ChannelSummary>;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const templatePath = yield* path.fromFileUrl(INDEX_HTML_TEMPLATE_URL);
    const template = yield* fs.readFileString(templatePath);

    const serializedConfig = JSON.stringify({
      defaultChannel: config.defaultChannel,
      defaultMode: config.defaultMode,
      channels: config.channels,
    }).replace(/</g, "\\u003c");

    return template.replace("__LUCKY_CONFIG_JSON__", () => serializedConfig);
  },
);

export const buildSite = Effect.fn("build.buildSite")(function* (
  options: BuildOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const dataDir = options.dataDir ?? "data";
  const outDir = options.outDir ?? "dist";
  const fileConfig = yield* loadLuckyConfig(options.configPath);

  const envDefaultChannel =
    options.defaultChannel !== undefined
      ? Option.none<string>()
      : yield* Config.option(Config.String("LUCKY_DEFAULT_CHANNEL"));
  const nonBlankEnvChannel = Option.getOrUndefined(
    Option.filter(envDefaultChannel, (value) => value.trim().length > 0),
  );

  const envDefaultMode =
    options.defaultMode !== undefined
      ? Option.none<LuckyMode>()
      : yield* Config.option(
          Config.Literals(["post", "link"], "LUCKY_DEFAULT_MODE"),
        );
  const defaultMode: LuckyMode =
    options.defaultMode ??
    Option.getOrUndefined(envDefaultMode) ??
    fileConfig.defaultMode ??
    "post";

  const explicitOrFallbackChannel =
    options.defaultChannel !== undefined
      ? options.defaultChannel
      : (nonBlankEnvChannel ??
        (fileConfig.defaultChannel && fileConfig.defaultChannel.trim()
          ? fileConfig.defaultChannel
          : undefined));

  const normalizedRequestedChannel =
    explicitOrFallbackChannel !== undefined
      ? yield* normalizeChannelEffect(explicitOrFallbackChannel)
      : null;

  const entries = (yield* fs.exists(dataDir))
    ? yield* fs.readDirectory(dataDir)
    : [];
  const jsonlFiles = entries
    .filter((name) => name.endsWith(".jsonl"))
    .sort((a, b) => a.localeCompare(b));

  const summaries: Array<ChannelSummary> = [];
  const channelIndexes: Array<ChannelIndex> = [];

  for (const fileName of jsonlFiles) {
    const channel = yield* normalizeChannelEffect(
      path.basename(fileName, ".jsonl"),
    );
    const posts = yield* readChannelPosts(path.join(dataDir, fileName));
    const postIds = posts.map((p) => p.id);
    const links = extractChannelLinks(posts, channel);

    channelIndexes.push({
      channel,
      postCount: postIds.length,
      linkCount: links.length,
      posts: postIds,
      links,
    });

    summaries.push({
      channel,
      postCount: postIds.length,
      linkCount: links.length,
    });
  }

  let defaultChannel: string | null = null;
  if (normalizedRequestedChannel !== null) {
    const matched = summaries.find(
      (item) =>
        item.channel.toLowerCase() === normalizedRequestedChannel.toLowerCase(),
    );
    defaultChannel = matched ? matched.channel : normalizedRequestedChannel;
  } else if (summaries.length === 1 && summaries[0]) {
    defaultChannel = summaries[0].channel;
  }

  const html = yield* renderIndexHtml({
    defaultChannel,
    defaultMode,
    channels: summaries,
  });

  const outDataDir = path.join(outDir, "data");
  yield* fs.makeDirectory(outDataDir, { recursive: true });

  for (const indexData of channelIndexes) {
    yield* fs.writeFileString(
      path.join(outDataDir, `${indexData.channel}.json`),
      `${JSON.stringify(indexData, null, 2)}\n`,
    );
  }

  yield* fs.writeFileString(
    path.join(outDataDir, "channels.json"),
    `${JSON.stringify(summaries, null, 2)}\n`,
  );

  yield* fs.writeFileString(path.join(outDir, "index.html"), html);

  return {
    channels: summaries,
    defaultChannel,
    defaultMode,
    outDir,
  } satisfies BuildResult;
});
