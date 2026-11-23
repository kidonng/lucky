# Web 端 Referrer & Query 镜像重定向 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持在配置中预定义可信 Telegram 镜像域名，当访客通过 `?mirror=` query 参数或匹配的 `document.referrer` 访问时，将 `post` 模式重定向目标域名从 `t.me` 替换为该镜像。

**Architecture:** 在纯 TypeScript 模块 `src/mirror.ts` 中实现镜像规范化、去重与匹配逻辑（零 `effect` 依赖，前后端共用）；`src/types.ts` 与 `src/build.ts` 在构建写入 `outDir` 前校验并注入 `mirrors` 至 `#lucky-config`；`web/src/lucky.ts` 与 `web/src/App.tsx` 按 `?mirror=` > `document.referrer` > `https://t.me` 优先级解析目标地址。

**Tech Stack:** `bun` (`^1.4.4`), `bun:test`, `effect` (`^4.1.5`), Preact (`^11.2.0`), TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax: true`).

**Spec:** `.superpowers/specs/2026-11-24-web-mirror-referrer-design.md`

## Global Constraints

- `lucky.config.json` 未配置 `mirrors` 时保持完全向后兼容，默认行为仍跳转到 `https://t.me/<channel>/<id>`。
- `?m=` 已被 `mode` 占用，query 参数名称固定为 `mirror`。
- 镜像域名校验必须在创建或写入 `outDir` 之前完成。
- `web/src/lucky.ts` 与 `src/mirror.ts` 保持零 `effect` 运行时依赖，可在 `bun test` 中脱离浏览器 DOM 单测。
- 必须通过 `bun test` 与 `bun run typecheck`（`bun check && bun check -p web`）。
- Commit 信息使用 Linux Kernel 风格（`scope: Short imperative summary` + `### Problem` / `### Solution`）。

## Review Focus

1. **开放重定向防护（未在白名单内的 `?mirror=` 或 `document.referrer`）**：传入 `?mirror=evil.com` 或 `referrer="https://evil.com/path"` 时必须被安全忽略，绝不跳转到未配置域名（且当 `?mirror=` 非法但 `referrer` 在白名单内时，应安全回退匹配 `referrer` 或 `t.me`）。
2. **非法 URL 与非 HTTP(S) 协议（如 `javascript:alert(1)`、`ftp://mirror.com`、带 `user:pass@`、带 `?query`/`#hash` 或空白字符串）**：构建期 `normalizeMirrorList` 必须抛出 `InvalidMirrorError` 且不创建 `outDir`；前端 `matchConfiguredMirror` 必须安全返回 `null` 而不抛异常。
3. **大小写、默认端口与非默认端口匹配（如 `TG.EXAMPLE.COM`、`https://tg.example.com:443`、`http://localhost:8787`）**：统一按 `URL.host` 小写精确匹配，保证 `localhost:8787` 匹配 `http://localhost:8787/s/chan` 而不会误匹配 `localhost:3000`。
4. **末尾斜杠与可选路径前缀（如 `"https://tg.example.com/"` 与 `"https://tg.example.com/s/"`）**：规范化后去除末尾斜杠并保留路径前缀，生成 `https://tg.example.com/alpha/10` 或 `https://tg.example.com/s/alpha/10`（无双斜杠 `//`），并按规范化结果去重。
5. **优先级与 `link` 模式隔离**：同时存在合法 `?mirror=` 与合法 `referrer` 时，`?mirror=` 优先；`mode === "link"` 返回帖中外部链接时不受镜像配置改写。

---

### Task 1: 纯镜像规范化/匹配模块与 Schema 定义（`src/mirror.ts` & `src/types.ts`）

**Files:**

- Create: `src/mirror.ts`
- Modify: `src/types.ts:31-60`
- Test: `tests/mirror.test.ts` (create)

**Interfaces:**

