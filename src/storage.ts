import { Effect, FileSystem, Path, Schema } from "effect";
import {
  type ChannelPost,
  ChannelPostJson,
  StorageDecodeError,
} from "./types";

const decodePostJson = Schema.decodeUnknownEffect(ChannelPostJson);

export function serializePostJsonlLine(post: ChannelPost): string {
  return JSON.stringify({
    id: post.id,
    date: post.date,
    text: post.text,
  });
}

export const readChannelPosts = Effect.fn("storage.readChannelPosts")(
  function*(jsonlPath: string) {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(jsonlPath))) {
      return [];
    }

    const content = yield* fs.readFileString(jsonlPath);
    const byId = new Map<number, ChannelPost>();
    const rawLines = content.split(/\r?\n/);

    for (let index = 0; index < rawLines.length; index++) {
      const line = rawLines[index]?.trim() ?? "";
      if (!line) {
        continue;
      }

      const post = yield* decodePostJson(line).pipe(
        Effect.mapError(
          (cause) =>
            new StorageDecodeError({
              path: jsonlPath,
              line: index + 1,
              cause,
            })
        )
      );

      byId.set(post.id, post);
    }

    return Array.from(byId.values()).sort((a, b) => a.id - b.id);
  }
);

export const writeChannelPosts = Effect.fn("storage.writeChannelPosts")(
  function*(jsonlPath: string, posts: ReadonlyArray<ChannelPost>) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* fs.makeDirectory(path.dirname(jsonlPath), { recursive: true });

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

    yield* fs.writeFileString(jsonlPath, body);
  }
);
