# Effect v4 Lightweight Refactor (`lucky`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `lucky`'s data modeling, JSONL storage, HTTP scraping/retry, site building, and CLI layers onto Effect v4 (`effect` + `@effect/platform-bun`) while keeping `src/parser.ts`, `src/links.ts`, and `src/index.html` pure and unchanged.

**Architecture:** `src/parser.ts` and `src/links.ts` stay synchronous pure TypeScript (`unified` ecosystem). `src/types.ts` defines `effect/Schema` models and `Schema.TaggedError` failures; `src/storage.ts`, `src/scrape.ts`, and `src/build.ts` expose lightweight `Effect.fn` functions consuming Effect's standard `FileSystem`, `Path`, `HttpClient`, and `Config` services; `src/cli.ts` wires subcommands via `effect/cli` on `BunServices.layer` + `BunHttpClient.layer` + `BunRuntime.runMain`.

**Tech Stack:** `mise`, `bun` (`^1.4.4`), `bun:test`, `effect` (`^4.1.5`), `@effect/platform-bun` (`^4.1.5`), `unified` (unchanged).

**Spec:** `.superpowers/specs/2026-11-23-effect-refactor-design.md`

## Global Constraints

- Managed with `mise` (`mise.toml` pinning `bun`), executed with `bun`, tested with `bun:test`.
- TypeScript `strict: true`, `noUncheckedIndexedAccess: true`, and `verbatimModuleSyntax: true` (`tsconfig.json`) must pass `bunx tsc --noEmit`.
- Use Effect `^4.1.5` and `@effect/platform-bun` `^4.1.5` APIs from `node_modules/effect/AGENTS.md` (`Effect.fn`, `Effect.gen`, `Schema.TaggedError`, `FileSystem.FileSystem`, `Path.Path`, `HttpClient.HttpClient`, `Config`, `Schedule`, `effect/cli`, `BunServices.layer`, `BunHttpClient.layer`, `BunRuntime.runMain`).
- `src/parser.ts`, `src/links.ts`, `src/index.html`, `tests/parser.test.ts`, and `tests/links.test.ts` MUST NOT import `effect` or change behavior.
- Source JSONL records in `data/<channel>.jsonl` MUST contain exact key order `id`, `date`, `text`, sorted ascending by `id` with no duplicates.
- Commit messages MUST use Linux Kernel style (`scope: Short imperative summary` + `### Problem` / `### Solution` / `### References`).

## Review Focus

1. **Malformed JSONL line in `data/<channel>.jsonl`**: `readChannelPosts` must fail with `StorageDecodeError` (carrying `path` and 1-based `line`) on invalid JSON or schema mismatch, while blank/trailing lines are ignored.
2. **Missing vs invalid `lucky.config.json`**: `loadLuckyConfig` must return `{}` when the file does not exist, and fail with `ConfigParseError` when the file exists with malformed JSON or invalid fields (e.g. `defaultMode: "bad"`).
3. **Environment config overrides & invalid env values**: `buildSite` must resolve `options` → `Config` (`LUCKY_DEFAULT_CHANNEL`, `LUCKY_DEFAULT_MODE`) → `lucky.config.json` → single-channel/`"post"` fallback, and fail with a typed config error when `LUCKY_DEFAULT_MODE` is invalid rather than silently ignoring it.
4. **Retryable vs non-retryable HTTP errors & empty full-scrape guard**: `fetchTelegramPage` must retry `429`, `>= 500`, and transient transport failures up to 3 total attempts (`Schedule.recurs(2)`), fail immediately on `404` without retrying, and `scrapeChannel` must fail with `EmptyFullScrapeError` without overwriting non-empty JSONL if `--full` yields 0 posts.
5. **Invalid channel names & invalid CLI flags**: Invalid channel identifiers passed to `scrape` or `build --default-channel` must fail in the typed error channel with `InvalidChannelError`; invalid CLI flags (e.g. `--delay abc`, `--default-mode bad`) must be rejected cleanly by `effect/cli`.

---

### Task 1: Domain Schemas & Typed Errors (`src/types.ts`)

**Files:**

- Modify: `src/types.ts:1-27`
- Test: `tests/types.test.ts` (create)

**Interfaces:**

