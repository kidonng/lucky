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

export const loadLuckyConfig = Effect.fn("build.loadLuckyConfig")(
  function*(configPath = "lucky.config.json") {
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
          })
      )
    );
  }
);

export const renderIndexHtml = Effect.fn("build.renderIndexHtml")(
  function*(config: {
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
  }
);

export const buildSite = Effect.fn("build.buildSite")(
  function*(options: BuildOptions = {}) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const dataDir = options.dataDir ?? "data";
    const outDir = options.outDir ?? "dist";
    const fileConfig = yield* loadLuckyConfig(options.configPath);

    const outDataDir = path.join(outDir, "data");
    yield* fs.makeDirectory(outDataDir, { recursive: true });

    const entries = (yield* fs.exists(dataDir))
      ? yield* fs.readDirectory(dataDir)
      : [];
    const jsonlFiles = entries
      .filter((name) => name.endsWith(".jsonl"))
      .sort((a, b) => a.localeCompare(b));

    const summaries: Array<ChannelSummary> = [];

    for (const fileName of jsonlFiles) {
      const channel = path.basename(fileName, ".jsonl");
      const posts = yield* readChannelPosts(path.join(dataDir, fileName));
      const postIds = posts.map((p) => p.id);
      const links = extractChannelLinks(posts, channel);

      const indexData: ChannelIndex = {
        channel,
        postCount: postIds.length,
        linkCount: links.length,
        posts: postIds,
        links,
      };

      yield* fs.writeFileString(
        path.join(outDataDir, `${channel}.json`),
        `${JSON.stringify(indexData, null, 2)}\n`
      );

      summaries.push({
        channel,
        postCount: postIds.length,
        linkCount: links.length,
      });
    }

    yield* fs.writeFileString(
      path.join(outDataDir, "channels.json"),
      `${JSON.stringify(summaries, null, 2)}\n`
    );

    const envDefaultChannel =
      options.defaultChannel !== undefined
        ? Option.none<string>()
        : yield* Config.option(Config.String("LUCKY_DEFAULT_CHANNEL"));
    const rawDefaultChannel =
      options.defaultChannel ??
      Option.getOrUndefined(envDefaultChannel) ??
      fileConfig.defaultChannel;

    let defaultChannel: string | null = null;
    if (rawDefaultChannel && rawDefaultChannel.trim()) {
      const normalized = yield* Effect.try({
        try: () => normalizeChannelName(rawDefaultChannel),
        catch: (cause) =>
          new InvalidChannelError({
            input: rawDefaultChannel,
            cause,
          }),
      });
      const matched = summaries.find(
        (item) => item.channel.toLowerCase() === normalized.toLowerCase()
      );
      defaultChannel = matched ? matched.channel : normalized;
    } else if (summaries.length === 1 && summaries[0]) {
      defaultChannel = summaries[0].channel;
    }

    const envDefaultMode =
      options.defaultMode !== undefined
        ? Option.none<LuckyMode>()
        : yield* Config.option(
            Config.Literals(["post", "link"], "LUCKY_DEFAULT_MODE")
          );
    const defaultMode: LuckyMode =
      options.defaultMode ??
      Option.getOrUndefined(envDefaultMode) ??
      fileConfig.defaultMode ??
      "post";

    const html = yield* renderIndexHtml({
      defaultChannel,
      defaultMode,
      channels: summaries,
    });

    yield* fs.writeFileString(path.join(outDir, "index.html"), html);

    return {
      channels: summaries,
      defaultChannel,
      defaultMode,
      outDir,
    } satisfies BuildResult;
  }
);
