# AGENTS.md

Guidance for coding agents and contributors working in `lucky`.

## Project Overview

`lucky` is a zero-API-key "I'm Feeling Lucky" static site generator and scraper for public Telegram channels (`https://t.me/s/<channel>`):

1. **Scrape (`bun run scrape`)**: Fetches public Telegram channel web preview pages, converts message HTML to Markdown via `unified`, and stores sorted JSONL records (`id`, `date`, `text`) in `data/<channel>.jsonl`. Supports backward full/mirror scrapes (`--full` or initial run via `?before=`) and forward incremental updates (`?after=`).
2. **Build (`bun run build`)**: Reads `data/*.jsonl`, extracts external HTTP(S) links from Markdown ASTs (filtering out links pointing back to the same channel), writes compact indexes (`dist/data/<channel>.json`, `dist/data/channels.json`), and injects config into `src/index.html` → `dist/index.html` supporting `post` and `link` redirect modes plus `?ui=1`.

## Toolchain & Commands

Managed by `mise` (`mise.toml` pins `bun`) and `bun`:

- Install dependencies: `bun install --frozen-lockfile`
- Scrape configured channels: `bun run scrape` (or `bun run scrape <channel...> [--full|-f] [--data-dir <dir>] [--config <path>] [--delay <ms>] [--concurrency <n>]`)
- Build static site: `bun run build [--data-dir <dir>] [--out-dir <dir>] [--config <path>] [--default-channel <name>] [--default-mode <post|link>]`
- Run tests: `bun test`
- Type check: `bun check`
- Format code: `bun fmt`

## Architecture & Module Boundaries

The codebase intentionally splits a **pure synchronous core** from an **Effect v4 (`^4.1.5`) I/O & CLI shell** (following `node_modules/effect/AGENTS.md` and `node_modules/@effect/platform-bun/AGENTS.md`):

### Pure Core (Keep Pure, No `effect` Imports)

- `src/parser.ts`: `normalizeChannelName`, `messageHtmlToMarkdown`, `parseChannelPageHtml` (`unified` with `rehype-parse` → custom hast normalization → `rehype-remark` → `remark-gfm` → `remark-stringify`).
- `src/links.ts`: `extractLinksFromMarkdown`, `extractChannelLinks` (`remark-parse` + `remark-gfm` AST walk, stripping self-channel links on `t.me` / `telegram.me` / `telegram.dog`).
- `src/index.html`: Zero-dependency static frontend template with `__LUCKY_CONFIG_JSON__` placeholder.

### Effect v4 Shell (Lightweight `Effect.fn` + `Schema`, No Custom `Context.Service` Boilerplate)

- `src/types.ts`: `effect/Schema` domain models (`LuckyMode`, `ChannelPost`, `ChannelPostJson`, `ChannelIndex`, `ChannelSummary`, `LuckyConfig`, `LuckyConfigJson`) and 6 `Schema.TaggedError` classes with descriptive `.message` getters (`InvalidChannelError`, `ConfigParseError`, `StorageDecodeError`, `ScrapeHttpError`, `EmptyFullScrapeError`, `NoChannelsConfiguredError`).
- `src/storage.ts`: `serializePostJsonlLine`, `readChannelPosts`, `writeChannelPosts` using `FileSystem.FileSystem`, `Path.Path`, and `ChannelPostJson`. Preserves exact `id,date,text` key order and ascending `id` sort.
- `src/scrape.ts`: `fetchTelegramPage`, `scrapeChannel`, `scrapeChannels` using `HttpClient.HttpClient`, `Schedule.exponential("300 millis")` + `Schedule.upTo({ times: 2 })` (retries `429`, `>= 500`, and transport errors up to 3 total attempts; fails fast on other non-2xx), `Effect.sleep`, and `Effect.forEach` (`concurrency` defaults to `1`). Guarded by `EmptyFullScrapeError` so `--full` never wipes non-empty existing data if 0 posts are returned.
- `src/build.ts`: `loadLuckyConfig`, `renderIndexHtml`, `buildSite` using `FileSystem.FileSystem`, `Path.Path`, and `Config` (`LUCKY_DEFAULT_CHANNEL`, `LUCKY_DEFAULT_MODE`). Validates config, env/CLI overrides, and all `data/*.jsonl` channel basenames before creating or writing `outDir`.
- `src/cli.ts`: `effect/cli` (`Command`, `Argument`, `Flag`) wired to `BunServices.layer` + `BunHttpClient.layer` + `BunRuntime.runMain`. Exports `luckyCommand` and `runCli` (`Command.runWith`) for in-process testing.

## Configuration, Data & CI

- `lucky.config.json`: Configures `channels`, `defaultChannel`, and `defaultMode` (currently tracking `kichann` in `data/kichann.jsonl`).
- `.github/workflows/lucky.yml`: Runs on a 12-hour schedule (`0 */12 * * *`), `workflow_dispatch` (optional `full` input), and pushes to `main` — runs `bun install --frozen-lockfile`, scrapes channels, commits `data/*.jsonl` changes, builds `dist/`, and deploys to GitHub Pages.
- `.superpowers/specs/` and `.superpowers/plans/`: Design specifications and implementation plans (not `docs/superpowers/`).

## Testing Conventions

- Tests live in `tests/*.test.ts` and run under `bun:test`.
- `tests/parser.test.ts` and `tests/links.test.ts` test pure synchronous functions directly.
- Effectful tests provide `BunServices.layer`, mock `HttpClient` layers via `HttpClient.make` + `HttpClientResponse.fromWeb` (`tests/scrape.test.ts`, `tests/cli.test.ts`), and `ConfigProvider.layer(ConfigProvider.fromEnvRecord(...))` (`tests/build.test.ts`).
- Always pass an isolated `configPath` inside a temp directory when testing `buildSite` or `runCli` so tests do not accidentally read the repository's root `lucky.config.json`.
