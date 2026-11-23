# Effect v4 Lightweight Refactor (`lucky`) Design Document

## 1. Intent & Why

Refactor `lucky`'s I/O, HTTP, configuration/storage validation, error handling, and CLI layers onto Effect v4 (`effect` + `@effect/platform-bun`), while keeping the `unified`-based pure text-processing core (`src/parser.ts`, `src/links.ts`) and static web template (`src/index.html`) untouched as pure logic.

This achieves cleaner error boundaries, schema-validated external data, declarative retry/backoff via `Schedule`, built-in `effect/cli` parsing, and unified Effect-layer testability without introducing heavy custom `Context.Service` boilerplate.

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Schema-backed Domain & Config (`src/types.ts`)**: Model `LuckyMode`, `ChannelPost`, `ChannelIndex`, `ChannelSummary`, and `LuckyConfig` with `effect/Schema`, and define typed domain failures with `Schema.TaggedError`.
- **Effect Platform I/O (`src/storage.ts`, `src/build.ts`)**: Use `FileSystem.FileSystem`, `Path.Path`, and `Config` (`Config.String` / `Config.Literals`) instead of direct `node:fs` / `process.env` access.
- **Effect HTTP & Retry (`src/scrape.ts`)**: Replace manual `fetch`, `setTimeout`, and `for`-loop retries with `HttpClient.HttpClient`, `Effect.sleep`, and `Schedule` (`Effect.retry`), and run multi-channel scraping via `Effect.forEach`.
- **Effect CLI (`src/cli.ts`)**: Replace manual `argv` parsing with `effect/cli` (`Command`, `Argument`, `Flag`) executed on `BunServices.layer` + `BunHttpClient.layer` via `BunRuntime.runMain`.
- **Test Isolation & `bun test` Continuity**: Keep `bun test` as the test runner, adapt I/O tests to Effect layers, and fix the existing `tests/build.test.ts` failure where `buildSite` unintentionally reads the repository's `lucky.config.json`.

### Non-Goals
- Wrapping `src/parser.ts` or `src/links.ts` (`unified` pipelines) in `Effect` or `Context.Service`.
- Modifying `src/index.html` or changing redirect / UI behavior.
- Changing the on-disk format of `data/<channel>.jsonl` (`{"id":...,"date":"...","text":"..."}`, sorted ascending by `id`) or the JSON schema of `dist/data/*.json`.

### Anti-Goals
- Creating custom `Context.Service` + `Layer` wrappers for internal domain functions (`PostStorage`, `TelegramScraper`, `SiteBuilder`) where plain `Effect.fn` functions consuming standard Effect platform services suffice.
- Replacing clear pagination loops with `Stream.paginate` or rewriting small JSONL files through `Stream` + `Ndjson` channels just for the sake of using streams.

## 3. Constraints
- **Runtime & Toolchain**: `bun` (managed via `mise`), TypeScript `strict: true` with `noUncheckedIndexedAccess: true` and `verbatimModuleSyntax: true` in `tsconfig.json`.
- **Effect v4 APIs**: Strictly use Effect `^4.1.5` and `@effect/platform-bun` `^4.1.5` APIs documented in `node_modules/effect/AGENTS.md` and `node_modules/@effect/platform-bun/AGENTS.md`.
- **CI & CLI Compatibility**: Existing scripts and `.github/workflows/lucky.yml` invocations must continue to work unchanged:
  - `bun run scrape [channels...] [--full|-f] [--data-dir <dir>] [--config <path>] [--delay <ms>]`
  - `bun run build [--data-dir <dir>] [--out-dir <dir>] [--config <path>] [--default-channel <name>] [--default-mode <post|link>]`

## 4. Approaches Considered

### Approach A: Lightweight `Effect.fn` + `Schema` + Standard Platform Services (Selected)
- **How it works**: Keep `parser.ts` and `links.ts` pure. Model domain/config types and tagged errors with `Schema`. Implement `storage.ts`, `scrape.ts`, and `build.ts` as `Effect.fn` functions requiring `FileSystem.FileSystem`, `Path.Path`, and `HttpClient.HttpClient`. Implement `cli.ts` with `effect/cli` + `BunServices.layer` + `BunHttpClient.layer` + `BunRuntime.runMain`.
- **Trade-offs**: Minimal boilerplate, directly exercises the valuable parts of Effect v4 (`Schema`, `FileSystem`, `HttpClient`, `Schedule`, `Config`, `effect/cli`), and remains simple to test in `bun test`.

### Approach B: Full Custom `Context.Service` + `Stream` / `Ndjson` Pipeline
- **How it works**: Wrap storage, scraper, and builder into `Context.Service` classes with static layers, stream JSONL via `Ndjson`, and model pagination with `Stream.paginate`.
- **Trade-offs**: Rejected as over-engineered for a ~800-LOC CLI tool, adding indirection without meaningful architectural gain.

## 5. Architecture & Detailed Design

