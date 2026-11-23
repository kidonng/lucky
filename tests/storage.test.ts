import { BunServices } from "@effect/platform-bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChannelPosts, writeChannelPosts } from "../src/storage";

const runWithBun = <A, E>(
  effect: Effect.Effect<A, E, BunServices.BunServices>,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

describe("storage", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "lucky-storage-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("readChannelPosts returns empty array when file does not exist", async () => {
    const posts = await runWithBun(
      readChannelPosts(join(tempDir, "missing.jsonl")),
    );
    expect(posts).toEqual([]);
  });

  test("writeChannelPosts creates parent directories, deduplicates, sorts by id, and ignores blank lines on read", async () => {
    const filePath = join(tempDir, "nested", "dir", "chan.jsonl");
    await runWithBun(
      writeChannelPosts(filePath, [
        { id: 3, date: "2024-01-03T00:00:00Z", text: "Third" },
        { id: 1, date: "2024-01-01T00:00:00Z", text: "Old First" },
        { id: 1, date: "2024-01-01T00:00:00Z", text: "First" },
      ]),
    );

    const raw = await readFile(filePath, "utf8");
    expect(raw).toBe(
      '{"id":1,"date":"2024-01-01T00:00:00Z","text":"First"}\n' +
        '{"id":3,"date":"2024-01-03T00:00:00Z","text":"Third"}\n',
    );

    await writeFile(filePath, `${raw}\n\n`, "utf8");
    const posts = await runWithBun(readChannelPosts(filePath));
    expect(posts).toEqual([
      { id: 1, date: "2024-01-01T00:00:00Z", text: "First" },
      { id: 3, date: "2024-01-03T00:00:00Z", text: "Third" },
    ]);
  });

  test("readChannelPosts fails with StorageDecodeError carrying path and 1-based line number on malformed line", async () => {
    const filePath = join(tempDir, "broken.jsonl");
    await writeFile(
      filePath,
      '{"id":1,"date":"2024-01-01T00:00:00Z","text":"ok"}\n{"id":"not-an-int","date":"2024-01-02T00:00:00Z","text":"bad"}\n',
      "utf8",
    );

    const err = await runWithBun(Effect.flip(readChannelPosts(filePath)));
    expect(err._tag).toBe("StorageDecodeError");
    if (err._tag === "StorageDecodeError") {
      expect(err.path).toBe(filePath);
      expect(err.line).toBe(2);
    }
  });
});