- Produces in `src/types.ts`:
  - Schemas & Types:
    - `export const LuckyMode: Schema.Literals<readonly ["post", "link"]>` and `export type LuckyMode = typeof LuckyMode["Type"]`
    - `export const ChannelPost: Schema.Struct<{ id: typeof Schema.Int; date: typeof Schema.String; text: typeof Schema.String }>` and `export type ChannelPost = typeof ChannelPost["Type"]`
    - `export const ChannelPostJson: Schema.fromJsonString<typeof ChannelPost>`
    - `export const ChannelIndex`, `export type ChannelIndex = typeof ChannelIndex["Type"]`
    - `export const ChannelSummary`, `export type ChannelSummary = typeof ChannelSummary["Type"]`
    - `export const LuckyConfig` (with `Schema.optional` on `channels`, `defaultChannel`, `defaultMode`), `export type LuckyConfig = typeof LuckyConfig["Type"]`
    - `export const LuckyConfigJson: Schema.fromJsonString<typeof LuckyConfig>`
  - Errors (`Schema.TaggedError`):
    - `InvalidChannelError` (`{ input: string; cause: unknown }`)
    - `ConfigParseError` (`{ path: string; cause: unknown }`)
    - `StorageDecodeError` (`{ path: string; line: number; cause: unknown }`)
    - `ScrapeHttpError` (`{ url: string; status: Schema.optional(Schema.Int); retryable: boolean; cause: unknown }`)
    - `EmptyFullScrapeError` (`{ channel: string; existingCount: number }`)
    - `NoChannelsConfiguredError` (`{ configPath: string }`)

- [ ] **Step 1: Write failing tests in `tests/types.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  ChannelPostJson,
  InvalidChannelError,
  LuckyConfigJson,
} from "../src/types";

describe("types & schemas", () => {
  test("ChannelPostJson decodes valid JSON line and rejects non-int id", () => {
    const decode = Schema.decodeUnknownSync(ChannelPostJson);
    expect(
      decode('{"id":1,"date":"2024-01-01T00:00:00Z","text":"hi"}'),
    ).toEqual({
      id: 1,
      date: "2024-01-01T00:00:00Z",
      text: "hi",
    });
    expect(() =>
      decode('{"id":1.5,"date":"2024-01-01T00:00:00Z","text":"hi"}'),
    ).toThrow();
  });

  test("LuckyConfigJson validates defaultMode literals and allows empty object", () => {
    const decode = Schema.decodeUnknownSync(LuckyConfigJson);
    expect(decode("{}")).toEqual({});
    expect(() => decode('{"defaultMode":"invalid"}')).toThrow();
  });

  test("Tagged errors expose _tag discriminant", () => {
    const err = new InvalidChannelError({
      input: "bad",
      cause: new Error("invalid"),
    });
    expect(err._tag).toBe("InvalidChannelError");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `mise exec bun -- bun test tests/types.test.ts`
Expected: FAIL (`ChannelPostJson` / `InvalidChannelError` not exported from `../src/types`)

- [ ] **Step 3: Implement schemas and tagged errors in `src/types.ts`**

Define `LuckyMode`, `ChannelPost`, `ChannelPostJson`, `ChannelIndex`, `ChannelSummary`, `LuckyConfig`, `LuckyConfigJson`, and the 6 `Schema.TaggedError` classes (`InvalidChannelError`, `ConfigParseError`, `StorageDecodeError`, `ScrapeHttpError`, `EmptyFullScrapeError`, `NoChannelsConfiguredError`) using `Schema.Unknown` for `cause` fields and `Schema.Defect()` where appropriate.

- [ ] **Step 4: Run test and typecheck to verify they pass**

Run: `mise exec bun -- bun test tests/types.test.ts && mise exec bun -- bunx tsc --noEmit`
Expected: PASS (3 pass, 0 type errors)

- [ ] **Step 5: Commit**

```bash
git add src/types.ts tests/types.test.ts
git commit -m "types: model domain types and errors with Effect Schema"
```

(Use full Linux Kernel commit body per Global Constraints.)

---

### Task 2: Effectful JSONL Storage (`src/storage.ts`)

**Files:**

- Modify: `src/storage.ts:1-68`
- Test: `tests/storage.test.ts` (create)

**Interfaces:**

- Consumes: `src/types.ts` (`ChannelPost`, `ChannelPostJson`, `StorageDecodeError`)
- Produces in `src/storage.ts`:
  - `export function serializePostJsonlLine(post: ChannelPost): string`
  - `export const readChannelPosts: (jsonlPath: string) => Effect.Effect<Array<ChannelPost>, StorageDecodeError | PlatformError.PlatformError, FileSystem.FileSystem>`
  - `export const writeChannelPosts: (jsonlPath: string, posts: ReadonlyArray<ChannelPost>) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>`

- [ ] **Step 1: Write failing tests in `tests/storage.test.ts`**

Cover:

1. Reading a non-existent file returns `[]`.
2. Writing unsorted/duplicate posts creates parent directories, deduplicates by `id`, sorts ascending by `id`, preserves exact key order `id,date,text`, and ignores blank lines on read.
3. Reading a file containing a malformed JSONL line fails with `StorageDecodeError` carrying `{ path, line: 2 }`.
   Run each effect via `Effect.runPromise(program.pipe(Effect.provide(BunServices.layer)))` using `Effect.exit` / `Cause` or `Effect.flip` for failure assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `mise exec bun -- bun test tests/storage.test.ts`
Expected: FAIL (`readChannelPosts` returns a Promise instead of an Effect)

- [ ] **Step 3: Implement `src/storage.ts` using `Effect.fn`, `FileSystem.FileSystem`, `Path.Path`, and `ChannelPostJson`**

Use `Schema.decodeUnknownEffect(ChannelPostJson)` per non-empty line, mapping errors via `Effect.mapError((cause) => new StorageDecodeError({ path: jsonlPath, line: index + 1, cause }))`. Keep `serializePostJsonlLine` pure with `{ id: post.id, date: post.date, text: post.text }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `mise exec bun -- bun test tests/storage.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/storage.ts tests/storage.test.ts
git commit -m "storage: migrate JSONL persistence to Effect FileSystem and Schema"
```

