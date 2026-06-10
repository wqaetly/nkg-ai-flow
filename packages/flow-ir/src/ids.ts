/**
 * Stable ID generation utilities.
 *
 * Phase 0 must produce IDs that are:
 *   - globally unique within a Flow,
 *   - deterministic when given an explicit hint,
 *   - human-readable for debugging.
 *
 * For non-explicit IDs, the Builder uses a per-Builder counter so that
 * `dump()` produces deterministic JSON for the same construction sequence.
 * Random IDs are intentionally avoided here to keep `dump()` reproducible.
 */

const SAFE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const MAX_SLUG_LENGTH = 48;

/**
 * Allocator that produces deterministic IDs scoped to a single Builder
 * instance. Two builders constructing the same flow in the same order will
 * therefore yield identical IDs, which is required for deterministic dump().
 */
export class IdAllocator {
  private readonly counters = new Map<string, number>();
  private readonly used = new Set<string>();

  /**
   * Reserve an explicit ID. Throws if it has already been reserved in this
   * allocator. The caller (Builder) is expected to surface this as a
   * validation error with the proper RuntimeError code.
   */
  reserveExplicit(id: string): void {
    if (this.used.has(id)) {
      throw new Error(`duplicate id: ${id}`);
    }
    this.used.add(id);
  }

  /**
   * Generate a stable ID with a deterministic counter, e.g. `node_llm_01`,
   * `node_llm_02`. The slug is sanitised to be safe for JSON / URLs.
   */
  allocate(prefix: string, slug?: string): string {
    const safeSlug = sanitizeSlug(slug);
    const key = safeSlug ? `${prefix}_${safeSlug}` : prefix;
    for (;;) {
      const next = (this.counters.get(key) ?? 0) + 1;
      this.counters.set(key, next);
      const candidate = `${key}_${pad2(next)}`;
      if (!this.used.has(candidate)) {
        this.used.add(candidate);
        return candidate;
      }
    }
  }

  /** True iff the given id was already produced or reserved. */
  has(id: string): boolean {
    return this.used.has(id);
  }
}

export function sanitizeSlug(slug: string | undefined): string {
  if (!slug) {
    return "";
  }
  const cleaned = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
  return cleaned;
}

export function isValidId(id: string): boolean {
  return SAFE_ID_PATTERN.test(id) && id.length <= 128;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
