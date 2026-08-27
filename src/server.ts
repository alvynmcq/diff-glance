import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import open from "open";
import pc from "picocolors";
import type { GlanceAnalysis } from "./ai.js";
import type { DiffStats } from "./diff.js";

export interface GlanceMeta {
  repoName: string;
  repoRoot: string;
  branch: string;
  rangeLabel: string;
  model: string;
  generatedAt: string;
  stats: DiffStats;
  truncated: boolean;
}

export interface GlanceView {
  analysis: GlanceAnalysis;
  meta: GlanceMeta;
}

export interface ServeOptions {
  host: string;
  port: number;
  openBrowser: boolean;
}

const PAYLOAD_TOKEN = "__GLANCE_PAYLOAD__";

export async function loadTemplate(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFile(join(here, "template.html"), "utf8");
}

export async function renderHtml(view: GlanceView): Promise<string> {
  const template = await loadTemplate();
  if (!template.includes(PAYLOAD_TOKEN)) {
    throw new Error("viewer template is missing the payload token");
  }
  return template.replace(PAYLOAD_TOKEN, safeJson(view));
}

export async function writeHtmlFile(view: GlanceView, outputPath: string): Promise<void> {
  const html = await renderHtml(view);
  await writeFile(outputPath, html, "utf8");
}

export async function startViewer(view: GlanceView, options: ServeOptions): Promise<void> {
  const html = await renderHtml(view);
  const server = createServer((req, res) => {
    handleRequest(req, res, html);
  });

  const port = await listen(server, options.host, options.port);
  const url = `http://${options.host}:${port}`;
  console.error(pc.dim(`diff-glance: viewer at ${url}`));
  console.error(pc.dim("diff-glance: press Ctrl+C to stop"));

  if (options.openBrowser) {
    await open(url);
  }

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      server.close(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

function handleRequest(req: IncomingMessage, res: ServerResponse, html: string): void {
  const url = req.url ?? "/";
  const path = url.split("?")[0] ?? "/";

  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(html);
    return;
  }

  if (req.method === "GET" && path === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.address();
      if (typeof address === "object" && address) {
        resolve(address.port);
        return;
      }
      resolve(port);
    });
  });
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
