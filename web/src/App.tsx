import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  ChannelIndex,
  LuckyMode,
  LuckyRuntimeConfig,
} from "../../src/types.ts";
import {
  buildShareQuery,
  resolveChannelList,
  resolveInitialParams,
  resolveLuckyTarget,
} from "./lucky.ts";

interface AppProps {
  config: LuckyRuntimeConfig;
}

export function App({ config }: AppProps) {
  const initial = useMemo(
    () => resolveInitialParams(window.location.search, config),
    [config],
  );
  const channels = useMemo(
    () => resolveChannelList(config, initial.resolvedChannel),
    [config, initial.resolvedChannel],
  );

  const shouldAutoRedirect = Boolean(
    initial.resolvedChannel && !initial.forceUi,
  );

  const [view, setView] = useState<"redirect" | "ui">(
    shouldAutoRedirect ? "redirect" : "ui",
  );
  const [redirectStatus, setRedirectStatus] =
    useState("正在为你抽取手气不错目标…");
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);

  const [selectedChannel, setSelectedChannel] = useState<string>(
    initial.resolvedChannel ?? channels[0]?.channel ?? "",
  );
  const [selectedMode, setSelectedMode] = useState<LuckyMode>(
    initial.resolvedMode,
  );
  const [notice, setNotice] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [copiedMode, setCopiedMode] = useState<LuckyMode | null>(null);

  const cacheRef = useRef<Record<string, ChannelIndex>>(Object.create(null));

  useEffect(() => {
    if (!shouldAutoRedirect || !initial.resolvedChannel) return;
    let cancelled = false;
    const ch = initial.resolvedChannel;
    const mode = initial.resolvedMode;

    (async () => {
      try {
        const result = await resolveLuckyTarget(ch, mode, cacheRef.current, {
          mirrors: config.mirrors,
          mirrorParam: initial.resolvedMirror,
          referrer: document.referrer,
        });
        if (cancelled) return;
        if (!result.ok) {
          setSelectedChannel(ch);
          setSelectedMode(mode === "link" ? "post" : mode);
          setNotice(
            mode === "link"
              ? `频道 @${ch} 中没有提取到外部链接，可点击下方按钮随机看帖。`
              : `频道 @${ch} 暂无可跳转的帖子数据。`,
          );
          setView("ui");
          return;
        }
        setFallbackUrl(result.target);
        setRedirectStatus(`正在跳转到 ${result.target}`);
        window.location.replace(result.target);
      } catch (err) {
        if (cancelled) return;
        setSelectedChannel(ch);
        setSelectedMode(mode);
        setNotice(
          err instanceof Error && err.message
            ? err.message
            : "无法加载频道数据",
        );
        setView("ui");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    shouldAutoRedirect,
    initial.resolvedChannel,
    initial.resolvedMode,
    initial.resolvedMirror,
    config.mirrors,
  ]);

  async function handleLuckyClick() {
    if (!selectedChannel) {
      setNotice("请先选择一个频道。");
      return;
    }
    setNotice("");
    setLoading(true);
    try {
      const result = await resolveLuckyTarget(
        selectedChannel,
        selectedMode,
        cacheRef.current,
        {
          mirrors: config.mirrors,
          mirrorParam: initial.resolvedMirror,
          referrer: document.referrer,
        },
      );
      if (!result.ok) {
        setNotice(
          selectedMode === "link"
            ? "该频道暂无可跳转的帖中链接，请切换到「随机帖子」模式。"
            : "该频道暂无帖子数据。",
        );
        if (selectedMode === "link" && result.hasPosts) {
          setSelectedMode("post");
        }
        return;
      }
      window.location.assign(result.target);
    } catch (err) {
      setNotice(
        err instanceof Error && err.message ? err.message : "加载频道数据失败",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleCopyShare(mode: LuckyMode) {
    if (!selectedChannel) return;
    const base = `${window.location.origin}${window.location.pathname}`;
    const fullUrl = `${base}${buildShareQuery(selectedChannel, mode, initial.resolvedMirror)}`;
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopiedMode(mode);
      window.setTimeout(() => {
        setCopiedMode((current) => (current === mode ? null : current));
      }, 1500);
    } catch {
      // Clipboard API may be unavailable in non-secure contexts.
    }
  }

  const basePath = `${window.location.origin}${window.location.pathname}`;

  if (view === "redirect") {
    return (
      <main class="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 text-center shadow-lg shadow-slate-900/5 dark:border-slate-800 dark:bg-slate-900 dark:shadow-black/30">
        <h1 class="text-xl font-bold tracking-tight">🎲 正在跳转…</h1>
        <p class="mt-2 break-all text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          {redirectStatus}
        </p>
        <p class="mt-4 text-sm">
          <a
            href={fallbackUrl ?? "#"}
            rel="noreferrer"
            class="break-all font-medium text-sky-600 underline-offset-4 hover:underline dark:text-sky-400"
          >
            {fallbackUrl ?? "如果未自动跳转，请点击这里"}
          </a>
        </p>
      </main>
    );
  }

  return (
    <main class="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 shadow-lg shadow-slate-900/5 dark:border-slate-800 dark:bg-slate-900 dark:shadow-black/30">
      <h1 class="text-xl font-bold tracking-tight">🎲 Telegram 频道手气不错</h1>
      <p class="mt-1.5 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
        随机跳转到频道历史帖子，或直接开启帖中分享的盲盒链接。
      </p>

      {notice ? (
        <div
          role="alert"
          class="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-800 dark:border-amber-900/80 dark:bg-amber-950/60 dark:text-amber-300"
        >
          {notice}
        </div>
      ) : null}

      <div class="mt-5 space-y-4">
        <div>
          <label
            for="channel-select"
            class="mb-1.5 block text-xs font-semibold tracking-wide text-slate-500 dark:text-slate-400"
          >
            频道 (Channel)
          </label>
          <select
            id="channel-select"
            value={selectedChannel}
            onChange={(e) => {
              setSelectedChannel(e.currentTarget.value);
              setNotice("");
            }}
            class="w-full rounded-xl border border-slate-200 bg-slate-100 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-500/20 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
          >
            {channels.length === 0 ? (
              <option value="">暂无可用频道</option>
            ) : (
              channels.map((item) => (
                <option key={item.channel} value={item.channel}>
                  @{item.channel} ({item.postCount} 帖 / {item.linkCount} 链接)
                </option>
              ))
            )}
          </select>
        </div>

        <div>
          <span class="mb-1.5 block text-xs font-semibold tracking-wide text-slate-500 dark:text-slate-400">
            模式 (Mode)
          </span>
          <div class="grid grid-cols-2 gap-2.5">
            {(
              [
                { value: "post", label: "随机帖子" },
                { value: "link", label: "帖中链接" },
              ] as const
            ).map((option) => {
              const active = selectedMode === option.value;
              return (
                <label
                  key={option.value}
                  class={`flex cursor-pointer select-none items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition ${
                    active
                      ? "border-sky-500 bg-sky-500/10 text-sky-700 dark:border-sky-400 dark:bg-sky-400/10 dark:text-sky-300"
                      : "border-slate-200 bg-slate-100 text-slate-700 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-slate-600"
                  }`}
                >
                  <input
                    type="radio"
                    name="lucky-mode"
                    value={option.value}
                    checked={active}
                    onChange={() => setSelectedMode(option.value)}
                    class="accent-sky-500"
                  />
                  <span>{option.label}</span>
                </label>
              );
            })}
          </div>
        </div>

        <button
          type="button"
          disabled={loading}
          onClick={handleLuckyClick}
          class="w-full cursor-pointer rounded-xl bg-sky-500 px-4 py-3 text-sm font-bold text-slate-950 transition hover:bg-sky-400 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "正在抽取…" : "🎲 手气不错 (I'm Feeling Lucky)"}
        </button>
      </div>

      <section class="mt-6 border-t border-slate-200 pt-4 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
        <p>直跳分享链接（放入频道简介或发给朋友）：</p>
        <div class="mt-2 space-y-2">
          {(
            [
              { mode: "post", label: "随机帖子" },
              { mode: "link", label: "帖中链接" },
            ] as const
          ).map(({ mode, label }) => {
            const query = selectedChannel
              ? buildShareQuery(selectedChannel, mode, initial.resolvedMirror)
              : null;
            const href = query ? `${basePath}${query}` : "#";
            return (
              <div
                key={mode}
                class="flex items-center justify-between gap-2 rounded-lg bg-slate-100 px-2.5 py-2 font-mono dark:bg-slate-800/80"
              >
                <span class="shrink-0 font-sans text-slate-500 dark:text-slate-400">
                  {label}：
                </span>
                <a
                  href={href}
                  class="min-w-0 flex-1 truncate text-right text-sky-600 hover:underline dark:text-sky-400"
                >
                  {query ?? "-"}
                </a>
                {query ? (
                  <button
                    type="button"
                    onClick={() => handleCopyShare(mode)}
                    class="shrink-0 cursor-pointer rounded border border-slate-300 bg-white px-1.5 py-0.5 font-sans text-[11px] font-medium text-slate-600 transition hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
                  >
                    {copiedMode === mode ? "已复制" : "复制"}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>
    </main>
  );
}
