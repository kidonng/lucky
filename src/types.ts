import { Schema } from "effect";

export const LuckyMode = Schema.Literals(["post", "link"]);
export type LuckyMode = (typeof LuckyMode)["Type"];

export const ChannelPost = Schema.Struct({
  id: Schema.Int,
  date: Schema.String,
  text: Schema.String,
});
export type ChannelPost = (typeof ChannelPost)["Type"];

export const ChannelPostJson = Schema.fromJsonString(ChannelPost);

export const ChannelIndex = Schema.Struct({
  channel: Schema.String,
  postCount: Schema.Int,
  linkCount: Schema.Int,
  posts: Schema.Array(Schema.Int),
  links: Schema.Array(Schema.String),
});
export type ChannelIndex = (typeof ChannelIndex)["Type"];

export const ChannelSummary = Schema.Struct({
  channel: Schema.String,
  postCount: Schema.Int,
  linkCount: Schema.Int,
});
export type ChannelSummary = (typeof ChannelSummary)["Type"];

export const LuckyRuntimeConfig = Schema.Struct({
  defaultChannel: Schema.NullOr(Schema.String),
  defaultMode: LuckyMode,
  channels: Schema.Array(ChannelSummary),
});
export type LuckyRuntimeConfig = (typeof LuckyRuntimeConfig)["Type"];

export const LuckyRuntimeConfigJson = Schema.fromJsonString(LuckyRuntimeConfig);

export const LuckyConfig = Schema.Struct({
  channels: Schema.optional(Schema.Array(Schema.String)),
  defaultChannel: Schema.optional(Schema.String),
  defaultMode: Schema.optional(LuckyMode),
});
export type LuckyConfig = (typeof LuckyConfig)["Type"];

export const LuckyConfigJson = Schema.fromJsonString(LuckyConfig);

export class InvalidChannelError extends Schema.TaggedError<InvalidChannelError>()(
  "InvalidChannelError",
  {
    input: Schema.String,
    cause: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Invalid Telegram channel identifier: ${JSON.stringify(this.input)}`;
  }
}

export class ConfigParseError extends Schema.TaggedError<ConfigParseError>()(
  "ConfigParseError",
  {
    path: Schema.String,
    cause: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Failed to parse config at ${this.path}: ${String(this.cause)}`;
  }
}

export class StorageDecodeError extends Schema.TaggedError<StorageDecodeError>()(
  "StorageDecodeError",
  {
    path: Schema.String,
    line: Schema.Int,
    cause: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Failed to decode JSONL post at ${this.path}:${this.line}: ${String(this.cause)}`;
  }
}

export class ScrapeHttpError extends Schema.TaggedError<ScrapeHttpError>()(
  "ScrapeHttpError",
  {
    url: Schema.String,
    status: Schema.optional(Schema.Int),
    retryable: Schema.Boolean,
    cause: Schema.Unknown,
  },
) {
  override get message(): string {
    return this.status !== undefined
      ? `HTTP ${this.status} fetching ${this.url}`
      : `Network error fetching ${this.url}: ${String(this.cause)}`;
  }
}

export class EmptyFullScrapeError extends Schema.TaggedError<EmptyFullScrapeError>()(
  "EmptyFullScrapeError",
  {
    channel: Schema.String,
    existingCount: Schema.Int,
  },
) {
  override get message(): string {
    return `Full scrape for channel "${this.channel}" returned no posts; refusing to overwrite existing ${this.existingCount} posts`;
  }
}

export class NoChannelsConfiguredError extends Schema.TaggedError<NoChannelsConfiguredError>()(
  "NoChannelsConfiguredError",
  {
    configPath: Schema.String,
  },
) {
  override get message(): string {
    return `No channels specified. Pass channel names to \`bun run scrape <channel>\` or configure \`channels\` in ${this.configPath}.`;
  }
}
