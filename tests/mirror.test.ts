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