### 5.1 Pure Core Boundary (`src/parser.ts`, `src/links.ts`)
- `src/parser.ts` and `src/links.ts` remain synchronous pure TypeScript modules with no `effect` imports.
- `normalizeChannelName(input: string): string` stays pure in `src/parser.ts` so `tests/parser.test.ts` and `tests/links.test.ts` remain unchanged. Effectful callers (`scrape.ts`, `build.ts`) wrap `normalizeChannelName` via `Effect.try({ try: () => normalizeChannelName(input), catch: (cause) => new InvalidChannelError({ input, cause }) })`.

### 5.2 Domain Schemas & Errors (`src/types.ts`)
Define schemas and inferred types:
- `LuckyMode = Schema.Literals(["post", "link"])`
- `ChannelPost = Schema.Struct({ id: Schema.Int, date: Schema.String, text: Schema.String })`
- `ChannelIndex = Schema.Struct({ channel: Schema.String, postCount: Schema.Int, linkCount: Schema.Int, posts: Schema.Array(Schema.Int), links: Schema.Array(Schema.String) })`
- `ChannelSummary = Schema.Struct({ channel: Schema.String, postCount: Schema.Int, linkCount: Schema.Int })`
- `LuckyConfig = Schema.Struct({ channels: Schema.optional(Schema.Array(Schema.String)), defaultChannel: Schema.optional(Schema.String), defaultMode: Schema.optional(LuckyMode) })`

Define typed domain errors with `Schema.TaggedError`:
- `InvalidChannelError`: `{ input: string, cause: unknown }`
- `ConfigParseError`: `{ path: string, cause: unknown }`
- `StorageDecodeError`: `{ path: string, line: number, cause: unknown }`
- `ScrapeHttpError`: `{ url: string, status?: number, retryable: boolean, cause: unknown }`
- `EmptyFullScrapeError`: `{ channel: string, existingCount: number }`
- `NoChannelsConfiguredError`: `{ configPath: string }`

### 5.3 Storage (`src/storage.ts`)
- Keep `serializePostJsonlLine(post: ChannelPost): string` (producing exact `{"id":...,"date":"...","text":"..."}` key order).
- `readChannelPosts(jsonlPath: string)`: `Effect.fn("storage.readChannelPosts")` requiring `FileSystem.FileSystem`.
  - If `!(yield* fs.exists(jsonlPath))`, return `[]`.
  - Read file via `fs.readFileString(jsonlPath)`.
  - Split non-empty lines and decode each with `Schema.decodeUnknownEffect(Schema.fromJsonString(ChannelPost))`, mapping parse/validation errors to `StorageDecodeError` with 1-based `line`.
  - Deduplicate by `id` and return posts sorted ascending by `id`.
- `writeChannelPosts(jsonlPath: string, posts: ReadonlyArray<ChannelPost>)`: `Effect.fn("storage.writeChannelPosts")` requiring `FileSystem.FileSystem | Path.Path`.
  - Ensure parent directory exists via `fs.makeDirectory(path.dirname(jsonlPath), { recursive: true })`.
  - Deduplicate by `id`, sort ascending by `id`, serialize lines with trailing newline when non-empty, and write via `fs.writeFileString`.

### 5.4 Scraper (`src/scrape.ts`)
- `fetchTelegramPage(url: string)`: `Effect.fn("scrape.fetchTelegramPage")` requiring `HttpClient.HttpClient`.
  - Executes `client.get(url, { headers: { accept: "text/html" } })`.
  - Inspects `response.status`:
    - `200..299`: reads `response.text`.
    - `429` or `>= 500`: fails with `ScrapeHttpError({ url, status: response.status, retryable: true, cause: ... })`.
    - Other non-2xx: fails with `ScrapeHttpError({ url, status: response.status, retryable: false, cause: ... })`.
  - Maps transient `HttpClientError` transport/request failures to `ScrapeHttpError({ url, retryable: true, cause })`.
  - Retries with `Effect.retry` using `Schedule.exponential("300 millis")` capped with `Schedule.recurs(2)` (up to 3 total attempts) and gated by `Schedule.while(({ input }) => input.retryable)`.
- `scrapeChannel(options: ScrapeOptions)`: `Effect.fn("scrape.scrapeChannel")` requiring `FileSystem.FileSystem | Path.Path | HttpClient.HttpClient`.
  - Preserves existing backward (`?before=<lowestId>`) full/mirror scrape and forward (`?after=<maxId>`) incremental scrape semantics, including `EmptyFullScrapeError` protection when `--full` fetches 0 posts for a non-empty existing file.
  - Uses `Effect.sleep(Duration.millis(delayMs))` between page requests when `fetchedPages > 0 && delayMs > 0`.
  - Writes updated JSONL via `writeChannelPosts` and returns `ScrapeResult`.
- `scrapeChannels(channels: ReadonlyArray<string>, options)`: `Effect.fn("scrape.scrapeChannels")` iterating with `Effect.forEach(..., { concurrency: options.concurrency ?? 1 })` (defaulting to sequential `1` to be polite to `t.me/s/`).

