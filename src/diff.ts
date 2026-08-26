import { execFile as execFileCallback } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export type ChangeKind = "added" | "modified" | "deleted" | "renamed";

export interface DiffFile {
  path: string;
  oldPath?: string;
  kind: ChangeKind;
  additions: number;
  deletions: number;
  patch: string;
  truncated: boolean;
  binary: boolean;
}

export interface DiffStats {
  files: number;
  additions: number;
  deletions: number;
}

export interface DiffPayload {
  repoRoot: string;
  repoName: string;
  branch: string;
  rangeLabel: string;
  files: DiffFile[];
  stats: DiffStats;
  truncated: boolean;
  prompt: string;
}

export interface DiffRequest {
  cwd: string;
  staged: boolean;
  commit?: string;
  from?: string;
  to?: string;
  maxChars: number;
}

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const UNTRACKED_MAX_BYTES = 256 * 1024;
const PER_FILE_PATCH_CAP = 16_000;

const IGNORE_BASENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "poetry.lock",
  "uv.lock",
  "Gemfile.lock",
  ".DS_Store",
]);

const IGNORE_SUFFIXES = [
  ".lock",
  ".min.js",
  ".min.css",
  ".map",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".mp3",
  ".zip",
  ".gz",
  ".tgz",
  ".wasm",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".parquet",
];

const IGNORE_DIR_MARKERS = [
  "/node_modules/",
  "/dist/",
  "/build/",
  "/coverage/",
  "/.next/",
  "/vendor/",
  "/.turbo/",
  "/out/",
  "/.git/",
];

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

export async function extractDiff(request: DiffRequest): Promise<DiffPayload> {
  const repoRoot = await gitRoot(request.cwd);
  const [branch, hasHead] = await Promise.all([gitBranch(repoRoot), refExists(repoRoot, "HEAD")]);
  const rangeLabel = describeRange(request, hasHead);
  const diffArgs = buildDiffArgs(request, hasHead);

  const [nameStatusRaw, numstatRaw, patchRaw] = await Promise.all([
    git(repoRoot, ["diff", "-z", "--name-status", "-M", ...diffArgs, "--"]),
    git(repoRoot, ["diff", "--numstat", "-M", ...diffArgs, "--"]),
    git(repoRoot, ["diff", "--unified=3", "-M", ...diffArgs, "--"]),
  ]);

  const statuses = parseNameStatus(nameStatusRaw);
  const statsByPath = parseNumstat(numstatRaw);
  const patches = splitPatches(patchRaw);

  let files: DiffFile[] = statuses
    .filter((entry) => !shouldIgnore(entry.path))
    .map((entry) => {
      const nums = statsByPath.get(entry.path) ?? statsByPath.get(entry.oldPath ?? "") ?? {
        additions: 0,
        deletions: 0,
        binary: false,
      };
      const patch = patches.get(entry.path) ?? patches.get(entry.oldPath ?? "") ?? "";
      const binary = nums.binary || isBinaryPatch(patch);
      return {
        path: entry.path,
        oldPath: entry.oldPath,
        kind: entry.kind,
        additions: nums.additions,
        deletions: nums.deletions,
        patch: binary ? "" : patch,
        truncated: false,
        binary,
      };
    });

  if (shouldIncludeUntracked(request)) {
    const untracked = await collectUntracked(repoRoot);
    const seen = new Set(files.map((file) => file.path));
    for (const extra of untracked) {
      if (!seen.has(extra.path)) {
        files.push(extra);
        seen.add(extra.path);
      }
    }
  }

  const budgeted = applyBudget(files, request.maxChars);
  const stats = summarize(budgeted.files);

  return {
    repoRoot,
    repoName: basename(repoRoot),
    branch,
    rangeLabel,
    files: budgeted.files,
    stats,
    truncated: budgeted.truncated,
    prompt: buildPrompt(budgeted.files, stats, rangeLabel, budgeted.truncated),
  };
}

async function gitRoot(cwd: string): Promise<string> {
  try {
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    return root.trim();
  } catch (error) {
    if (error instanceof GitError && /not a git repository/i.test(error.message)) {
      throw new GitError("not a git repository");
    }
    throw error;
  }
}

