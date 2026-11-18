import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { normalizeChannelName } from "./parser";
import type { ChannelPost } from "./types";

const markdownParser = unified().use(remarkParse).use(remarkGfm);
const TELEGRAM_HOSTS: Record<string, true> = {
  "t.me": true,
  "www.t.me": true,
  "telegram.me": true,
  "www.telegram.me": true,
  "telegram.dog": true,
  "www.telegram.dog": true,
};

function isSelfChannelUrl(url: URL, normalizedChannelLower: string): boolean {
  const host = url.hostname.toLowerCase();
  if (!TELEGRAM_HOSTS[host]) {
    return false;
  }

  const segments = url.pathname
    .split("/")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (segments.length === 0) {
    return false;
  }

  if (segments[0] === "s") {
    return segments[1] === normalizedChannelLower;
  }

  return segments[0] === normalizedChannelLower;
}

function normalizeAndFilterUrl(
  rawUrl: string,
  normalizedChannelLower: string
): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  if (isSelfChannelUrl(parsed, normalizedChannelLower)) {
    return null;
  }

  return parsed.toString();
}

export function extractLinksFromMarkdown(
  markdown: string,
  channel: string
): string[] {
  if (!markdown.trim()) {
    return [];
  }

  const normalizedChannelLower = normalizeChannelName(channel).toLowerCase();
  const tree = markdownParser.parse(markdown);
  const seen = new Set<string>();
  const result: string[] = [];

  visit(tree, (node) => {
    if (node.type !== "link" && node.type !== "definition") {
      return;
    }

    const rawUrl = "url" in node && typeof node.url === "string" ? node.url : "";
    const normalized = normalizeAndFilterUrl(rawUrl, normalizedChannelLower);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  });

  return result;
}

export function extractChannelLinks(
  posts: ChannelPost[],
  channel: string
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const post of posts) {
    for (const link of extractLinksFromMarkdown(post.text, channel)) {
      if (!seen.has(link)) {
        seen.add(link);
        result.push(link);
      }
    }
  }

  return result;
}
