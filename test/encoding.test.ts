import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirs = new Set([
  ".git",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);
const textExtensions = new Set([
  ".css",
  ".html",
  ".json",
  ".jsonc",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
]);

const mojibakePattern = new RegExp(
  [
    "[\\uFFFD\\uE000-\\uF8FF]",
    "\\u00C3",
    "\\u00C2",
    "\\u9225",
    "\\u923B",
    "\\u922B",
    "\\u951B",
    "\\u9428",
    "\\u9359",
    "\\u6D93\\u20AC",
    "\\u7487",
    "\\u938F",
    "\\u93C2",
    "\\u5BEE",
    "\\u59AF",
    "\\u9477",
    "\\u6769",
    "\\u7AD4",
    "\\u7039",
    "\\u95AB",
    "\\u6402",
    "\\u8133",
    "\\u4E7F",
    "\\u4E1F",
    "\\u4E3C",
    "\\u4E12",
    "\\u4E37",
    "\\u4E63",
    "\\u9200",
  ].join("|"),
  "u",
);

function collectTextFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue;

    const absolute = path.join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      collectTextFiles(absolute, files);
      continue;
    }

    if (textExtensions.has(path.extname(entry))) {
      files.push(absolute);
    }
  }

  return files;
}

describe("text encoding", () => {
  it("does not contain common Chinese mojibake markers", () => {
    const offenders = collectTextFiles(repoRoot).flatMap((file) => {
      const content = readFileSync(file, "utf8");
      return content.match(mojibakePattern)
        ? [path.relative(repoRoot, file).replace(/\\/g, "/")]
        : [];
    });

    expect(offenders).toEqual([]);
  });
});
