# Telegram Channel "I'm Feeling Lucky" (`lucky`) Design Document

## 1. Intent & Why

Build a general-purpose, zero-server-cost "I'm Feeling Lucky" tool for public Telegram channels. Primarily serving the author's personal public channel while remaining reusable for any public channel, it enables visitors (via a link in a channel bio or shared with friends) to immediately jump to either:

1. A random post in the channel (`post` mode).
2. A random external link mentioned inside any of the channel's posts (`link` mode).

Raw channel post data is stored as clean, append/diff-friendly JSONL files in the repository so the dataset remains easy to inspect, version, and reuse for future ideas.

## 2. Goals, Non-Goals, and Anti-Goals

### Goals

- **Initial & Incremental Collection**: Scrape all historical posts of a given public Telegram channel (`https://t.me/s/<channel>`) without API keys or Telegram account credentials, and incrementally fetch only newer posts on subsequent runs.
- **Clean Source Storage (JSONL)**: Persist scraped post metadata (`id`, `date`, Markdown `text`) in `data/<channel>.jsonl`, sorted ascending by post `id`.
- **Build-Time Link Extraction & Static Bundle**: Compile `data/*.jsonl` at build time into compact JSON index files (`dist/data/<channel>.json`) containing post IDs and extracted links, plus a static web frontend (`dist/index.html`) supporting configurable default `channel` and `mode`.
- **Two Redirect Modes**:
  - `post`: Redirects visitor to `https://t.me/<channel>/<id>`.
  - `link`: Redirects visitor to a randomly chosen URL extracted from the channel's posts.

### Non-Goals

- Tracking post edit timestamps (`edit_date` is omitted since `t.me/s/<channel>` does not expose reliable edit metadata).
- Scraping private channels or requiring MTProto/Bot API credentials.
- Real-time on-demand scraping of arbitrary unindexed channels from the browser.

### Anti-Goals

- Heavy frontend frameworks or multi-megabyte client bundles that slow down redirect latency.
- Storing derived `links` arrays inside the source `.jsonl` files.

## 3. Constraints

- **Static Hosting Compatible**: The built artifact (`dist/`) must run on static hosts (GitHub Pages, Cloudflare Pages, Vercel, or any static file server) with no backend runtime required at visit time.
- **Deterministic, Git-Friendly Data**: `data/<channel>.jsonl` must have one JSON object per line, ordered by ascending `id`, with no duplicate post IDs.

## 4. Approaches Considered

### Approach A: TypeScript (`mise` + `bun` + `bun:test`) + `unified` Ecosystem + Static Web (Selected)

- **How it works**: A TypeScript project managed by `mise` and running on `bun` (with tests in `bun:test`), providing two CLI commands (`scrape` and `build`). `scrape` fetches `t.me/s/<channel>`, parses page HTML and converts `.tgme_widget_message_text` HTML to Markdown via the `unified` ecosystem (`rehype-parse` → `rehype-remark` → `remark-stringify`), and writes `data/<channel>.jsonl`. `build` reads `data/*.jsonl`, parses Markdown via `unified` (`remark-parse` + `remark-gfm` AST walk) to reliably extract all links, writes compact `dist/data/<channel>.json` (`{ channel, postCount, linkCount, posts: number[], links: string[] }`), and generates `dist/index.html` with baked-in default `channel` and `mode`.
- **Trade-offs**: Unified AST pipeline handles both HTML→Markdown conversion and Markdown→URL extraction without fragile regexes; single runtime (`bun`) for CLI, build, and `bun:test`; ~90% smaller network payload for visitors compared to loading raw JSONL in the browser.

### Approach B: Python Scraper + Browser-Side JSONL Parsing

- **How it works**: Python scripts maintain `data/<channel>.jsonl`, and the static webpage fetches the raw `.jsonl` directly in the browser to parse links on the fly.
- **Trade-offs**: Rejected because downloading full post text in the browser degrades redirect speed as a channel grows to thousands of posts.

### Approach C: Python Scraper & Builder + Static HTML

