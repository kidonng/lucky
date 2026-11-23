const SCHEME_WITHOUT_SLASHES_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d+(?:\/|$))/;

function parseCandidateUrl(raw: string, allowBareHost: boolean): URL {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Mirror value cannot be empty");
  }

  let target = trimmed;
  if (!trimmed.includes("://") && !SCHEME_WITHOUT_SLASHES_RE.test(trimmed)) {
    if (!allowBareHost) {
      throw new Error(`Missing HTTP(S) scheme: ${raw}`);
    }
    target = `https://${trimmed}`;
  }

  const url = new URL(target);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported mirror scheme: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("Mirror URL must not contain credentials");
  }
  if (!url.host) {
    throw new Error(`Missing host in mirror value: ${raw}`);
  }

  return url;
}

/**
 * Validates and normalizes a configured mirror domain or URL into its canonical base
 * (`origin` plus optional path prefix without trailing slash).
 */
export function normalizeMirrorBase(input: string): string {
  const url = parseCandidateUrl(input, true);
  if (url.search || url.hash) {
    throw new Error(`Mirror URL must not contain query or hash: ${input}`);
  }
  const cleanPath = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${cleanPath}`;
}

/**
 * Normalizes and deduplicates a list of configured mirrors while preserving order.
 */
export function normalizeMirrorList(
  inputs: ReadonlyArray<string>,
): Array<string> {
  const seen = new Set<string>();
  const result: Array<string> = [];

  for (const input of inputs) {
    const normalized = normalizeMirrorBase(input);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result;
}

/**
 * Matches a candidate URL or host against the configured mirror allowlist by host.
 * Returns the matched normalized mirror base, or null if not allowlisted/invalid.
 */
export function matchConfiguredMirror(
  candidate: string | null | undefined,
  mirrors: ReadonlyArray<string>,
  options?: { allowBareHost?: boolean },
): string | null {
  if (!candidate || mirrors.length === 0) return null;

  let candidateHost: string;
  try {
    const candidateUrl = parseCandidateUrl(
      candidate,
      options?.allowBareHost ?? false,
    );
    candidateHost = candidateUrl.host.toLowerCase();
  } catch {
    return null;
  }

  for (const mirror of mirrors) {
    try {
      const normalized = normalizeMirrorBase(mirror);
      const mirrorUrl = new URL(normalized);
      if (mirrorUrl.host.toLowerCase() === candidateHost) {
        return normalized;
      }
    } catch {
      // Ignore malformed runtime mirror entries cleanly.
    }
  }

  return null;
}

/**
 * Resolves the active mirror base URL giving priority to an allowlisted `mirrorParam`,
 * falling back to an allowlisted `referrer`, or null when neither matches.
 */
export function resolveMirrorBase(params: {
  mirrorParam?: string | null;
  referrer?: string | null;
  mirrors?: ReadonlyArray<string>;
}): string | null {
  const mirrors = params.mirrors ?? [];
  if (mirrors.length === 0) return null;

  const fromParam = matchConfiguredMirror(params.mirrorParam, mirrors, {
    allowBareHost: true,
  });
  if (fromParam) return fromParam;

  return matchConfiguredMirror(params.referrer, mirrors, {
    allowBareHost: false,
  });
}