---

### Task 3: Effectful Telegram Scraper (`src/scrape.ts`)

**Files:**

- Modify: `src/scrape.ts:1-182`
- Modify: `tests/scrape.test.ts:1-150`

**Interfaces:**

- Consumes:
  - `src/parser.ts` (`normalizeChannelName`, `parseChannelPageHtml`)
  - `src/storage.ts` (`readChannelPosts`, `writeChannelPosts`)
  - `src/types.ts` (`ChannelPost`, `EmptyFullScrapeError`, `InvalidChannelError`, `ScrapeHttpError`)
- Produces in `src/scrape.ts`:
  - `export interface ScrapeOptions { channel: string; dataDir?: string; full?: boolean; delayMs?: number }`
  - `export interface ScrapeResult { channel: string; mode: "full" | "incremental"; fetchedPages: number; addedOrUpdatedCount: number; totalCount: number; filePath: string }`
  - `export const fetchTelegramPage: (url: string) => Effect.Effect<string, ScrapeHttpError, HttpClient.HttpClient>`
  - `export const scrapeChannel: (options: ScrapeOptions) => Effect.Effect<ScrapeResult, InvalidChannelError | ScrapeHttpError | EmptyFullScrapeError | StorageDecodeError | PlatformError.PlatformError, FileSystem.FileSystem | Path.Path | HttpClient.HttpClient>`
  - `export const scrapeChannels: (channels: ReadonlyArray<string>, options?: { dataDir?: string; full?: boolean; delayMs?: number; concurrency?: number }) => Effect.Effect<Array<ScrapeResult>, InvalidChannelError | ScrapeHttpError | EmptyFullScrapeError | StorageDecodeError | PlatformError.PlatformError, FileSystem.FileSystem | Path.Path | HttpClient.HttpClient>`

- [ ] **Step 1: Update `tests/scrape.test.ts` with mock `HttpClient` Layer and new retry/error tests**

- Replace `fetcher` callbacks with a helper `makeMockHttpClientLayer(handler: (url: string) => { status: number; body: string } | Error)` built via `Layer.succeed(HttpClient.HttpClient, HttpClient.make(...))` returning `HttpClientResponse.fromWeb(request, new Response(body, { status }))` (or `Effect.fail(new HttpClientError.TransportError(...))` / `Effect.die` / rejected promise inside `HttpClient.make`).
- Keep existing 4 test behaviors (initial full scrape, incremental scrape, `--full` mirror replacement, `EmptyFullScrapeError` refusing to wipe existing posts).
- Add tests for:
  1. HTTP `429` then `200` retries and succeeds; 3 consecutive `500` responses fail with `ScrapeHttpError` (`attempts === 3`).
  2. HTTP `404` fails immediately on attempt 1 with `ScrapeHttpError` (`retryable: false`, `attempts === 1`).
  3. Invalid channel string fails with `InvalidChannelError`.

