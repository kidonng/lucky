import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  ChannelPostJson,
  ConfigParseError,
  EmptyFullScrapeError,
  InvalidChannelError,
  LuckyConfigJson,
  NoChannelsConfiguredError,
  ScrapeHttpError,
  StorageDecodeError,
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

  test("Tagged errors expose _tag discriminant and informative messages", () => {
    const invalidChan = new InvalidChannelError({
      input: "bad",
      cause: new Error("invalid"),
    });
    expect(invalidChan._tag).toBe("InvalidChannelError");
    expect(invalidChan.message).toContain("bad");

    const configErr = new ConfigParseError({
      path: "lucky.config.json",
      cause: new Error("syntax"),
    });
    expect(configErr.message).toContain("lucky.config.json");

    const storageErr = new StorageDecodeError({
      path: "data/a.jsonl",
      line: 4,
      cause: new Error("decode"),
    });
    expect(storageErr.message).toContain("data/a.jsonl");
    expect(storageErr.message).toContain("4");

    const httpErr = new ScrapeHttpError({
      url: "https://t.me/s/a",
      status: 503,
      retryable: true,
      cause: new Error("503"),
    });
    expect(httpErr.message).toContain("https://t.me/s/a");
    expect(httpErr.message).toContain("503");

    const emptyErr = new EmptyFullScrapeError({
      channel: "a",
      existingCount: 10,
    });
    expect(emptyErr.message).toContain("a");
    expect(emptyErr.message).toContain("10");

    const noChanErr = new NoChannelsConfiguredError({
      configPath: "lucky.config.json",
    });
    expect(noChanErr.message).toContain("lucky.config.json");
  });
});
