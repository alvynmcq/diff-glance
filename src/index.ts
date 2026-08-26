import { resolve } from "node:path";
import { Command } from "commander";
import type { Ora } from "ora";
import open from "open";
import ora from "ora";
import pc from "picocolors";
import { analyzeDiff, resolveLlmConfig } from "./ai.js";
import { extractDiff, GitError } from "./diff.js";
import { sanitizeMermaid } from "./sanitize.js";
import { startViewer, writeHtmlFile, type GlanceView } from "./server.js";

interface CliOptions {
  staged: boolean;
  commit?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  port: string;
  host: string;
  open: boolean;
  json: boolean;
  maxChars: string;
  output?: string;
}

const DEFAULT_MAX_CHARS = 80_000;

async function main(): Promise<void> {
  const program = new Command()
    .name("git-glance")
    .description("Turn a git diff into an ELI5 summary and a Mermaid architecture diagram.")
    .version("0.1.0")
    .argument("[from]", "Base git ref")
    .argument("[to]", "Head git ref")
    .option("-s, --staged", "Analyze staged changes only", false)
    .option("-c, --commit <sha>", "Analyze a specific commit")
    .option("-m, --model <id>", "Model id (or GIT_GLANCE_MODEL)")
    .option("--base-url <url>", "OpenAI-compatible API base URL")
    .option("--api-key <key>", "API key (or OPENAI_API_KEY)")
    .option("-p, --port <n>", "Viewer port (0 = ephemeral)", "0")
    .option("--host <host>", "Viewer bind host", "127.0.0.1")
    .option("--no-open", "Do not open a browser")
    .option("--json", "Print analysis JSON to stdout", false)
    .option("--max-chars <n>", "Max diff characters sent to the model", String(DEFAULT_MAX_CHARS))
    .option("-o, --output <file>", "Write an HTML report instead of serving")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ git-glance",
        "  $ git-glance --staged",
        "  $ git-glance main",
        "  $ git-glance main HEAD",
        "  $ git-glance --commit HEAD",
        "  $ git-glance --json",
        "  $ git-glance --model gemini-3.6-flash",
        "  $ git-glance --base-url http://127.0.0.1:11434/v1 --model llama3.2",
      ].join("\n"),
    )
    .action(async (from: string | undefined, to: string | undefined, opts: CliOptions) => {
      await runGlance(from, to, opts);
    });

  await program.parseAsync(process.argv);
}

async function runGlance(
  from: string | undefined,
  to: string | undefined,
  opts: CliOptions,
): Promise<void> {
  const maxChars = parsePositiveInt(opts.maxChars, "--max-chars");
  const port = parsePort(opts.port);
  let spinner: Ora | undefined;

  try {
    spinner = ora({ text: "git-glance: analyzing diff...", color: "cyan", spinner: "dots" }).start();

    const payload = await extractDiff({
      cwd: process.cwd(),
      staged: opts.staged,
      commit: opts.commit,
      from,
      to,
      maxChars,
    });

    if (payload.files.length === 0) {
      spinner.stop();
      console.error("git-glance: no changes to analyze");
      return;
    }

    const llm = resolveLlmConfig({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      model: opts.model,
    });

    spinner.text = "git-glance: generating summary...";
    const analysis = await analyzeDiff(payload, {
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      model: opts.model,
    });
    analysis.mermaid = sanitizeMermaid(analysis.mermaid, payload.files);

    const view: GlanceView = {
      analysis,
      meta: {
        repoName: payload.repoName,
        repoRoot: payload.repoRoot,
        branch: payload.branch,
        rangeLabel: payload.rangeLabel,
        model: llm.model,
        generatedAt: new Date().toISOString(),
        stats: payload.stats,
        truncated: payload.truncated,
      },
    };

    if (opts.json) {
      spinner.stop();
      process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
      return;
    }

    if (opts.output) {
      const outputPath = resolve(opts.output);
      spinner.text = "git-glance: writing report...";
      await writeHtmlFile(view, outputPath);
      spinner.stop();
      console.error(pc.dim(`git-glance: wrote ${outputPath}`));
      if (opts.open) {
        await open(outputPath);
      }
      return;
    }

    spinner.stop();
    await startViewer(view, {
      host: opts.host,
      port,
      openBrowser: opts.open,
    });
  } catch (error) {
    if (spinner?.isSpinning) {
      spinner.stop();
    }
    throw error;
  }
}

function parsePositiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return n;
}

function parsePort(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error("--port must be an integer between 0 and 65535");
  }
  return n;
}

function formatError(error: unknown): string {
  if (error instanceof GitError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

main().catch((error: unknown) => {
  console.error(pc.red(`git-glance: ${formatError(error)}`));
  if (process.env.GIT_GLANCE_DEBUG) {
    console.error(error);
  }
  process.exit(1);
});