- Produces in `src/mirror.ts`:
  - `export function normalizeMirrorBase(input: string): string`
  - `export function normalizeMirrorList(inputs: ReadonlyArray<string>): Array<string>`
  - `export function matchConfiguredMirror(candidate: string | null | undefined, mirrors: ReadonlyArray<string>, options?: { allowBareHost?: boolean }): string | null`
  - `export function resolveMirrorBase(params: { mirrorParam?: string | null; referrer?: string | null; mirrors?: ReadonlyArray<string> }): string | null`
- Produces in `src/types.ts`:
  - `LuckyRuntimeConfig` & `LuckyConfig` 新增 `mirrors: Schema.optional(Schema.Array(Schema.String))`
  - `export class InvalidMirrorError extends Schema.TaggedError<InvalidMirrorError>()("InvalidMirrorError", { input: Schema.String, cause: Schema.Unknown })`

- [ ] **Step 1: Write the failing tests in `tests/mirror.test.ts`**

```ts
import { describe, expect, test } from "bun:test";
import {
  matchConfiguredMirror,
  normalizeMirrorBase,
  normalizeMirrorList,
  resolveMirrorBase,
} from "../src/mirror";

describe("mirror utilities", () => {
  test("normalizeMirrorBase normalizes hosts, URLs, ports, and path prefixes", () => {
    expect(normalizeMirrorBase("tg.example.com")).toBe(
      "https://tg.example.com",
    );
    expect(normalizeMirrorBase("https://TG.EXAMPLE.COM:443/")).toBe(
      "https://tg.example.com",
    );
    expect(normalizeMirrorBase("http://localhost:8787/s/")).toBe(
      "http://localhost:8787/s",
    );
  });

  test("normalizeMirrorBase rejects blank, non-http(s), userinfo, and query/hash inputs", () => {
    for (const bad of [
      "",
      "   ",
      "ftp://tg.example.com",
      "javascript:alert(1)",
      "https://user:pass@tg.example.com",
      "https://tg.example.com/?a=1",
      "https://tg.example.com/#frag",
    ]) {
      expect(() => normalizeMirrorBase(bad)).toThrow();
    }
  });

  test("normalizeMirrorList deduplicates equivalent mirrors preserving order", () => {
    expect(
      normalizeMirrorList([
        "tg.example.com",
        "https://TG.EXAMPLE.COM/",
        "http://localhost:8787",
      ]),
    ).toEqual(["https://tg.example.com", "http://localhost:8787"]);
  });

  test("matchConfiguredMirror matches allowlisted hosts safely and ignores unlisted/malformed inputs", () => {
    const mirrors = ["https://tg.example.com/s", "http://localhost:8787"];

    expect(
      matchConfiguredMirror("https://TG.EXAMPLE.COM/s/kichann", mirrors),
    ).toBe("https://tg.example.com/s");
    expect(
      matchConfiguredMirror("http://localhost:8787/kichann", mirrors),
    ).toBe("http://localhost:8787");
    expect(
      matchConfiguredMirror("http://localhost:3000/kichann", mirrors),
    ).toBeNull();
    expect(
      matchConfiguredMirror("https://evil.com/kichann", mirrors),
    ).toBeNull();
    expect(matchConfiguredMirror("javascript:alert(1)", mirrors)).toBeNull();
    expect(matchConfiguredMirror("not-a-url", mirrors)).toBeNull();
    expect(
      matchConfiguredMirror("tg.example.com", mirrors, { allowBareHost: true }),
    ).toBe("https://tg.example.com/s");
  });

  test("resolveMirrorBase prioritizes valid mirrorParam over referrer and falls back safely", () => {
    const mirrors = ["https://m1.example.com", "https://m2.example.com"];

    expect(
      resolveMirrorBase({
        mirrorParam: "m2.example.com",
        referrer: "https://m1.example.com/kichann",
        mirrors,
      }),
    ).toBe("https://m2.example.com");

    expect(
      resolveMirrorBase({
        mirrorParam: "evil.com",
        referrer: "https://m1.example.com/kichann",
        mirrors,
      }),
    ).toBe("https://m1.example.com");

    expect(
      resolveMirrorBase({
        mirrorParam: "evil.com",
        referrer: "https://other.com/",
        mirrors,
      }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/mirror.test.ts`