async function gitBranch(cwd: string): Promise<string> {
  try {
    const symbolic = (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    if (symbolic) {
      return symbolic;
    }
  } catch {
    // detached HEAD
  }
  try {
    return (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
  } catch {
    return "unborn";
  }
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function buildDiffArgs(request: DiffRequest, hasHead: boolean): string[] {
  if (request.commit) {
    return [`${request.commit}^!`];
  }
  if (request.staged) {
    return request.from ? ["--cached", request.from] : ["--cached"];
  }
  if (request.from && request.to) {
    return [request.from, request.to];
  }
  if (request.from) {
    return [request.from];
  }
  return hasHead ? ["HEAD"] : ["--cached"];
}

function describeRange(request: DiffRequest, hasHead: boolean): string {
  if (request.commit) {
    return `commit ${request.commit}`;
  }
  if (request.staged) {
    return request.from ? `staged vs ${request.from}` : "staged";
  }
  if (request.from && request.to) {
    return `${request.from}..${request.to}`;
  }
  if (request.from) {
    return `${request.from} → worktree`;
  }
  return hasHead ? "HEAD → worktree" : "worktree";
}

function shouldIncludeUntracked(request: DiffRequest): boolean {
  return !request.staged && !request.commit && !request.to;
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile("git", ["-c", "color.ui=never", ...args], {
      cwd,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: "utf8",
    });
    return stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") {
      throw new GitError("git executable not found in PATH");
    }
    const stderr = (err.stderr ?? "").trim();
    throw new GitError(stderr || err.message || "git command failed");
  }
}

interface StatusEntry {
  kind: ChangeKind;
  path: string;
  oldPath?: string;
}

function parseNameStatus(raw: string): StatusEntry[] {
  const tokens = raw.split("\0").filter((token) => token.length > 0);
  const entries: StatusEntry[] = [];
  let i = 0;

  while (i < tokens.length) {
    const status = tokens[i];
    if (!status) {
      break;
    }
    const code = status.charAt(0);
    if ((code === "R" || code === "C") && tokens[i + 1] && tokens[i + 2]) {
      const oldPath = tokens[i + 1] ?? "";
      const path = tokens[i + 2] ?? "";
      entries.push({ kind: "renamed", path, oldPath });
      i += 3;
      continue;
    }
    const path = tokens[i + 1];
    if (!path) {
      i += 1;
      continue;
    }
    const kind: ChangeKind = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
    entries.push({ kind, path });
    i += 2;
  }

  return entries;
}

interface NumstatEntry {
  additions: number;
  deletions: number;
  binary: boolean;
}

function parseNumstat(raw: string): Map<string, NumstatEntry> {
  const map = new Map<string, NumstatEntry>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match) {
      continue;
    }
    const addToken = match[1] ?? "0";
    const delToken = match[2] ?? "0";
    const pathField = match[3] ?? "";
    const binary = addToken === "-" || delToken === "-";
    const path = parseNumstatPath(pathField);
    map.set(path, {
      additions: binary ? 0 : Number(addToken),
      deletions: binary ? 0 : Number(delToken),
      binary,
    });
  }
  return map;
}

function parseNumstatPath(field: string): string {
  const braced = field.match(/^(.*)\{(.*?) => (.*?)\}(.*)$/);
  if (braced) {
    return `${braced[1] ?? ""}${braced[3] ?? ""}${braced[4] ?? ""}`;
  }
  const plain = field.split(" => ");
  if (plain.length === 2 && plain[1]) {
    return plain[1];
  }
  return field;
}

function splitPatches(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw.trim()) {
    return map;
  }
  const chunks = raw.split(/^diff --git /m);
  for (const chunk of chunks) {
    if (!chunk.trim()) {
      continue;
    }
    const body = `diff --git ${chunk}`.trimEnd();
    const header = body.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (!header) {
      continue;
    }
    const bPath = header[2] ?? header[1];
    if (bPath) {
      map.set(bPath, body);
    }
  }
  return map;
}

function isBinaryPatch(patch: string): boolean {
  return /GIT binary patch/i.test(patch) || /Binary files .* differ/i.test(patch);
}

