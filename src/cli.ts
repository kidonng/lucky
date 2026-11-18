import { buildSite, loadLuckyConfig } from "./build";
import { scrapeChannel } from "./scrape";
import type { LuckyMode } from "./types";

function parseModeFlag(value: string | undefined): LuckyMode | undefined {
  if (value === "post" || value === "link") {
    return value;
  }
  return undefined;
}

export async function runCli(argv: string[]): Promise<number> {
  const command = argv[0];
  const args = argv.slice(1);

  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(
      [
        "Usage:",
        "  bun run scrape [channels...] [--full] [--data-dir <dir>] [--config <path>] [--delay <ms>]",
        "  bun run build [--data-dir <dir>] [--out-dir <dir>] [--config <path>] [--default-channel <name>] [--default-mode <post|link>]",
      ].join("\n")
    );
    return 0;
  }

  if (command === "scrape") {
    const channels: string[] = [];
    let full = false;
    let dataDir = "data";
    let configPath = "lucky.config.json";
    let delayMs = 250;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (!arg) continue;

      if (arg === "--full" || arg === "-f") {
        full = true;
      } else if (arg === "--data-dir" && args[i + 1]) {
        dataDir = args[++i]!;
      } else if (arg === "--config" && args[i + 1]) {
        configPath = args[++i]!;
      } else if (arg === "--delay" && args[i + 1]) {
        delayMs = Number.parseInt(args[++i]!, 10);
      } else if (!arg.startsWith("-")) {
        channels.push(arg);
      }
    }

    let targets = channels;
    if (targets.length === 0) {
      const cfg = await loadLuckyConfig(configPath);
      targets = cfg.channels ?? (cfg.defaultChannel ? [cfg.defaultChannel] : []);
    }

    if (targets.length === 0) {
      console.error(
        "No channels specified. Pass channel names to `bun run scrape <channel>` or configure `channels` in lucky.config.json."
      );
      return 1;
    }

    for (const channel of targets) {
      const res = await scrapeChannel({
        channel,
        dataDir,
        full,
        delayMs,
      });
      console.log(
        `[scrape] @${res.channel} (${res.mode}): ${res.fetchedPages} page(s), +${res.addedOrUpdatedCount} updated/new, ${res.totalCount} total posts -> ${res.filePath}`
      );
    }

    return 0;
  }

  if (command === "build") {
    let dataDir = "data";
    let outDir = "dist";
    let configPath = "lucky.config.json";
    let defaultChannel: string | undefined;
    let defaultMode: LuckyMode | undefined;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (!arg) continue;

      if (arg === "--data-dir" && args[i + 1]) {
        dataDir = args[++i]!;
      } else if (arg === "--out-dir" && args[i + 1]) {
        outDir = args[++i]!;
      } else if (arg === "--config" && args[i + 1]) {
        configPath = args[++i]!;
      } else if (arg === "--default-channel" && args[i + 1]) {
        defaultChannel = args[++i]!;
      } else if (arg === "--default-mode" && args[i + 1]) {
        defaultMode = parseModeFlag(args[++i]);
      }
    }

    const res = await buildSite({
      dataDir,
      outDir,
      configPath,
      defaultChannel,
      defaultMode,
    });

    console.log(
      `[build] Built ${res.channels.length} channel(s) into ${res.outDir} (defaultChannel=${res.defaultChannel ?? "none"}, defaultMode=${res.defaultMode})`
    );
    return 0;
  }

  console.error(`Unknown subcommand: ${command}`);
  return 1;
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
}