Expected: FAIL because `src/mirror.ts` does not exist yet.

- [ ] **Step 3: Implement `src/mirror.ts` and update `src/types.ts`**

In `src/mirror.ts`:

- `parseCandidateUrl(raw: string, allowBareHost: boolean): URL`: trim string, reject empty; if it has `://` or matches `/^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d+(?:\/|$))/`, pass directly to `new URL(trimmed)`, otherwise prepend `"https://"` only when `allowBareHost` is true; check `protocol === "http:" || protocol === "https:"`, `!username && !password`, `host.length > 0`.
- `normalizeMirrorBase(input: string): string`: call `parseCandidateUrl(input, true)`, also reject `url.search !== "" || url.hash !== ""`, strip trailing slashes from `url.pathname` (`url.pathname.replace(/\/+$/, "")`), return `${url.origin}${cleanPath}`.
- `normalizeMirrorList(inputs: ReadonlyArray<string>): Array<string>`: normalize each entry and deduplicate by `normalized.toLowerCase()` (preserving host lowercase + path). Wait: since `cleanPath` can be case-sensitive while `origin` is already lowercased by `new URL`, deduplicate by `${url.origin}${cleanPath}` (exact `normalized` string).
- `matchConfiguredMirror(candidate, mirrors, options)`: parse `candidate` safely in `try/catch` with `allowBareHost: options?.allowBareHost ?? false`; compare `candidateUrl.host.toLowerCase()` against each mirror entry (normalizing each mirror safely in `try/catch` so runtime callers never throw on malformed config).
- `resolveMirrorBase({ mirrorParam, referrer, mirrors })`: try `matchConfiguredMirror(mirrorParam, mirrors ?? [], { allowBareHost: true })`, then fall back to `matchConfiguredMirror(referrer, mirrors ?? [], { allowBareHost: false })`.

In `src/types.ts`:

- Add `mirrors: Schema.optional(Schema.Array(Schema.String))` to `LuckyRuntimeConfig` and `LuckyConfig`.
- Add `InvalidMirrorError` extending `Schema.TaggedError<InvalidMirrorError>()("InvalidMirrorError", { input: Schema.String, cause: Schema.Unknown })` with `override get message(): string`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/mirror.test.ts`
Expected: PASS (all 5 tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/mirror.ts src/types.ts tests/mirror.test.ts
git commit -m "mirror: Add mirror normalization, matching, and config schemas"
```

---

### Task 2: 构建期镜像校验与配置注入（`src/build.ts`）

**Files:**

- Modify: `src/build.ts:1-216`
- Test: `tests/build.test.ts:25-307`

**Interfaces:**

- Consumes: `normalizeMirrorList` (`src/mirror.ts`), `InvalidMirrorError` & `LuckyConfig.mirrors` & `LuckyRuntimeConfig.mirrors` (`src/types.ts`)
- Produces in `src/build.ts`:
  - `BuildOptions.mirrors?: ReadonlyArray<string>`
  - `BuildResult.mirrors: Array<string>`
  - `buildSite` 校验 `options.mirrors ?? fileConfig.mirrors ?? []`（失败时在创建 `outDir` 前以 `InvalidMirrorError` 退出），非空时写入 `LuckyRuntimeConfig.mirrors` 并注入 `dist/index.html`。

- [ ] **Step 1: Write the failing tests in `tests/build.test.ts`**

Add tests inside `describe("buildSite", ...)`:

