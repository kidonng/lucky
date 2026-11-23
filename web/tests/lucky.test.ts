import { describe, expect, test } from "bun:test";
import type { ChannelIndex, LuckyRuntimeConfig } from "../../src/types.ts";
import {
  buildShareQuery,
  pickTargetUrl,
  readEmbeddedConfig,
  resolveChannelList,
  resolveInitialParams,
  resolveLuckyTarget,
} from "../src/lucky.ts";

describe("web/lucky", () => {
  test("readEmbeddedConfig reads #lucky-config JSON and ignores unreplaced placeholder", () => {
    const validDoc = {
      getElementById(id: string) {
        if (id !== "lucky-config") return null;
        return {
          textContent: JSON.stringify({
            defaultChannel: "alpha",
            defaultMode: "link",
            channels: [{ channel: "alpha", postCount: 3, linkCount: 1 }],
          }),
        } as HTMLElement;
      },
    };
    expect(readEmbeddedConfig(validDoc, undefined)).toEqual({
      defaultChannel: "alpha",
      defaultMode: "link",
      channels: [{ channel: "alpha", postCount: 3, linkCount: 1 }],
    });

    const placeholderDoc = {
      getElementById() {
        return { textContent: "__LUCKY_CONFIG_JSON__" } as HTMLElement;
      },
    };
    expect(readEmbeddedConfig(placeholderDoc, undefined)).toEqual({
      defaultChannel: null,
      defaultMode: "post",
      channels: [],
    });

    expect(
      readEmbeddedConfig(placeholderDoc, {
        __LUCKY_CONFIG__: {
          defaultChannel: "beta",
          defaultMode: "post",
          channels: [],
        },
      }),
    ).toEqual({
      defaultChannel: "beta",
      defaultMode: "post",
      channels: [],
    });

    const mirrorDoc = {
      getElementById(id: string) {
        if (id !== "lucky-config") return null;
        return {
          textContent: JSON.stringify({
            defaultChannel: "alpha",
            defaultMode: "post",
            channels: [],
            mirrors: [
              "tg.example.com",
              "https://TG.EXAMPLE.COM/",
              123,
              "ftp://bad.example.com",
              "http://localhost:8787/s/",
            ],
          }),
        } as HTMLElement;
      },
    };
    expect(readEmbeddedConfig(mirrorDoc, undefined)).toEqual({
      defaultChannel: "alpha",
      defaultMode: "post",
      channels: [],
      mirrors: ["https://tg.example.com", "http://localhost:8787/s"],
    });
  });

  test("resolveInitialParams resolves query overrides, single-channel fallback, mirrors, and ui=1", () => {
    const singleCfg: LuckyRuntimeConfig = {
      defaultChannel: null,
      defaultMode: "post",
      channels: [{ channel: "solo", postCount: 1, linkCount: 0 }],
    };
    expect(resolveInitialParams("", singleCfg)).toEqual({
      resolvedChannel: "solo",
      resolvedMode: "post",
      resolvedMirror: null,
      forceUi: false,
    });

    const multiCfg: LuckyRuntimeConfig = {
      defaultChannel: "alpha",
      defaultMode: "post",
      channels: [
        { channel: "alpha", postCount: 2, linkCount: 1 },
        { channel: "beta", postCount: 5, linkCount: 3 },
      ],
      mirrors: ["https://tg.example.com/s", "http://localhost:8787"],
    };
    expect(resolveInitialParams("?c=beta&m=link&ui=1", multiCfg)).toEqual({
      resolvedChannel: "beta",
      resolvedMode: "link",
      resolvedMirror: null,
      forceUi: true,
    });
    expect(
      resolveInitialParams(
        "?channel=beta&mode=invalid&mirror=tg.example.com",
        multiCfg,
      ),
    ).toEqual({
      resolvedChannel: "beta",
      resolvedMode: "post",
      resolvedMirror: "https://tg.example.com/s",
      forceUi: false,
    });
    expect(resolveInitialParams("?c=alpha&mirror=evil.com", multiCfg)).toEqual({
      resolvedChannel: "alpha",
      resolvedMode: "post",
      resolvedMirror: null,
      forceUi: false,
    });
  });

  test("pickTargetUrl and resolveLuckyTarget select post/link targets, cache fetches, and report empty pools", async () => {
    const db: Record<string, ChannelIndex> = {
      alpha: {
        channel: "alpha",
        postCount: 1,
        linkCount: 1,
        posts: [10],
        links: ["https://a.example.com/target"],
      },
      nolinks: {
        channel: "nolinks",
        postCount: 1,
        linkCount: 0,
        posts: [20],
        links: [],
      },
    };

    expect(pickTargetUrl(db.alpha!, "post", () => 0)).toBe(
      "https://t.me/alpha/10",
    );
    expect(pickTargetUrl(db.alpha!, "link", () => 0)).toBe(
      "https://a.example.com/target",
    );
    expect(pickTargetUrl(db.nolinks!, "link", () => 0)).toBeNull();

    let fetchCount = 0;
    const mockFetch = (async (input: string | URL | Request) => {
      fetchCount += 1;
      const url = String(input);
      const match = url.match(/\.\/data\/([^/]+)\.json$/);
      const ch = match?.[1] ? decodeURIComponent(match[1]) : "";
      const record = db[ch];
      if (!record) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(JSON.stringify(record), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const cache: Record<string, ChannelIndex> = {};
    expect(
      await resolveLuckyTarget("alpha", "post", cache, {
        fetchImpl: mockFetch,
        rng: () => 0,
      }),
    ).toEqual({ ok: true, target: "https://t.me/alpha/10" });

    expect(
      await resolveLuckyTarget("alpha", "link", cache, {
        fetchImpl: mockFetch,
        rng: () => 0,
      }),
    ).toEqual({ ok: true, target: "https://a.example.com/target" });
    expect(fetchCount).toBe(1);

    expect(
      await resolveLuckyTarget("nolinks", "link", cache, {
        fetchImpl: mockFetch,
        rng: () => 0,
      }),
    ).toEqual({ ok: false, hasPosts: true });

    expect(
      resolveLuckyTarget("missing", "post", cache, { fetchImpl: mockFetch }),
    ).rejects.toThrow("无法加载频道数据: missing");

    const mirrors = ["https://m1.example.com/s", "https://m2.example.com"];
    expect(
      pickTargetUrl(db.alpha!, "post", () => 0, {
        mirrorBase: "https://m1.example.com/s",
      }),
    ).toBe("https://m1.example.com/s/alpha/10");

    expect(
      await resolveLuckyTarget("alpha", "post", cache, {
        fetchImpl: mockFetch,
        rng: () => 0,
        mirrors,
        mirrorParam: "m2.example.com",
        referrer: "https://m1.example.com/s/alpha",
      }),
    ).toEqual({ ok: true, target: "https://m2.example.com/alpha/10" });

    expect(
      await resolveLuckyTarget("alpha", "post", cache, {
        fetchImpl: mockFetch,
        rng: () => 0,
        mirrors,
        mirrorParam: "evil.com",
        referrer: "https://m1.example.com/s/alpha",
      }),
    ).toEqual({ ok: true, target: "https://m1.example.com/s/alpha/10" });

    expect(
      await resolveLuckyTarget("alpha", "post", cache, {
        fetchImpl: mockFetch,
        rng: () => 0,
        mirrors,
        mirrorParam: "evil.com",
        referrer: "https://evil.com/alpha",
      }),
    ).toEqual({ ok: true, target: "https://t.me/alpha/10" });

    expect(
      await resolveLuckyTarget("alpha", "link", cache, {
        fetchImpl: mockFetch,
        rng: () => 0,
        mirrors,
        mirrorParam: "m2.example.com",
        referrer: "https://m1.example.com/s/alpha",
      }),
    ).toEqual({ ok: true, target: "https://a.example.com/target" });
  });

  test("buildShareQuery and resolveChannelList format queries and fallback channels", () => {
    expect(buildShareQuery("my_chan", "link")).toBe("?c=my_chan&m=link");
    expect(buildShareQuery("my_chan", "post", "https://tg.example.com/s")).toBe(
      "?c=my_chan&m=post&mirror=tg.example.com",
    );
    expect(
      resolveChannelList(
        { defaultChannel: null, defaultMode: "post", channels: [] },
        "custom",
      ),
    ).toEqual([{ channel: "custom", postCount: 0, linkCount: 0 }]);
  });
});