- **How it works**: Same architecture as Approach A, but using Python for the CLI and build script.
- **Trade-offs**: Viable, but Approach A was chosen by the user for a unified TypeScript toolchain.

## 5. Architecture & Detailed Design

### 5.1 Source Data Format (`data/<channel>.jsonl`)

Each line is a valid UTF-8 JSON object with exact keys order `id`, `date`, `text`:

```json
{
  "id": 1,
  "date": "2024-01-15T08:30:00+00:00",
  "text": "Hello world! Check out [Example](https://example.com) and https://foo.bar"
}
```

- `id` (`number`): Telegram post message ID (parsed from `data-post="<channel>/<id>"`).
- `date` (`string`): ISO-8601 timestamp from `<time datetime="...">` in the post footer.
- `text` (`string`): Message text converted from `.tgme_widget_message_text` HTML into Markdown. Media-only posts without a text block have `text: ""` (still stored so `post` mode can land on media-only posts). Service messages (e.g., "Channel created", "Channel photo updated" without a standard message date/content widget) are skipped.

### 5.2 HTML-to-Markdown Conversion Rules (`unified`: `rehype` → `remark`)

Telegram web preview uses a constrained HTML subset inside `.tgme_widget_message_text`, converted to Markdown via a `unified` pipeline (`rehype-parse` → custom hast transform → `rehype-remark` → `remark-stringify`):

- `<br>` / `<br/>` → line break (`\n`)
- `<a href="...">label</a>`:
  - Ignore hashtag search links (`href` starting with `?q=%23`) by unwrapping the `<a>` into plain text `#tag`.
  - Resolve protocol-relative URLs (`//...` → `https://...`).
  - Allow `remark-stringify` (and GFM autolinks) to serialize standard `[label](href)` or bare URLs cleanly, properly escaping/encoding parentheses in `href` so round-trip parsing is lossless.
- Inline and block formatting (`<b>`, `<strong>`, `<i>`, `<em>`, `<code>`, `<pre>`, `<s>`, `<del>`, `<blockquote>`): handled natively by `rehype-remark` + `remark-gfm` + `remark-stringify`.

### 5.3 Scraping Logic (`scrape` command)

- **Input**: One or more channel identifiers (e.g., `bun run scrape <channel>` or configured channels list). Channel identifier is normalized (strips leading `@` or `https://t.me/(s/)?`).
- **Initial Full Scrape & Mirror Replacement** (when `data/<channel>.jsonl` does not exist or `--full` is passed):
  1. Fetch `https://t.me/s/<channel>`.
  2. Parse all message widgets on the page.
  3. Find the minimum post `id` seen so far (`minId`).
  4. Loop fetching `https://t.me/s/<channel>?before=<minId>` until a page returns no posts with `id < minId` or `minId <= 1`.
  5. Deduplicate by `id`, sort ascending by `id`, and **overwrite** `data/<channel>.jsonl` with the freshly scraped snapshot (mirror replacement semantics: deleted posts disappear and edited posts are refreshed).
- **Incremental Update** (default when `data/<channel>.jsonl` exists and is non-empty, and `--full` is not passed):
  1. Read existing `data/<channel>.jsonl` and determine `maxId` (highest existing post `id`).
  2. Loop fetching `https://t.me/s/<channel>?after=<maxId>`, updating `maxId` to the highest `id` returned on each page, until a response returns no posts with `id > maxId`.
  3. Merge new posts (`id > existing maxId`) with existing posts, sort ascending by `id`, and write back `data/<channel>.jsonl`.