export function shouldIgnore(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  if (IGNORE_BASENAMES.has(base)) {
    return true;
  }
  if (IGNORE_SUFFIXES.some((suffix) => base.endsWith(suffix))) {
    return true;
  }
  const wrapped = `/${normalized}/`;
  return IGNORE_DIR_MARKERS.some((marker) => wrapped.includes(marker));
}

async function collectUntracked(repoRoot: string): Promise<DiffFile[]> {
  const listed = await git(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]);
  const paths = listed.split("\0").filter((path) => path.length > 0 && !shouldIgnore(path));
  const files: DiffFile[] = [];

  for (const relPath of paths) {
    const abs = join(repoRoot, relPath);
    try {
      const info = await stat(abs);
      if (!info.isFile() || info.size > UNTRACKED_MAX_BYTES) {
        continue;
      }
      const buffer = await readFile(abs);
      if (buffer.includes(0)) {
        files.push({
          path: relPath,
          kind: "added",
          additions: 0,
          deletions: 0,
          patch: "",
          truncated: false,
          binary: true,
        });
        continue;
      }
      const content = buffer.toString("utf8");
      const lines = content.split("\n");
      files.push({
        path: relPath,
        kind: "added",
        additions: lines.length,
        deletions: 0,
        patch: inventAddedPatch(relPath, lines),
        truncated: false,
        binary: false,
      });
    } catch {
      continue;
    }
  }

  return files;
}

function inventAddedPatch(path: string, lines: string[]): string {
  const body = lines.map((line) => `+${line}`).join("\n");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`,
    body,
  ].join("\n");
}

function applyBudget(
  files: DiffFile[],
  maxChars: number,
): { files: DiffFile[]; truncated: boolean } {
  const ranked = [...files].sort((a, b) => a.patch.length - b.patch.length);
  let used = 0;
  let truncated = false;
  const kept = new Map<string, DiffFile>();

  for (const file of ranked) {
    if (file.binary || file.patch.length === 0) {
      kept.set(file.path, file);
      continue;
    }

    const cap = Math.min(PER_FILE_PATCH_CAP, Math.max(maxChars - used, 0));
    if (cap <= 0) {
      truncated = true;
      kept.set(file.path, { ...file, patch: "", truncated: true });
      continue;
    }

    if (file.patch.length <= cap) {
      used += file.patch.length;
      kept.set(file.path, file);
      continue;
    }

    truncated = true;
    used += cap;
    kept.set(file.path, {
      ...file,
      patch: `${file.patch.slice(0, cap)}\n\n[truncated]\n`,
      truncated: true,
    });
  }

  return {
    files: files.map((file) => kept.get(file.path) ?? file),
    truncated,
  };
}

function summarize(files: DiffFile[]): DiffStats {
  return files.reduce<DiffStats>(
    (acc, file) => ({
      files: acc.files + 1,
      additions: acc.additions + file.additions,
      deletions: acc.deletions + file.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}

function buildPrompt(
  files: DiffFile[],
  stats: DiffStats,
  rangeLabel: string,
  truncated: boolean,
): string {
  const listing = files
    .map((file) => {
      const tag = kindTag(file.kind);
      const rename = file.oldPath ? ` (${file.oldPath} → ${file.path})` : "";
      const binary = file.binary ? " [binary]" : "";
      const cut = file.truncated ? " [truncated]" : "";
      return `${tag}  ${file.path}${rename}  +${file.additions} -${file.deletions}${binary}${cut}`;
    })
    .join("\n");

  const patches = files
    .filter((file) => file.patch.length > 0)
    .map((file) => file.patch)
    .join("\n\n");

  const notice = truncated
    ? "\nNote: some patches were truncated to fit the model context window.\n"
    : "";

  return [
    `Range: ${rangeLabel}`,
    `Files: ${stats.files}  +${stats.additions} / -${stats.deletions}`,
    "",
    "Changed files:",
    listing || "(none)",
    notice,
    "Patches:",
    patches || "(no textual patches)",
  ].join("\n");
}

function kindTag(kind: ChangeKind): string {
  switch (kind) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    default:
      return "M";
  }
}
