export const FALLBACK_SIDECAR_URL = "http://127.0.0.1:5173";

export interface ResolveInitialSidecarUrlOptions {
  readonly search?: string;
  readonly injected?: unknown;
  readonly stored?: string | null;
}

/** Resolve the sidecar endpoint used during Studio bootstrap. */
export function resolveInitialSidecarUrl(
  options: ResolveInitialSidecarUrlOptions,
): string {
  const requested = new URLSearchParams(options.search ?? "").get("sidecar");
  return (
    validHttpUrl(requested) ??
    validHttpUrl(options.injected) ??
    validHttpUrl(options.stored) ??
    FALLBACK_SIDECAR_URL
  );
}

function validHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().replace(/\/+$/, "");
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}
