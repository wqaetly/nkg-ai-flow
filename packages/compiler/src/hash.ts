/**
 * Canonical JSON serialisation + sha256 hashing for compiler artifacts.
 *
 * Spec invariant: the same `(definition, runnerSrc)` pair MUST produce
 * the same hash, regardless of the property insertion order in the
 * runtime objects. We achieve this by:
 *
 *   1. `canonicalJSON(value)` walks the value, sorts object keys
 *      alphabetically at every depth, and uses `JSON.stringify` with no
 *      indentation. Arrays preserve order (semantic).
 *   2. `sha256Hex(text)` hashes the canonical bytes via Web Crypto. We
 *      use `globalThis.crypto.subtle` so this stays runtime-agnostic
 *      (Node ≥19 and browsers).
 *
 * The compiler keeps these helpers exported because tests + downstream
 * tools (Studio diffing, replay) want to verify artifact integrity
 * without re-pulling esbuild or a heavyweight serialisation lib.
 */

/**
 * Stable, key-sorted JSON.stringify. Throws on non-JSON values
 * (`undefined`, functions, symbols) so the caller sees the violation
 * immediately rather than producing an unhashable artifact.
 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((v) => canonicalise(v));
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = canonicalise(obj[key]);
    }
    return out;
  }
  // Primitives JSON can represent.
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  // Anything else: undefined / function / symbol / bigint. These don't
  // round-trip through JSON, so reject loudly. The caller always has a
  // chance to remove them before compiling (e.g. drop helper functions
  // off the definition).
  throw new TypeError(
    `canonicalJSON: cannot serialise value of type ${typeof value}`,
  );
}

/**
 * Hex-encoded SHA-256 of `text`. Uses Web Crypto for portability across
 * Node / browsers. Falls back to throwing a descriptive error in
 * the (unlikely) case `crypto.subtle` is missing — Phase 3 only targets
 * runtimes that ship it.
 */
export async function sha256Hex(text: string): Promise<string> {
  const subtle: SubtleCrypto | undefined = (
    globalThis as { crypto?: { subtle?: SubtleCrypto } }
  ).crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "sha256Hex requires a runtime exposing globalThis.crypto.subtle (Node ≥19 or modern browsers)",
    );
  }
  const bytes = new TextEncoder().encode(text);
  const digest = await subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let hex = "";
  for (const b of view) hex += b.toString(16).padStart(2, "0");
  return hex;
}
