/**
 * Node-only tools for the built-in `agent` node.
 *
 * Kept out of `agent.ts` so browser-safe node definitions do not import
 * `node:fs` / `node:child_process`.
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type {
  AgentToolCall,
  AgentToolHost,
  AgentToolName,
  AgentToolResult,
} from "./agent.js";

const execFileAsync = promisify(execFile);
const TEXT_EXTENSIONS = new Set([
  ".c",
  ".css",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

export function createNodeAgentToolHost(): AgentToolHost {
  return {
    async callTool(call, env) {
      if (!env.allowedTools.includes(call.tool)) {
        return { ok: false, error: `Tool "${call.tool}" is not allowed.` };
      }
      try {
        const root = resolveRoot(env.workingDir);
        switch (call.tool) {
          case "list_files":
            return await listFiles(root, call.args, env.context, env.maxOutputChars);
          case "read_file":
            return await readTextFile(root, call.args, env.context, env.maxOutputChars);
          case "grep":
            return await grepFiles(root, call.args, env.context, env.maxOutputChars);
          case "edit_file":
            return await editFile(root, call.args, env.context, env.maxOutputChars);
          case "write_files":
            return await writeFiles(root, call.args, env.context);
          case "run_bash":
            if (!env.allowBash) {
              return { ok: false, error: "run_bash is disabled." };
            }
            return await runBash(root, call.args, env.timeoutMs, env.maxOutputChars);
        }
      } catch (cause) {
        return { ok: false, error: (cause as Error).message };
      }
    },
  };
}

function resolveRoot(workingDir: string): string {
  return path.resolve(workingDir && workingDir.trim() ? workingDir : process.cwd());
}

function resolveInside(root: string, userPath: unknown): string {
  if (typeof userPath !== "string" || !userPath.trim()) {
    throw new Error("path must be a non-empty string");
  }
  const target = path.resolve(root, userPath);
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes working_dir: ${userPath}`);
  }
  return target;
}

function resolveOptionalPath(
  root: string,
  args: Record<string, unknown>,
  context: Record<string, unknown> | undefined,
): string | undefined {
  const value =
    typeof args.path === "string"
      ? args.path
      : typeof args.path_ref === "string"
        ? contextString(context, args.path_ref, "path_ref")
        : undefined;
  return value === undefined ? undefined : resolveInside(root, value);
}

function contextString(
  context: Record<string, unknown> | undefined,
  ref: unknown,
  label: string,
): string {
  if (typeof ref !== "string" || !ref.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (!context) {
    throw new Error(`${label} cannot be resolved because no context was provided`);
  }
  const value = readContextPath(context, ref);
  if (typeof value !== "string") {
    throw new Error(`${label} "${ref}" did not resolve to a string`);
  }
  return shouldDereferenceContextRef(ref)
    ? dereferenceContextString(context, value, ref, label)
    : value;
}

function readContextPath(context: Record<string, unknown>, ref: string): unknown {
  let cursor: unknown = context;
  for (const segment of ref.split(".")) {
    if (!segment) throw new Error(`invalid context ref "${ref}"`);
    if (Array.isArray(cursor) && /^\d+$/.test(segment)) {
      cursor = cursor[Number(segment)];
    } else if (
      cursor &&
      typeof cursor === "object" &&
      segment in (cursor as Record<string, unknown>)
    ) {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function shouldDereferenceContextRef(ref: string): boolean {
  return /(?:^|\.)[a-zA-Z0-9_]*(?:pathRef|contentsRef)$/.test(ref);
}

function dereferenceContextString(
  context: Record<string, unknown>,
  refValue: string,
  originalRef: string,
  label: string,
): string {
  const dereferenced = readContextPath(context, refValue);
  if (typeof dereferenced !== "string") {
    throw new Error(
      `${label} "${originalRef}" resolved to "${refValue}", but that did not resolve to a string`,
    );
  }
  return dereferenced;
}

async function listFiles(
  root: string,
  args: Record<string, unknown>,
  context: Record<string, unknown> | undefined,
  maxOutputChars: number,
): Promise<AgentToolResult> {
  const start = resolveOptionalPath(root, args, context) ?? root;
  const recursive = args.recursive === true;
  const maxEntries = numberArg(args.max_entries, 200);
  const entries: string[] = [];

  async function walk(abs: string): Promise<void> {
    if (entries.length >= maxEntries) return;
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (entries.length >= maxEntries) return;
      const child = path.join(abs, entry.name);
      const rel = toPosix(path.relative(root, child));
      entries.push(entry.isDirectory() ? `${rel}/` : rel);
      if (recursive && entry.isDirectory()) await walk(child);
    }
  }

  await walk(start);
  return { ok: true, output: truncate(entries, maxOutputChars) };
}

async function readTextFile(
  root: string,
  args: Record<string, unknown>,
  context: Record<string, unknown> | undefined,
  maxOutputChars: number,
): Promise<AgentToolResult> {
  const abs = resolveOptionalPath(root, args, context);
  if (!abs) {
    throw new Error("path or path_ref must resolve to a non-empty string");
  }
  const content = await readFile(abs, "utf8");
  const maxChars = Math.min(numberArg(args.max_chars, maxOutputChars), maxOutputChars);
  return {
    ok: true,
    output: {
      path: toPosix(path.relative(root, abs)),
      content:
        content.length > maxChars ? `${content.slice(0, maxChars)}...` : content,
    },
  };
}

async function grepFiles(
  root: string,
  args: Record<string, unknown>,
  context: Record<string, unknown> | undefined,
  maxOutputChars: number,
): Promise<AgentToolResult> {
  if (typeof args.pattern !== "string" || !args.pattern) {
    throw new Error("pattern must be a non-empty string");
  }
  const start = resolveOptionalPath(root, args, context) ?? root;
  const pattern = new RegExp(args.pattern);
  const maxMatches = numberArg(args.max_matches, 100);
  const matches: Array<{ path: string; line: number; text: string }> = [];

  async function walk(abs: string): Promise<void> {
    if (matches.length >= maxMatches) return;
    const info = await stat(abs);
    if (info.isDirectory()) {
      for (const entry of await readdir(abs)) await walk(path.join(abs, entry));
      return;
    }
    if (!isLikelyTextFile(abs)) return;
    const content = await readFile(abs, "utf8").catch(() => "");
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length && matches.length < maxMatches; i += 1) {
      if (pattern.test(lines[i] ?? "")) {
        matches.push({
          path: toPosix(path.relative(root, abs)),
          line: i + 1,
          text: lines[i] ?? "",
        });
      }
    }
  }

  await walk(start);
  return { ok: true, output: truncate(matches, maxOutputChars) };
}

async function editFile(
  root: string,
  args: Record<string, unknown>,
  context: Record<string, unknown> | undefined,
  maxOutputChars: number,
): Promise<AgentToolResult> {
  const abs = resolveOptionalPath(root, args, context);
  if (!abs) {
    throw new Error("path or path_ref must resolve to a non-empty string");
  }
  const rel = toPosix(path.relative(root, abs));
  const newText =
    typeof args.new_text === "string"
      ? args.new_text
      : typeof args.new_text_ref === "string"
        ? contextString(context, args.new_text_ref, "new_text_ref")
        : undefined;
  if (newText === undefined) {
    throw new Error("new_text or new_text_ref must resolve to a string");
  }

  let next: string;
  if (typeof args.old_text === "string") {
    const current = await readFile(abs, "utf8");
    if (!current.includes(args.old_text)) {
      return {
        ok: false,
        error: `old_text not found in ${rel}`,
        output: {
          path: rel,
          oldTextLength: args.old_text.length,
          currentExcerpt: truncateString(current, maxOutputChars),
        },
      };
    }
    next = current.replace(args.old_text, newText);
  } else {
    if (args.create !== true) {
      await stat(abs);
    }
    next = newText;
  }

  await writeTextFileAtomic(abs, next);
  return { ok: true, output: { path: rel, bytes: next.length }, changedFiles: [rel] };
}

async function writeTextFileAtomic(abs: string, contents: string): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  const tmp = path.join(
    path.dirname(abs),
    `.${path.basename(abs)}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, abs);
}

async function writeFiles(
  root: string,
  args: Record<string, unknown>,
  context: Record<string, unknown> | undefined,
): Promise<AgentToolResult> {
  const entries = resolveWriteFileEntries(args, context);
  if (entries.length === 0) {
    throw new Error("files or files_ref must contain at least one file entry");
  }

  const pending = entries.map((entry) => {
    const abs = resolveInside(
      root,
      resolveFileEntryString(entry, context, ["path", "path_ref", "pathRef"]),
    );
    const rel = toPosix(path.relative(root, abs));
    const contents = resolveFileEntryString(entry, context, [
      "contents",
      "contents_ref",
      "new_text",
      "new_text_ref",
      "contentsRef",
    ]);
    return { abs, rel, contents };
  });

  const seenPaths = new Set<string>();
  const duplicatePaths = new Set<string>();
  for (const file of pending) {
    const pathKey = file.rel.toLowerCase();
    if (seenPaths.has(pathKey)) {
      duplicatePaths.add(file.rel);
    }
    seenPaths.add(pathKey);
  }
  if (duplicatePaths.size > 0) {
    return {
      ok: false,
      error: `duplicate file path in write_files batch: ${[...duplicatePaths].join(", ")}`,
      output: {
        kind: "duplicate_paths",
        duplicatePaths: [...duplicatePaths],
        plannedPaths: pending.map((file) => file.rel),
      },
    };
  }

  if (args.create !== true) {
    const missingFiles: string[] = [];
    for (const file of pending) {
      await stat(file.abs).catch(() => missingFiles.push(file.rel));
    }
    if (missingFiles.length > 0) {
      return {
        ok: false,
        error: `files do not exist in write_files batch; pass create=true to create them: ${missingFiles.join(", ")}`,
        output: {
          kind: "missing_files",
          missingFiles,
          plannedPaths: pending.map((file) => file.rel),
        },
      };
    }
  }

  const written: Array<{ path: string; bytes: number }> = [];
  for (const file of pending) {
    await writeTextFileAtomic(file.abs, file.contents);
    written.push({ path: file.rel, bytes: file.contents.length });
  }

  return {
    ok: true,
    output: { files: written },
    changedFiles: written.map((file) => file.path),
  };
}

function resolveWriteFileEntries(
  args: Record<string, unknown>,
  context: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  const value =
    Array.isArray(args.files)
      ? args.files
      : typeof args.files_ref === "string"
        ? readContextPathOrThrow(context, args.files_ref, "files_ref")
        : undefined;
  if (!Array.isArray(value)) {
    throw new Error("files must be an array or files_ref must resolve to an array");
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`file entry ${index} must be an object`);
    }
    return entry as Record<string, unknown>;
  });
}

function resolveFileEntryString(
  entry: Record<string, unknown>,
  context: Record<string, unknown> | undefined,
  keys: readonly string[],
): string {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value !== "string") continue;
    if (key.endsWith("_ref") || key.endsWith("Ref")) {
      return contextString(context, value, key);
    }
    return value;
  }
  throw new Error(`file entry must include one of: ${keys.join(", ")}`);
}

function readContextPathOrThrow(
  context: Record<string, unknown> | undefined,
  ref: string,
  label: string,
): unknown {
  if (!context) {
    throw new Error(`${label} cannot be resolved because no context was provided`);
  }
  return readContextPath(context, ref);
}

async function runBash(
  root: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  maxOutputChars: number,
): Promise<AgentToolResult> {
  if (typeof args.command !== "string" || !args.command.trim()) {
    throw new Error("command must be a non-empty string");
  }
  const requestedTimeout = numberArg(args.timeout_ms, timeoutMs);
  const timeout = Math.min(requestedTimeout, timeoutMs);
  const shell = os.platform() === "win32" ? "powershell.exe" : "/bin/sh";
  const shellArgs =
    os.platform() === "win32"
      ? ["-NoProfile", "-Command", args.command]
      : ["-c", args.command];
  try {
    const { stdout, stderr } = await execFileAsync(shell, shellArgs, {
      cwd: root,
      timeout,
      maxBuffer: Math.max(maxOutputChars * 2, 64_000),
    });
    return {
      ok: true,
      output: {
        exitCode: 0,
        stdout: truncateString(stdout, maxOutputChars),
        stderr: truncateString(stderr, maxOutputChars),
      },
    };
  } catch (cause) {
    const failed = cause as {
      message?: string;
      code?: number | string;
      signal?: string;
      stdout?: string;
      stderr?: string;
    };
    return {
      ok: false,
      error: failed.message ?? "command failed",
      output: {
        exitCode: failed.code,
        signal: failed.signal,
        stdout: truncateString(failed.stdout ?? "", maxOutputChars),
        stderr: truncateString(failed.stderr ?? "", maxOutputChars),
      },
    };
  }
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function truncate<T>(value: T, maxOutputChars: number): T | string {
  const json = JSON.stringify(value);
  return json.length > maxOutputChars ? `${json.slice(0, maxOutputChars)}...` : value;
}

function truncateString(value: string, maxOutputChars: number): string {
  return value.length > maxOutputChars
    ? `${value.slice(0, maxOutputChars)}...`
    : value;
}

function isLikelyTextFile(abs: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(abs).toLowerCase());
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

export type { AgentToolName };
