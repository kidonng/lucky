import { rm } from "node:fs/promises";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";

export interface WebAsset {
  relativePath: string;
  bytes: Uint8Array;
}

export interface WebBundle {
  indexHtml: string;
  assets: ReadonlyArray<WebAsset>;
}

function createWebBuildConfig(outdir?: string): Bun.BuildConfig {
  return {
    entrypoints: [join(import.meta.dir, "index.html")],
    minify: true,
    splitting: true,
    plugins: [tailwind],
    ...(outdir ? { outdir } : {}),
  };
}

export async function buildWeb(outdir?: string): Promise<WebBundle> {
  const result = await Bun.build(createWebBuildConfig(outdir));

  if (!result.success) {
    const details = result.logs.map((log) => String(log)).join("\n");
    throw new Error(`Failed to build web bundle:\n${details}`);
  }

  let indexHtml: string | undefined;
  const assets: Array<WebAsset> = [];

  for (const output of result.outputs) {
    const relativePath = output.path.replace(/^\.\//, "");
    if (relativePath === "index.html" || relativePath.endsWith("/index.html")) {
      indexHtml = await output.text();
    } else {
      assets.push({
        relativePath,
        bytes: new Uint8Array(await output.arrayBuffer()),
      });
    }
  }

  if (indexHtml === undefined) {
    throw new Error(
      "Bun.build produced no index.html output for web/index.html",
    );
  }

  return { indexHtml, assets };
}

if (import.meta.main) {
  const outdir = join(import.meta.dir, "dist");
  await rm(outdir, { recursive: true, force: true });
  await buildWeb(outdir);
}
