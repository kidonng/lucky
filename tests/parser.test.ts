import { describe, expect, test } from "bun:test";
import {
  messageHtmlToMarkdown,
  normalizeChannelName,
  parseChannelPageHtml,
} from "../src/parser";

describe("normalizeChannelName", () => {
  test("strips @ and t.me URLs", () => {
    expect(normalizeChannelName("@my_channel")).toBe("my_channel");
    expect(normalizeChannelName("https://t.me/s/my_channel?before=10")).toBe(
      "my_channel",
    );
    expect(normalizeChannelName("https://t.me/my_channel/42")).toBe(
      "my_channel",
    );
  });

  test("rejects handle-less Telegram URLs and non-Telegram URLs", () => {
    expect(() => normalizeChannelName("https://t.me/")).toThrow(
      /Invalid Telegram channel/i,
    );
    expect(() => normalizeChannelName("https://t.me/s/")).toThrow(
      /Invalid Telegram channel/i,
    );
    expect(() => normalizeChannelName("https://example.com/foo")).toThrow(
      /Invalid Telegram channel/i,
    );
  });
});

describe("messageHtmlToMarkdown", () => {
  test("converts br, formatting, hashtags, protocol-relative URLs, and parenthesized URLs", () => {
    const html = [
      `<b>Hello</b> <i>world</i>!<br/>`,
      `Check <a href="https://en.wikipedia.org/wiki/Rust_(programming_language)">Rust Wiki</a> `,
      `and <a href="https://example.com/very/long/path/to/article">https://example.com/very/long/…</a> `,
      `and <a href="//cdn.example.com/file.pdf">PDF</a> `,
      `<a href="?q=%23golang">#golang</a>`,
    ].join("");

    const md = messageHtmlToMarkdown(html);
    expect(md).toContain("**Hello** *world*!");
    expect(md).toMatch(
      /\[Rust Wiki\]\(https:\/\/en\.wikipedia\.org\/wiki\/Rust_\\?\(programming_language\\?\)\)/,
    );
    expect(md).toContain("https://example.com/very/long/path/to/article");
    expect(md).not.toContain("https://example.com/very/long/…");
    expect(md).toContain("[PDF](https://cdn.example.com/file.pdf)");
    expect(md).toContain("#golang");
    expect(md).not.toContain("?q=%23golang");
  });

  test("unwraps Telegram <i class='emoji'><b>...</b></i> tags into plain emoji without hex-escaping adjacent CJK characters", () => {
    const html = `成了<i class="emoji" style="background-image:url('//telegram.org/img/emoji/40/F09F98A3.png')"><b>🤣</b></i>。比网页版低<i class="emoji"><b>🙈</b></i>再加上`;
    expect(messageHtmlToMarkdown(html)).toBe("成了🤣。比网页版低🙈再加上");
  });
});

describe("parseChannelPageHtml", () => {
  test("extracts text posts, media-only posts, and skips service messages without id/date", () => {
    const samplePage = `
      <div class="tgme_widget_message_wrap">
        <div class="tgme_widget_message service_message" data-post="demo/1">
          <div class="tgme_widget_message_text js-message_text">Channel created</div>
          <time datetime="2024-05-01T09:00:00+00:00">May 1</time>
        </div>
      <div class="tgme_widget_message_wrap">
        <div class="tgme_widget_message" data-post="demo/2">
          <div class="tgme_widget_message_bubble">
            <div class="tgme_widget_message_text js-message_text">First post with <a href="https://example.org">link</a></div>
            <div class="tgme_widget_message_footer">
              <a class="tgme_widget_message_date" href="https://t.me/demo/2">
                <time datetime="2024-05-01T10:00:00+00:00">May 1</time>
              </a>
            </div>
          </div>
        </div>
      </div>
      <div class="tgme_widget_message_wrap">
        <div class="tgme_widget_message" data-post="demo/3">
          <div class="tgme_widget_message_bubble">
            <div class="tgme_widget_message_photo_wrap"></div>
            <div class="tgme_widget_message_footer">
              <a class="tgme_widget_message_date" href="https://t.me/demo/3">
                <time datetime="2024-05-02T12:00:00+00:00">May 2</time>
              </a>
            </div>
          </div>
        </div>
      </div>
    `;

    const posts = parseChannelPageHtml(samplePage, "demo");
    expect(posts).toEqual([
      {
        id: 2,
        date: "2024-05-01T10:00:00+00:00",
        text: "First post with [link](https://example.org)",
      },
      {
        id: 3,
        date: "2024-05-02T12:00:00+00:00",
        text: "",
      },
    ]);
  });
});
