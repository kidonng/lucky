# Web 端镜像重定向设计文档（Referrer & Query）

## 1. Intent & Why

为 `lucky` 的静态网页端增加可信镜像域名配置：当访客从已配置的 Telegram 镜像站跳转过来（`document.referrer` 匹配镜像域名），或通过 URL query 参数（`?mirror=...`）显式指定已预定义的镜像时，`post` 模式的随机帖子重定向将跳转到该镜像域名而非 `https://t.me`，从而在保持访客镜像站浏览体验的同时，避免无条件信任任意域名带来的开放重定向风险。

## 2. Goals, Non-Goals, and Anti-Goals

### Goals

- 在 `lucky.config.json`（及 `buildSite` 选项）中支持可选的 `mirrors` 镜像配置列表。
- 在构建期校验并规范化 `mirrors` 后注入 `index.html` 的 `#lucky-config`（`LuckyRuntimeConfig`）。
- 支持通过 URL query 参数 `?mirror=<host-or-url>` 指定使用预定义在 `mirrors` 中的镜像；未在白名单内的参数值一律忽略。
- 在前端（自动重定向与手动点击「手气不错」按钮）按优先级解析目标镜像：`?mirror=...`（且命中白名单） > `document.referrer`（且命中白名单） > 默认 `https://t.me`；命中镜像时将 `post` 模式目标地址生成为 `<mirrorBase>/<channel>/<id>`。

### Non-Goals

- 不重写 `link` 模式从帖子正文提取的第三方外部链接。
- 不在 `?ui=1` 面板中新增镜像输入框或 `localStorage` 持久化。
- 不信任未在 `mirrors` 中配置的任意 `document.referrer` 或 `?mirror=` 域名。

### Anti-Goals

- 不在构建期引入重型配置框架；沿用 `src/types.ts` + `src/build.ts` 的轻量 `Schema` 与 `Effect.fn` 约定。

## 3. Constraints

- `lucky.config.json` 未配置 `mirrors` 时保持完全向后兼容，默认行为仍跳转到 `https://t.me/<channel>/<id>`。
- `?m=` 已被 `mode` 占用，因此 query 参数使用 `mirror`（如 `/?c=kichann&mirror=tg.example.com`）。
- 镜像域名校验必须在创建/写入 `outDir` 之前完成，保持 `src/build.ts` 的先校验后输出约定。
- `web/src/lucky.ts` 保持零 `effect` 运行时依赖、可脱离浏览器 DOM 在 `bun test` 中单测。

## 4. Approaches Considered

- **方案 A（已选定）**：在 `lucky.config.json` 配置 `mirrors` 列表并在构建时注入 `#lucky-config`，前端通过 `?mirror=` 与 `document.referrer` 匹配白名单。优势：访客从镜像站或带 query 的分享链接进入 `/` / `/?c=...` 时即可立即生效，且只允许白名单内镜像，安全性高。
- **方案 B（未选）**：仅在 `?ui=1` 页面提供输入框并保存至 `localStorage`。劣势：首次从镜像站点击直跳链接的访客未打开过面板，无法提前配置。
- **方案 C（未选）**：配置白名单 + `?ui=1` 面板手动覆盖/预览。劣势：当前需求无需额外 UI 交互，后续如有需要可在现有配置基础上增量扩展。

## 5. Detailed Design

### 5.1 配置与 Schema（`src/types.ts` & `src/build.ts`）

- `LuckyConfig` 与 `LuckyRuntimeConfig` 新增可选字段 `mirrors: Schema.optional(Schema.Array(Schema.String))`。
- `BuildOptions` 新增可选字段 `mirrors?: ReadonlyArray<string>`（便于程序化调用及测试传入）。
- 镜像规范化规则：
  - 支持填写域名（如 `"tg.example.com"`）或完整 URL（如 `"https://tg.example.com"`、`"http://localhost:8787"`、`"https://tg.example.com/s"`）。
  - 若无协议前缀，默认补全 `https://`；使用 `new URL(...)` 解析，仅允许 `http:` / `https:` 且 `host` 非空；去除 query、hash 与末尾多余 `/`（保留可选路径前缀如 `/s`）。
  - 按 `host` + `pathname` 小写去重；若存在非法条目，在构建写入 `outDir` 前以 `InvalidMirrorError`（`Schema.TaggedError`）失败。
- 当最终 `mirrors` 非空时写入 `LuckyRuntimeConfig.mirrors` 并注入 `#lucky-config`；为空时省略以保持现有输出结构兼容。

### 5.2 前端匹配与跳转（`web/src/lucky.ts` & `web/src/App.tsx`）

- `normalizeRuntimeConfig`：读取并规范化 `mirrors`（无效或缺失时回退为空数组 `[]`）。
- 镜像匹配工具（`matchConfiguredMirror(candidate, mirrors)` / `resolveMirrorBase({ mirrorParam, referrer, mirrors })`）：
  - 对候选值（query 参数或 `document.referrer`）按 URL 解析（query 参数若不含协议可补全 `https://` 再解析；`referrer` 必须自带 `http:`/`https:`），提取 `host.toLowerCase()`。
  - 与 `mirrors` 中各项解析后的 `host.toLowerCase()` 精确匹配，命中则返回该镜像规范化后的基础 URL（如 `"https://tg.example.com"`）。
  - 解析优先级：先尝试匹配 `mirror` query 参数；若未提供或未命中白名单，再尝试匹配 `document.referrer`；均未命中返回 `null`。
- `resolveInitialParams(search, cfg)`：
  - 新增解析 `mirror` query 参数，返回 `resolvedMirror: string | null`（若提供且命中 `cfg.mirrors` 则返回规范化后的镜像基础 URL，否则为 `null`；为保持向后兼容，可作为新增字段返回）。
- `pickTargetUrl(data, mode, rng, options?)` 与 `resolveLuckyTarget(channel, mode, cache, options?)`：
  - 支持传入 `mirrorBase`（或 `mirrors` + `mirrorParam` + `referrer`）。
  - `mode === "post"` 时：若解析得到 `mirrorBase`，返回 `${mirrorBase}/${data.channel}/${postId}`；否则返回 `https://t.me/${data.channel}/${postId}`。
- `App.tsx` 中自动重定向与点击按钮均通过 `resolveLuckyTarget` 获取目标，并传入 `initial.resolvedMirror`、`config.mirrors` 与 `document.referrer`。若通过 `?ui=1&mirror=...` 进入面板，分享链接 `buildShareQuery` 也会保留有效的 `mirror` 参数。