- [ ] **Step 2: Run test to verify it fails**

Run: `mise exec bun -- bun test tests/scrape.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/scrape.ts` with `HttpClient`, `Schedule`, `Effect.sleep`, and `Effect.forEach`**

- Wrap `normalizeChannelName` with `Effect.try` → `InvalidChannelError`.
- In `fetchTelegramPage`, execute `client.get(url, { headers: { accept: "text/html" } })`, map `HttpClientError` transport/request failures to `ScrapeHttpError({ url, retryable: true, cause })`, check `response.status` (`429` / `>= 500` → `retryable: true`; other `!ok` → `retryable: false`; `2xx` → `response.text`), and apply `Effect.retry(Schedule.exponential("300 millis").pipe(Schedule.both(Schedule.recurs(2)), Schedule.while(({ input }) => input.retryable)))` (or `Schedule.min`/`Schedule.max` per `node_modules/effect/ai-docs/src/06_schedule/10_schedules.ts`: `Schedule.exponential("300 millis").pipe(Schedule.upTo({ times: 2 }), Schedule.setInputType<ScrapeHttpError>(), Schedule.while(({ input }) => input.retryable))`). Verify exact `Schedule` combinator behavior in `tests/scrape.test.ts`!
- In `scrapeChannel`, use `Effect.sleep(Duration.millis(delayMs))` when `fetchedPages > 0 && delayMs > 0`.
- Implement `scrapeChannels` using `Effect.forEach(channels, (channel) => scrapeChannel({ ...options, channel }), { concurrency: options?.concurrency ?? 1 })`.

- [ ] **Step 4: Run test to verify it passes**

Run: `mise exec bun -- bun test tests/scrape.test.ts`
Expected: PASS (all scrape tests pass)

- [ ] **Step 5: Commit**

```bash
git add src/scrape.ts tests/scrape.test.ts
git commit -m "scrape: migrate HTTP fetching and retries to Effect HttpClient and Schedule"
```

---

### Task 4: Effectful Site Builder & Config Loader (`src/build.ts`)

**Files:**

- Modify: `src/build.ts:1-146`
- Modify: `tests/build.test.ts:1-203`

**Interfaces:**

- Consumes:
  - `src/links.ts` (`extractChannelLinks`)
  - `src/parser.ts` (`normalizeChannelName`)
  - `src/storage.ts` (`readChannelPosts`)
  - `src/types.ts` (`ChannelIndex`, `ChannelSummary`, `ConfigParseError`, `InvalidChannelError`, `LuckyConfig`, `LuckyConfigJson`, `LuckyMode`)
- Produces in `src/build.ts`:
  - `export interface BuildOptions { dataDir?: string; outDir?: string; configPath?: string; defaultChannel?: string; defaultMode?: LuckyMode }`
  - `export interface BuildResult { channels: Array<ChannelSummary>; defaultChannel: string | null; defaultMode: LuckyMode; outDir: string }`
  - `export const loadLuckyConfig: (configPath?: string) => Effect.Effect<LuckyConfig, ConfigParseError | PlatformError.PlatformError, FileSystem.FileSystem>`
  - `export const renderIndexHtml: (config: { defaultChannel: string | null; defaultMode: LuckyMode; channels: ReadonlyArray<ChannelSummary> }) => Effect.Effect<string, PlatformError.PlatformError | BadArgument, FileSystem.FileSystem | Path.Path>`
  - `export const buildSite: (options?: BuildOptions) => Effect.Effect<BuildResult, ConfigParseError | InvalidChannelError | StorageDecodeError | ConfigError | PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>`

- [ ] **Step 1: Update `tests/build.test.ts` to run Effects, isolate `configPath`, and test env/error cases**

- Fix the existing failing test (`compiles data/*.jsonl into dist/data/*.json, channels.json, and dist/index.html with default config`) by passing `configPath: join(tempDir, "lucky.config.json")` (non-existent in tempDir) so it does not leak into the repo's root `lucky.config.json`.
- Update existing `buildSite` calls to run via `Effect.runPromise(...pipe(Effect.provide(BunServices.layer)))`.
- Add tests for:
  1. `loadLuckyConfig` failing with `ConfigParseError` on malformed JSON or invalid `defaultMode`.
  2. `buildSite` honoring `LUCKY_DEFAULT_CHANNEL` and `LUCKY_DEFAULT_MODE` provided via `ConfigProvider.layer(ConfigProvider.fromEnvRecord(...))`, and failing cleanly when `LUCKY_DEFAULT_MODE` is invalid.
  3. `buildSite` failing with `InvalidChannelError` when `defaultChannel` is invalid.

