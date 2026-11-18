import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChannelPost } from "./types";

export function serializePostJsonlLine(post: ChannelPost): string {
  return JSON.stringify({
    id: post.id,
    date: post.date,
    text: post.text,
  });
}

export async function readChannelPosts(jsonlPath: string): Promise<ChannelPost[]> {
  if (!existsSync(jsonlPath)) {
    return [];
  }

  const content = await readFile(jsonlPath, "utf8");
  const byId = new Map<number, ChannelPost>();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const parsed = JSON.parse(line) as Partial<ChannelPost>;
    if (
      typeof parsed.id === "number" &&
      Number.isFinite(parsed.id) &&
      typeof parsed.date === "string" &&
      typeof parsed.text === "string"
    ) {
      byId.set(parsed.id, {
        id: parsed.id,
        date: parsed.date,
        text: parsed.text,
      });
    }
  }

  return Array.from(byId.values()).sort((a, b) => a.id - b.id);
}

export async function writeChannelPosts(
  jsonlPath: string,
  posts: ChannelPost[]
): Promise<void> {
  await mkdir(dirname(jsonlPath), { recursive: true });

  const byId = new Map<number, ChannelPost>();
  for (const post of posts) {
    byId.set(post.id, {
      id: post.id,
      date: post.date,
      text: post.text,
    });
  }

  const sorted = Array.from(byId.values()).sort((a, b) => a.id - b.id);
  const body =
    sorted.length > 0
      ? `${sorted.map(serializePostJsonlLine).join("\n")}\n`
      : "";

  await writeFile(jsonlPath, body, "utf8");
}
