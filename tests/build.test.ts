import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSite } from "../src/build";
import { writeChannelPosts } from "../src/storage";

describe("buildSite", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "lucky-build-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("compiles data/*.jsonl into dist/data/*.json, channels.json, and dist/index.html with default config", async () => {
    const dataDir = join(tempDir, "data");
    const outDir = join(tempDir, "dist");

    await writeChannelPosts(join(dataDir, "alpha.jsonl"), [
      { id: 10, date: "2024-01-01T00:00:00Z", text: "Hello https://a.example.com" },
      { id: 12, date: "2024-01-02T00:00:00Z", text: "Media only" },
    ]);

    const res = await buildSite({
      dataDir,
      outDir,
      defaultMode: "link",
    });

    expect(res.defaultChannel).toBe("alpha");
    expect(res.defaultMode).toBe("link");

    const chanJson = JSON.parse(await readFile(join(outDir, "data", "alpha.json"), "utf8"));
    expect(chanJson).toEqual({
      channel: "alpha",
      postCount: 2,
      linkCount: 1,
      posts: [10, 12],
      links: ["https://a.example.com/"],
    });

    const channelsList = JSON.parse(await readFile(join(outDir, "data", "channels.json"), "utf8"));
    expect(channelsList).toEqual([
      { channel: "alpha", postCount: 2, linkCount: 1 },
    ]);

    const indexHtml = await readFile(join(outDir, "index.html"), "utf8");
    expect(indexHtml).toContain('"defaultChannel":"alpha"');
    expect(indexHtml).toContain('"defaultMode":"link"');
  });

  test("resolves defaultChannel case-insensitively against built channel filenames", async () => {
    const dataDir = join(tempDir, "data");
    const outDir = join(tempDir, "dist");

    await writeChannelPosts(join(dataDir, "MyChan.jsonl"), [
      { id: 1, date: "2024-01-01T00:00:00Z", text: "Post 1" },
    ]);

    const res = await buildSite({
      dataDir,
      outDir,
      defaultChannel: "mychan",
    });

    expect(res.defaultChannel).toBe("MyChan");
  });

  test("built index.html inline script executes redirects for post and link modes and falls back when link pool is empty", async () => {
    const dataDir = join(tempDir, "data");
    const outDir = join(tempDir, "dist");

    await writeChannelPosts(join(dataDir, "alpha.jsonl"), [
      { id: 10, date: "2024-01-01T00:00:00Z", text: "Hello https://a.example.com/target" },
    ]);
    await writeChannelPosts(join(dataDir, "nolinks.jsonl"), [
      { id: 20, date: "2024-01-02T00:00:00Z", text: "Just plain text" },
    ]);

    await buildSite({
      dataDir,
      outDir,
      defaultChannel: "alpha",
      defaultMode: "post",
    });

    const html = await readFile(join(outDir, "index.html"), "utf8");
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch?.[1]).toBeDefined();
    const scriptBody = scriptMatch![1]!;

    interface StubElement {
      style: { display: string };
      textContent: string;
      innerHTML: string;
      href: string;
      value: string;
      checked: boolean;
      selected?: boolean;
      appendChild(child: StubElement): void;
      addEventListener(): void;
    }

    async function runFrontendScript(search: string) {
      let replacedUrl: string | null = null;
      const elements: Record<string, StubElement> = {};
      const makeEl = (): StubElement => ({
        style: { display: "none" },
        textContent: "",
        innerHTML: "",
        href: "",
        value: "",
        checked: false,
        appendChild(child: StubElement) {
          if (!this.value || child.selected) {
            this.value = child.value;
          }
        },
        addEventListener() {},
      });

      for (const id of [
        "redirect-view",
        "ui-view",
        "notice-box",
        "channel-select",
        "lucky-btn",
        "fallback-link",
        "redirect-status",
        "share-post-link",
        "share-link-link",
      ]) {
        elements[id] = makeEl();
      }

      const radios = {
        post: { value: "post", checked: true },
        link: { value: "link", checked: false },
      };

      const fakeWindow = {
        __LUCKY_CONFIG__: undefined as unknown,
        location: {
          search,
          origin: "https://lucky.example.com",
          pathname: "/",
          replace(url: string) {
            replacedUrl = url;
          },
          assign(url: string) {
            replacedUrl = url;
          },
        },
      };

      const fakeDocument = {
        getElementById(id: string): StubElement {
          return elements[id] ?? makeEl();
        },
        createElement(): StubElement {
          return makeEl();
        },
        querySelector(sel: string) {
          if (sel.includes('value="post"')) return radios.post;
          if (sel.includes('value="link"')) return radios.link;
          if (sel.includes(":checked")) return radios.link.checked ? radios.link : radios.post;
          return null;
        },
      };

      const fakeFetch = async (relUrl: string) => {
        const fileName = relUrl.replace(/^\.\/data\//, "");
        const diskPath = join(outDir, "data", decodeURIComponent(fileName));
        try {
          const body = await readFile(diskPath, "utf8");
          return { ok: true, json: async () => JSON.parse(body) as unknown };
        } catch {
          return { ok: false, status: 404, json: async () => ({}) };
        }
      };

      const awaitableScript = scriptBody.replace("(async function () {", "return (async function () {");
      const fn = new Function("window", "document", "fetch", awaitableScript);
      await fn(fakeWindow, fakeDocument, fakeFetch);
      return { replacedUrl, elements, radios };
    }

    const postRun = await runFrontendScript("");
    expect(postRun.replacedUrl).toBe("https://t.me/alpha/10");

    const linkRun = await runFrontendScript("?c=alpha&m=link");
    expect(linkRun.replacedUrl).toBe("https://a.example.com/target");

    const emptyLinkRun = await runFrontendScript("?c=nolinks&m=link");
    expect(emptyLinkRun.replacedUrl).toBeNull();
    expect(emptyLinkRun.elements["ui-view"].style.display).toBe("block");
    expect(emptyLinkRun.elements["notice-box"].textContent).toContain("没有提取到外部链接");
  });
});
