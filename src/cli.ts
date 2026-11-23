import { BunHttpClient, BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { buildSite, loadLuckyConfig } from "./build";
import { scrapeChannels } from "./scrape";
import { NoChannelsConfiguredError } from "./types";

const scrapeCommand = Command.make(
  "scrape",
  {
    channels: Argument.String("channels").pipe(
      Argument.withDescription("Public Telegram channel usernames or URLs"),
      Argument.variadic()
    ),
    full: Flag.Boolean("full").pipe(
      Flag.withAlias("f"),
      Flag.withDescription("Perform full mirror scrape replacing existing JSONL"),
      Flag.withDefault(false)
    ),
    dataDir: Flag.String("data-dir").pipe(
      Flag.withDescription("Directory containing channel JSONL files"),
      Flag.withDefault("data")
    ),
    config: Flag.String("config").pipe(
      Flag.withDescription("Path to lucky.config.json"),
      Flag.withDefault("lucky.config.json")
    ),
    delay: Flag.Int("delay").pipe(
      Flag.withDescription("Delay in milliseconds between paginated requests"),
      Flag.withDefault(250)
    ),
    concurrency: Flag.Int("concurrency").pipe(
      Flag.withDescription("Maximum concurrent channels to scrape"),
      Flag.withDefault(1)
    ),
  },
  Effect.fn("cli.scrape")(function*({
    channels,
    full,
    dataDir,
    config,
    delay,
    concurrency,
  }) {
    let targets: ReadonlyArray<string> = channels;
    if (targets.length === 0) {
      const cfg = yield* loadLuckyConfig(config);
      targets = cfg.channels ?? (cfg.defaultChannel ? [cfg.defaultChannel] : []);
    }

    if (targets.length === 0) {
      return yield* new NoChannelsConfiguredError({ configPath: config });
    }

    const results = yield* scrapeChannels(targets, {
      dataDir,
      full,
      delayMs: delay,
      concurrency,
    });

    for (const res of results) {
      yield* Console.log(
        `[scrape] @${res.channel} (${res.mode}): ${res.fetchedPages} page(s), +${res.addedOrUpdatedCount} updated/new, ${res.totalCount} total posts -> ${res.filePath}`
      );
    }
  })
).pipe(Command.withDescription("Scrape public Telegram channels into data/*.jsonl"));

const buildCommand = Command.make(
  "build",
  {
    dataDir: Flag.String("data-dir").pipe(
      Flag.withDescription("Directory containing channel JSONL files"),
      Flag.withDefault("data")
    ),
    outDir: Flag.String("out-dir").pipe(
      Flag.withDescription("Output directory for the built static site"),
      Flag.withDefault("dist")
    ),
    config: Flag.String("config").pipe(
      Flag.withDescription("Path to lucky.config.json"),
      Flag.withDefault("lucky.config.json")
    ),
    defaultChannel: Flag.String("default-channel").pipe(
      Flag.withDescription("Default channel for root redirects"),
      Flag.optional
    ),
    defaultMode: Flag.Literals("default-mode", ["post", "link"]).pipe(
      Flag.withDescription("Default redirect mode (post or link)"),
      Flag.optional
    ),
  },
  Effect.fn("cli.build")(function*({
    dataDir,
    outDir,
    config,
    defaultChannel,
    defaultMode,
  }) {
    const res = yield* buildSite({
      dataDir,
      outDir,
      configPath: config,
      defaultChannel: Option.getOrUndefined(defaultChannel),
      defaultMode: Option.getOrUndefined(defaultMode),
    });

    yield* Console.log(
      `[build] Built ${res.channels.length} channel(s) into ${res.outDir} (defaultChannel=${res.defaultChannel ?? "none"}, defaultMode=${res.defaultMode})`
    );
  })
).pipe(Command.withDescription("Build static redirect site and JSON indexes"));

export const luckyCommand = Command.make("lucky").pipe(
  Command.withDescription("Telegram public channel I'm Feeling Lucky CLI"),
  Command.withSubcommands([scrapeCommand, buildCommand])
);

export const runCli = Command.runWith(luckyCommand, {
  version: "0.1.0",
  renderErrors: false,
});

if (import.meta.main) {
  luckyCommand.pipe(
    Command.run({ version: "0.1.0" }),
    Effect.provide(Layer.mergeAll(BunServices.layer, BunHttpClient.layer)),
    BunRuntime.runMain
  );
}