### 5.5 Builder (`src/build.ts`)
- `loadLuckyConfig(configPath = "lucky.config.json")`: `Effect.fn("build.loadLuckyConfig")` requiring `FileSystem.FileSystem`.
  - Returns `{}` when `!yield* fs.exists(configPath)`.
  - Reads string and decodes via `Schema.decodeUnknownEffect(Schema.fromJsonString(LuckyConfig))`, mapping errors to `ConfigParseError`.
- `renderIndexHtml(config)`: `Effect.fn("build.renderIndexHtml")` requiring `FileSystem.FileSystem | Path.Path`.
  - Resolves `./index.html` via `path.fromFileUrl(new URL("./index.html", import.meta.url))`, reads template via `fs.readFileString`, and injects `<`-escaped JSON in place of `__LUCKY_CONFIG_JSON__`.
- `buildSite(options: BuildOptions = {})`: `Effect.fn("build.buildSite")` requiring `FileSystem.FileSystem | Path.Path`.
  - Scans `dataDir` via `fs.exists` and `fs.readDirectory`, sorts `*.jsonl` filenames, reads posts with `readChannelPosts`, extracts links with pure `extractChannelLinks`, writes `dist/data/<channel>.json` and `dist/data/channels.json` via `fs.writeFileString`.
  - Resolves `defaultChannel` from `options.defaultChannel` → `Config.option(Config.String("LUCKY_DEFAULT_CHANNEL"))` → `fileConfig.defaultChannel` → single-channel fallback, normalizing case against built channels.
  - Resolves `defaultMode` from `options.defaultMode` → `Config.option(Config.Literals(["post", "link"], "LUCKY_DEFAULT_MODE"))` → `fileConfig.defaultMode` → `"post"`.
  - Renders and writes `dist/index.html`, returning `BuildResult`.

### 5.6 CLI (`src/cli.ts`)
- Define `scrapeCommand` (`Command.make("scrape", ...)`):
  - `channels`: `Argument.String("channels").pipe(Argument.variadic())`
  - `full`: `Flag.Boolean("full").pipe(Flag.withAlias("f"), Flag.withDefault(false))`
  - `dataDir`: `Flag.String("data-dir").pipe(Flag.withDefault("data"))`
  - `config`: `Flag.String("config").pipe(Flag.withDefault("lucky.config.json"))`
  - `delay`: `Flag.Int("delay").pipe(Flag.withDefault(250))`
  - Handler: if `channels.length === 0`, loads config via `loadLuckyConfig(config)`; if still empty, fails with `NoChannelsConfiguredError({ configPath: config })`. Otherwise runs `scrapeChannels` and logs each result via `Console.log`.
- Define `buildCommand` (`Command.make("build", ...)`):
  - `dataDir`: `Flag.String("data-dir").pipe(Flag.withDefault("data"))`
  - `outDir`: `Flag.String("out-dir").pipe(Flag.withDefault("dist"))`
  - `config`: `Flag.String("config").pipe(Flag.withDefault("lucky.config.json"))`
  - `defaultChannel`: `Flag.String("default-channel").pipe(Flag.optional)`
  - `defaultMode`: `Flag.Literals("default-mode", ["post", "link"]).pipe(Flag.optional)`
  - Handler: calls `buildSite` and logs summary via `Console.log`.
- Root command `luckyCommand = Command.make("lucky").pipe(Command.withSubcommands([scrapeCommand, buildCommand]))`.
- Export `runCli = Command.runWith(luckyCommand, { version: "0.1.0" })` for programmatic / test execution.
- Main entrypoint (`if (import.meta.main)`): `luckyCommand.pipe(Command.run({ version: "0.1.0" }), Effect.provide(Layer.mergeAll(BunServices.layer, BunHttpClient.layer)), BunRuntime.runMain)`.

### 5.7 Testing Strategy (`tests/*.test.ts`)
- `tests/parser.test.ts` and `tests/links.test.ts` remain unchanged.
- `tests/scrape.test.ts`: runs `scrapeChannel` via `Effect.runPromise` provided with `BunServices.layer` and a mock `HttpClient` layer (`Layer.succeed(HttpClient.HttpClient, HttpClient.make(...))`). Add test coverage for retry on HTTP `429`/`500` and fail-fast on `404`.
- `tests/build.test.ts`: pass an isolated `configPath: join(tempDir, "lucky.config.json")` to the test case that previously leaked into the repo's `lucky.config.json`, run `buildSite` via `Effect.runPromise` with `BunServices.layer`, and add coverage for `ConfigProvider` env overrides (`LUCKY_DEFAULT_CHANNEL`, `LUCKY_DEFAULT_MODE`) and invalid `lucky.config.json` (`ConfigParseError`).
- `tests/cli.test.ts`: run `runCli([...])` via `Effect.runPromise` with `BunServices.layer` and mock `HttpClient` layer, asserting `build` subcommand outputs and `NoChannelsConfiguredError` when `scrape` has no channels.
