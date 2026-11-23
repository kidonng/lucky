import { describe, expect, test } from "bun:test";
import { extractChannelLinks, extractLinksFromMarkdown } from "../src/links";
import { messageHtmlToMarkdown } from "../src/parser";

describe("extractLinksFromMarkdown", () => {
  test("extracts Markdown links and GFM autolinks while ignoring code blocks and self-channel links", () => {
    const md = [
      "Read [Rust](https://en.wikipedia.org/wiki/Rust_(programming_language)) and bare https://example.com/path?a=1.",
      "Self link: https://t.me/my_chan/42 and [Self Preview](https://t.me/s/MY_CHAN?before=10) and https://telegram.me/my_chan",
      "Other channel: https://t.me/other_chan/99 and prefix-neighbor https://t.me/my_chan2/5 and https://t.me/s/my_chan2",
      "Inline `https://ignored-in-code.example.com` and:\n```\nhttps://ignored-in-fence.example.com\n```",
    ].join("\n\n");

    const links = extractLinksFromMarkdown(md, "my_chan");
    expect(links).toEqual([
      "https://en.wikipedia.org/wiki/Rust_(programming_language)",
      "https://example.com/path?a=1",
      "https://t.me/other_chan/99",
      "https://t.me/my_chan2/5",
      "https://t.me/s/my_chan2",
    ]);
  });

  test("round-trips parenthesized URLs converted by messageHtmlToMarkdown", () => {
    const html = `<a href="https://en.wikipedia.org/wiki/Rust_(programming_language)">Rust</a>`;
    const md = messageHtmlToMarkdown(html);
    expect(extractLinksFromMarkdown(md, "demo")).toEqual([
      "https://en.wikipedia.org/wiki/Rust_(programming_language)",
    ]);
  });
});

describe("extractChannelLinks", () => {
  test("deduplicates normalized URLs across posts preserving first-seen order", () => {
    const posts = [
      {
        id: 1,
        date: "2024-01-01T00:00:00Z",
        text: "https://example.com and https://foo.bar/a",
      },
      {
        id: 2,
        date: "2024-01-02T00:00:00Z",
        text: "[Ex](https://example.com/) and https://baz.qux",
      },
    ];
    expect(extractChannelLinks(posts, "demo")).toEqual([
      "https://example.com/",
      "https://foo.bar/a",
      "https://baz.qux/",
    ]);
  });
});