1. `"reads mirrors from lucky.config.json, normalizes/deduplicates them, and embeds them into dist/index.html"`
   - Writes `lucky.config.json` with `mirrors: ["tg.example.com", "https://TG.EXAMPLE.COM/", "http://localhost:8787/s/"]` and a post in `alpha.jsonl`.
   - Calls `buildSite({ dataDir, outDir, configPath })`.
   - Asserts `res.mirrors` equals `["https://tg.example.com", "http://localhost:8787/s"]` and `#lucky-config` JSON contains `mirrors: ["https://tg.example.com", "http://localhost:8787/s"]`.
2. `"fails with InvalidMirrorError before creating outDir when configured mirrors contain an invalid entry"`
   - Writes `lucky.config.json` with `mirrors: ["ftp://bad.example.com"]` (and also tests `buildSite({ ..., mirrors: ["   "] })`).
   - Calls `Effect.flip(buildSite(...))`, asserts `err._tag === "InvalidMirrorError"` and `existsSync(outDir)` is `false`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/build.test.ts`
Expected: FAIL (`InvalidMirrorError` / `mirrors` not implemented in `src/build.ts`).

- [ ] **Step 3: Update `src/build.ts`**

- Add `mirrors?: ReadonlyArray<string>` to `BuildOptions` and `mirrors: Array<string>` to `BuildResult`.
- Add helper `normalizeMirrorsEffect(inputs: ReadonlyArray<string>)` using `Effect.try` mapping errors to `InvalidMirrorError` (identifying the offending input item via validating each or catching on `normalizeMirrorBase` so `InvalidMirrorError.input` holds the exact bad item).
- Validate `mirrors` right after normalizing `normalizedRequestedChannel` (before reading `dataDir` / creating `outDir`).
- Pass `...(mirrors.length > 0 ? { mirrors } : {})` into `renderIndexHtml(...)` and return `mirrors` in `BuildResult`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/build.test.ts`
Expected: PASS (all existing and new tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/build.ts tests/build.test.ts
git commit -m "build: Validate and embed mirror configuration into runtime config"
```

---

### Task 3: 前端 Referrer & Query 镜像解析与跳转集成（`web/src/lucky.ts` & `web/src/App.tsx`）

**Files:**

- Modify: `web/src/lucky.ts:1-179`
- Modify: `web/src/App.tsx:18-143`
- Test: `web/tests/lucky.test.ts:1-171`

**Interfaces:**

- Consumes: `matchConfiguredMirror`, `normalizeMirrorBase`, `resolveMirrorBase` (`src/mirror.ts`), `LuckyRuntimeConfig` (`src/types.ts`)
- Produces in `web/src/lucky.ts`:
  - `readEmbeddedConfig`: 解析并规范化 `mirrors`（有合法条目时挂到返回对象，无则省略以保持结构简洁）
  - `resolveInitialParams(search, cfg)`: 返回 `{ resolvedChannel, resolvedMode, resolvedMirror, forceUi }`（`resolvedMirror` 为命中白名单的规范化镜像基础 URL 或 `null`）
  - `pickTargetUrl(data, mode, rng = Math.random, options?: { mirrorBase?: string | null })`
  - `resolveLuckyTarget(channel, mode, cache, options?: { fetchImpl?: typeof fetch; rng?: () => number; mirrors?: ReadonlyArray<string>; mirrorParam?: string | null; referrer?: string | null })`
  - `buildShareQuery(channel, mode, mirror?: string | null)`（传入有效 `mirror` 时附加 `&mirror=<host>`）

- [ ] **Step 1: Write the failing tests in `web/tests/lucky.test.ts`**

Update existing `resolveInitialParams` expected objects to include `resolvedMirror: null`, and add tests:

1. `readEmbeddedConfig` reads and normalizes valid `mirrors`, ignores invalid non-string or malformed mirror entries.
2. `resolveInitialParams` resolves `?mirror=tg.example.com` against `cfg.mirrors`, and returns `resolvedMirror: null` when `?mirror=evil.com` is unlisted.
3. `pickTargetUrl` and `resolveLuckyTarget`:
   - Uses matched `mirrorParam` over `referrer` in `post` mode (`"https://m2.example.com/alpha/10"`).
   - Uses matched `referrer` when `mirrorParam` is absent or unlisted (`"https://m1.example.com/s/alpha/10"`).
   - Falls back to `"https://t.me/alpha/10"` when neither matches `mirrors`.
   - Keeps `mode === "link"` returning the external link unmodified even when `mirrorParam` / `referrer` matches a mirror.
4. `buildShareQuery("my_chan", "post", "https://tg.example.com/s")` formats `"?c=my_chan&m=post&mirror=tg.example.com"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test web/tests/lucky.test.ts`
Expected: FAIL (`resolvedMirror`, `mirrors`, `mirrorBase` not implemented yet).

- [ ] **Step 3: Implement updates in `web/src/lucky.ts` and `web/src/App.tsx`**

In `web/src/lucky.ts`:

- Update `normalizeRuntimeConfig` to parse `obj.mirrors` (normalizing valid string entries via `normalizeMirrorBase` in `try/catch`, deduplicating, and attaching `mirrors` when non-empty).
- Update `resolveInitialParams` to extract `rawMirror = params.get("mirror")` and compute `resolvedMirror = matchConfiguredMirror(rawMirror, cfg.mirrors ?? [], { allowBareHost: true })`.
- Update `pickTargetUrl` to accept `options?: { mirrorBase?: string | null }` and build `${options?.mirrorBase ?? "https://t.me"}/${data.channel}/${postId}` in `post` mode.
- Update `resolveLuckyTarget` to compute `mirrorBase = resolveMirrorBase({ mirrorParam: options?.mirrorParam, referrer: options?.referrer ?? (typeof document !== "undefined" ? document.referrer : undefined), mirrors: options?.mirrors })` and pass `{ mirrorBase }` to `pickTargetUrl`.
- Update `buildShareQuery(channel, mode, mirror?: string | null)`: when `mirror` is non-empty, normalize/extract `host` if URL or use as-is, and append `&mirror=${encodeURIComponent(mirrorHost)}`.

In `web/src/App.tsx`:

- In `useEffect` and `handleLuckyClick`, pass `{ mirrors: config.mirrors, mirrorParam: initial.resolvedMirror, referrer: document.referrer }` to `resolveLuckyTarget`.
- In `handleCopyShare` and the share-links render block, pass `initial.resolvedMirror` to `buildShareQuery(selectedChannel, mode, initial.resolvedMirror)`.

- [ ] **Step 4: Run tests and typecheck to verify everything passes**

Run: `bun test && bun run typecheck`
Expected: PASS (`bun test` passes all tests across `tests/` and `web/tests/`; `bun run typecheck` exits 0 with zero errors).

- [ ] **Step 5: Commit**

```bash
git add web/src/lucky.ts web/src/App.tsx web/tests/lucky.test.ts
git commit -m "web: Support referrer and query mirror resolution for post redirects"
```

---

## Self-Review Checklist

- [x] Spec coverage: `lucky.config.json` / `BuildOptions` `mirrors`, build-time validation & `#lucky-config` injection, `?mirror=` query override + `document.referrer` fallback, `post` mode replacement, `link` mode unaffected, `?ui=1` share query preservation.
- [x] Type consistency: `normalizeMirrorBase`, `normalizeMirrorList`, `matchConfiguredMirror`, `resolveMirrorBase`, `InvalidMirrorError`, `resolvedMirror`, `mirrorBase`, `mirrorParam` match across all 3 tasks.
- [x] Review Focus coverage: All 5 failure modes/input classes have explicit test cases in `tests/mirror.test.ts`, `tests/build.test.ts`, and `web/tests/lucky.test.ts`.