- [ ] **Step 2: Run test to verify it fails**

Run: `mise exec bun -- bun test tests/build.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/build.ts` using `FileSystem.FileSystem`, `Path.Path`, `Config`, and `LuckyConfigJson`**

- Read template in `renderIndexHtml` using `path.fromFileUrl(new URL("./index.html", import.meta.url))` + `fs.readFileString`.
- Resolve env fallbacks with `Config.option(Config.String("LUCKY_DEFAULT_CHANNEL"))` and `Config.option(Config.Literals(["post", "link"], "LUCKY_DEFAULT_MODE"))` (note: `Config.option` turns missing config into `Option.none()` while preserving schema/invalid-value errors as `ConfigError`).
- Normalize `rawDefaultChannel` with `Effect.try` → `InvalidChannelError`.

- [ ] **Step 4: Run test to verify it passes**

Run: `mise exec bun -- bun test tests/build.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/build.ts tests/build.test.ts
git commit -m "build: migrate site builder and config loading to Effect FileSystem and Config"
```

---

### Task 5: `effect/cli` Entrypoint & Full Verification (`src/cli.ts`)

**Files:**

- Modify: `src/cli.ts:1-124`
- Modify: `tests/cli.test.ts:1-55`

**Interfaces:**

- Consumes:
  - `src/build.ts` (`buildSite`, `loadLuckyConfig`)
  - `src/scrape.ts` (`scrapeChannels`)
  - `src/types.ts` (`NoChannelsConfiguredError`)
- Produces in `src/cli.ts`:
  - `export const luckyCommand: Command<...>`
  - `export const runCli: (args: ReadonlyArray<string>) => Effect.Effect<void, ...>` (built via `Command.runWith(luckyCommand, { version: "0.1.0" })`)

- [ ] **Step 1: Update `tests/cli.test.ts` for `runCli` (`Command.runWith`)**

- Test `build` subcommand (`["build", "--data-dir", dataDir, "--out-dir", outDir, "--default-channel", "mychan", "--default-mode", "link"]`) succeeds and writes `dist/index.html`.
- Test `scrape` subcommand with empty `channels` in `--config` fails with `NoChannelsConfiguredError`.
- Test invalid `--delay abc` or `--default-mode bad` fails via `CliError`.
- Test `scrape testchan --data-dir ... --delay 0` executes `scrapeChannels` using a mock `HttpClient` layer.

- [ ] **Step 2: Run test to verify it fails**

Run: `mise exec bun -- bun test tests/cli.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `src/cli.ts` with `effect/cli`, `BunServices.layer`, `BunHttpClient.layer`, and `BunRuntime.runMain`**

- `scrapeCommand`: `Argument.String("channels").pipe(Argument.variadic())`, `--full` (`-f`), `--data-dir`, `--config`, `--delay`, optional `--concurrency` (default `1`).
- `buildCommand`: `--data-dir`, `--out-dir`, `--config`, `--default-channel` (`Flag.optional`), `--default-mode` (`Flag.Literals("default-mode", ["post", "link"]).pipe(Flag.optional)`).
- Wire `luckyCommand` with `Command.withSubcommands([scrapeCommand, buildCommand])`.
- Export `runCli = Command.runWith(luckyCommand, { version: "0.1.0" })`.
- Guard `if (import.meta.main)` with `luckyCommand.pipe(Command.run({ version: "0.1.0" }), Effect.provide(Layer.mergeAll(BunServices.layer, BunHttpClient.layer)), BunRuntime.runMain)`.

- [ ] **Step 4: Run full test suite, typecheck, and CLI smoke checks**

Run:

1. `mise exec bun -- bun test`
2. `mise exec bun -- bunx tsc --noEmit`
3. `mise exec bun -- bun run src/cli.ts --help`
4. `mise exec bun -- bun run build --out-dir /tmp/lucky-smoke-dist`
   Expected: All tests across all 6 test files pass; `tsc --noEmit` exits 0; `--help` prints generated `effect/cli` help; smoke build succeeds into `/tmp/lucky-smoke-dist` (clean up `/tmp/lucky-smoke-dist` afterward).

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "cli: migrate command parsing and runtime to effect/cli and BunRuntime"
```
