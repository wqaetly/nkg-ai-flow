/** Hex-encoded SHA-256 using the Web Crypto API available in Node >= 19 and modern WebViews. */
export async function sha256HexPortable(input: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "SHA-256 requires globalThis.crypto.subtle (Node >= 19 or a modern browser)",
    );
  }
  const bytes = new TextEncoder().encode(input);
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
