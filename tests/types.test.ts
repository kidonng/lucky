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
    expect(decode('{"id":1,"date":"2024-01-01T00:00:00Z","text":"hi"}')).toEqual({
      id: 1,
      date: "2024-01-01T00:00:00Z",
      text: "hi",
    });
    expect(() => decode('{"id":1.5,"date":"2024-01-01T00:00:00Z","text":"hi"}')).toThrow();
  });

  test("LuckyConfigJson validates defaultMode literals and allows empty object", () => {
    const decode = Schema.decodeUnknownSync(LuckyConfigJson);
    expect(decode("{}")).toEqual({});
    expect(() => decode('{"defaultMode":"invalid"}')).toThrow();
  });

  test("Tagged errors expose _tag discriminant", () => {
    const err = new InvalidChannelError({ input: "bad", cause: new Error("invalid") });
    expect(err._tag).toBe("InvalidChannelError");
  });
});
