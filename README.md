# Telegram 频道手气不错 (`lucky`)

为公开 Telegram 频道设计的“手气不错（I'm Feeling Lucky）”工具，无需 Telegram API Key，分为**数据收集**与**数据展示**两部分：

- **数据收集 (`bun run scrape`)**：支持首次全量抓取与 `--full` 镜像更新（沿着 `t.me/s/<channel>?before=<id>` 向后翻页），以及日常增量更新（沿着 `?after=<maxId>` 向前翻页）。每条帖子通过 `unified` (`rehype` → `remark`) 转为 Markdown，以按 `id` 升序的 JSONL 格式保存在 `data/<channel>.jsonl`（仅存 `id`, `date`, `text`）。
- **数据展示 (`bun run build`)**：构建时通过 `unified` (`remark-parse` + `remark-gfm`) 遍历 Markdown AST 提取所有外部链接（自动过滤指向本频道自身的内部链接），生成紧凑索引 `dist/data/<channel>.json` 与静态页面 `dist/index.html`。
  - **随机帖子模式 (`mode=post`)**：将访客重定向至 `https://t.me/<channel>/<id>`。
  - **帖中链接模式 (`mode=link`)**：将访客重定向至从帖子文本中提取出的随机外部链接。

## 快速开始

使用 `mise` + `bun`：

```bash
mise install
bun install

# 1. 抓取指定公开频道（首次自动全量抓取，后续运行自动增量更新）
bun run scrape <channel_name>

# 如需全量重抓（镜像覆盖，清理已删除的旧帖并同步修改）：
bun run scrape <channel_name> --full

# 2. 构建静态网页（支持指定默认 channel 与默认 mode）
bun run build --default-channel <channel_name> --default-mode post
```

也可以在 `lucky.config.json` 中固化配置：

```json
{
  "channels": ["your_channel"],
  "defaultChannel": "your_channel",
  "defaultMode": "post"
}
```

## 网页 URL 参数

部署 `dist/` 到 GitHub Pages / Cloudflare Pages 后：

- `/`：直接按构建时配置的 `defaultChannel` 与 `defaultMode` 立即重定向。
- `/?c=<channel>&m=post`（或 `?channel=<channel>&mode=post`）：随机跳转到该频道的一条帖子。
- `/?c=<channel>&m=link`（或 `?channel=<channel>&mode=link`）：随机跳转到该频道帖子中包含的一个外部链接。
- `/?ui=1`：停留在可视化面板页面，方便手动切换频道、切换模式或复制分享链接。
