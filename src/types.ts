import { Schema } from "effect";

export const LuckyMode = Schema.Literals(["post", "link"]);
export type LuckyMode = typeof LuckyMode["Type"];

export const ChannelPost = Schema.Struct({
  id: Schema.Int,
  date: Schema.String,
  text: Schema.String,
});
export type ChannelPost = typeof ChannelPost["Type"];

export const ChannelPostJson = Schema.fromJsonString(ChannelPost);

export const ChannelIndex = Schema.Struct({
  channel: Schema.String,
  postCount: Schema.Int,
  linkCount: Schema.Int,
  posts: Schema.Array(Schema.Int),
  links: Schema.Array(Schema.String),
});
export type ChannelIndex = typeof ChannelIndex["Type"];

export const ChannelSummary = Schema.Struct({
  channel: Schema.String,
  postCount: Schema.Int,
  linkCount: Schema.Int,
});
export type ChannelSummary = typeof ChannelSummary["Type"];

export const LuckyConfig = Schema.Struct({
  channels: Schema.optional(Schema.Array(Schema.String)),
  defaultChannel: Schema.optional(Schema.String),
  defaultMode: Schema.optional(LuckyMode),
});
export type LuckyConfig = typeof LuckyConfig["Type"];

export const LuckyConfigJson = Schema.fromJsonString(LuckyConfig);

export class InvalidChannelError extends Schema.TaggedError<InvalidChannelError>()(
  "InvalidChannelError",
  {
    input: Schema.String,
    cause: Schema.Unknown,
  }
) {}

export class ConfigParseError extends Schema.TaggedError<ConfigParseError>()(
  "ConfigParseError",
  {
    path: Schema.String,
    cause: Schema.Unknown,
  }
) {}

export class StorageDecodeError extends Schema.TaggedError<StorageDecodeError>()(
  "StorageDecodeError",
  {
    path: Schema.String,
    line: Schema.Int,
    cause: Schema.Unknown,
  }
) {}

export class ScrapeHttpError extends Schema.TaggedError<ScrapeHttpError>()(
  "ScrapeHttpError",
  {
    url: Schema.String,
    status: Schema.optional(Schema.Int),
    retryable: Schema.Boolean,
    cause: Schema.Unknown,
  }
) {}

export class EmptyFullScrapeError extends Schema.TaggedError<EmptyFullScrapeError>()(
  "EmptyFullScrapeError",
  {
    channel: Schema.String,
    existingCount: Schema.Int,
  }
) {}

export class NoChannelsConfiguredError extends Schema.TaggedError<NoChannelsConfiguredError>()(
  "NoChannelsConfiguredError",
  {
    configPath: Schema.String,
  }
) {}
