import type { Element, Root, RootContent } from "hast";
import { select, selectAll } from "hast-util-select";
import { toHtml } from "hast-util-to-html";
import { toText } from "hast-util-to-text";
import rehypeParse from "rehype-parse";
import rehypeRemark from "rehype-remark";
import remarkGfm from "remark-gfm";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import type { ChannelPost } from "./types";

export function normalizeChannelName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Channel name cannot be empty");
  }

  const withoutAt = trimmed.replace(/^@+/, "");
  const urlMatch = withoutAt.match(
    /^(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me)\/(?:s\/)?([a-zA-Z0-9_]+)/i
  );
  if (urlMatch?.[1]) {
    return urlMatch[1];
  }

  const handleMatch = withoutAt.match(/^([a-zA-Z0-9_]+)/);
  if (!handleMatch?.[1]) {
    throw new Error(`Invalid Telegram channel identifier: ${input}`);
  }
  return handleMatch[1];
}

function normalizeTelegramHast() {
  return (tree: Root) => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "a" || !parent || typeof index !== "number") {
        return;
      }

      const rawHref = String(node.properties?.href ?? "").trim();

      if (
        !rawHref ||
        rawHref.startsWith("?q=") ||
        rawHref.toLowerCase().startsWith("javascript:")
      ) {
        parent.children.splice(index, 1, ...(node.children as RootContent[]));
        return index;
      }

      let href = rawHref;
      if (href.startsWith("//")) {
        href = `https:${href}`;
      }
      node.properties = { ...node.properties, href };

      const visible = toText(node).trim();
      const strippedVisible = visible.replace(/(?:…|\.{3})+$/, "");
      if (
        visible === href ||
        (strippedVisible.length > 0 &&
          ( strippedVisible.startsWith("http://") ||
            strippedVisible.startsWith("https://") ) &&
          href.startsWith(strippedVisible))
      ) {
        node.children = [{ type: "text", value: href }];
      }
    });
  };
}

const htmlToMarkdownProcessor = unified()
  .use(rehypeParse, { fragment: true })
  .use(normalizeTelegramHast)
  .use(rehypeRemark)
  .use(remarkGfm)
  .use(remarkStringify, {
    bullet: "-",
    fences: true,
    rule: "-",
  });

export function messageHtmlToMarkdown(htmlFragment: string): string {
  if (!htmlFragment.trim()) {
    return "";
  }
  const file = htmlToMarkdownProcessor.processSync(htmlFragment);
  return String(file).trim();
}

function findDirectMessageText(messageNode: Element): Element | null {
  const candidates = selectAll(".tgme_widget_message_text", messageNode);
  if (candidates.length === 0) {
    return null;
  }

  const replyNodes = new Set(
    selectAll(".tgme_widget_message_reply .tgme_widget_message_text", messageNode)
  );

  for (const candidate of candidates) {
    if (!replyNodes.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function parseChannelPageHtml(pageHtml: string, channel: string): ChannelPost[] {
  if (!pageHtml.trim()) {
    return [];
  }

  const normalizedChannel = normalizeChannelName(channel).toLowerCase();
  const tree = unified().use(rehypeParse).parse(pageHtml);
  const messageNodes = selectAll(".tgme_widget_message[data-post]", tree);

  const byId = new Map<number, ChannelPost>();

  for (const msgNode of messageNodes) {
    const dataPost = String(msgNode.properties?.dataPost ?? "").trim();
    const slashIndex = dataPost.indexOf("/");
    if (slashIndex <= 0) {
      continue;
    }

    const postChannel = dataPost.slice(0, slashIndex).toLowerCase();
    const postId = Number.parseInt(dataPost.slice(slashIndex + 1), 10);
    if (postChannel !== normalizedChannel || !Number.isFinite(postId) || postId <= 0) {
      continue;
    }

    const timeNode = select(".tgme_widget_message_date time[datetime], time[datetime]", msgNode);
    const date = String(timeNode?.properties?.dateTime ?? timeNode?.properties?.datetime ?? "").trim();
    if (!date) {
      continue;
    }

    const textNode = findDirectMessageText(msgNode);
    const innerHtml = textNode ? toHtml(textNode.children) : "";
    const text = innerHtml ? messageHtmlToMarkdown(innerHtml) : "";

    byId.set(postId, {
      id: postId,
      date,
      text,
    });
  }

  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}