- **Politeness & Resilience (Builder's Call)**: Includes configurable request delay between pagination requests (default ~300ms) and retry with backoff on transient network / 429 errors.

### 5.4 Build-Time Processing & Link Extraction (`build` command)

The build script scans `data/*.jsonl` and produces the static site in `dist/`:

1. **Link Extraction (`unified`: `remark-parse` + `remark-gfm`)**:
   For each post's `text`:
   - Parse the Markdown `text` into an mdast syntax tree using `unified().use(remarkParse).use(remarkGfm)`.
   - Traverse mdast `link` (and `definition`) nodes (`node.url`) to collect all explicit and autolinked URLs.
   - **Filtering & Normalization**:
     - Parse candidate URLs with `new URL(rawUrl)`; keep only valid `http:` and `https:` URLs.
     - Exclude internal self-links pointing to the same Telegram channel (`t.me/<channel>`, `t.me/<channel>/<id>`, `t.me/s/<channel>...`, `telegram.me/<channel>...`, case-insensitive). Links to _other_ Telegram channels/bots/posts or external websites are kept.
   - **Pooling**: Deduplicate normalized URLs (`new URL(u).toString()`) across the channel so every unique link has equal probability (preserving first-seen order).
2. **Generated Static Data**:
   - `dist/data/channels.json`: List of available channels and counts (`[{ "channel": "foo", "postCount": 120, "linkCount": 85 }]`).
   - `dist/data/<channel>.json`:
     ```json
     {
       "channel": "foo",
       "postCount": 120,
       "linkCount": 85,
       "posts": [1, 2, 3],
       "links": ["https://example.com", "https://..."]
     }
     ```

3. **Default Configuration (`channel` & `mode`)**:
   Configurable via a simple config file (`lucky.config.json`) and/or environment variables (`LUCKY_DEFAULT_CHANNEL`, `LUCKY_DEFAULT_MODE`):
   ```json
   {
     "channels": ["example_channel"],
     "defaultChannel": "example_channel",
     "defaultMode": "post"
   }
   ```
   - `defaultChannel`: string (optional; if omitted and only one channel exists in `data/`, defaults to that single channel).
   - `defaultMode`: `"post"` | `"link"` (defaults to `"post"`).

### 5.5 Frontend & Redirect Behavior (`dist/index.html`)

A single lightweight HTML page with inline CSS/JS:

- **Parameter Resolution**:
  - `channel` = URL query `?channel=<name>` (or alias `?c=<name>`) ?? `config.defaultChannel` (or the sole available channel).
  - `mode` = URL query `?mode=post|link` (or alias `?m=post|link`) ?? `config.defaultMode` (`"post"`).
  - `ui` = URL query `?ui=1` (forces staying on the interactive control page without auto-redirecting).
- **Auto-Redirect Flow**:
  - When `channel` is resolved and `?ui=1` is **not** set:
    1. Fetch `./data/<channel>.json`.
    2. Pick a uniform random element from `posts` (if `mode === "post"`, building `https://t.me/<channel>/<id>`) or `links` (if `mode === "link"`).
    3. Immediately redirect via `window.location.replace(targetUrl)` (also showing a clickable fallback link on screen in case redirect is blocked or slow).
    4. If the selected pool is empty (e.g., 0 links in `link` mode), display a clear message and offer to jump to a random post instead.
- **Interactive UI Mode** (when `?ui=1` is passed, or when no default channel can be resolved):
  - Displays a clean, minimal card allowing the visitor to choose a channel (from `channels.json`), pick `随机帖子 (Post)` or `帖中链接 (Link)`, click "手气不错 / I'm Feeling Lucky" to jump, or copy the direct auto-redirect share URLs (`?c=...&m=post` and `?c=...&m=link`).

## 6. Toolchain & What's Left to the Builder

- **Toolchain**: `mise` (`mise.toml` pinning `bun`), `bun` runtime & package manager, `bun:test` for unit/integration tests, and `unified` (`rehype-parse`, `rehype-remark`, `remark-parse`, `remark-gfm`, `remark-stringify`, `unist-util-visit`, `hast-util-select` / `hast-util-to-text`) for HTML and Markdown AST processing.
- Exact project directory layout (`src/scrape.ts`, `src/build.ts`, `src/markdown.ts`, `src/links.ts`, `src/web.ts`, etc.).
- Optional GitHub Actions workflow template (`.github/workflows/update.yml`) for scheduled incremental scraping and Pages deployment.
