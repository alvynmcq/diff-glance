import OpenAI from "openai";
import type { ChangeKind, DiffFile, DiffPayload } from "./diff.js";

export type RiskLevel = "low" | "medium" | "high";

export interface GlanceFileNote {
  path: string;
  kind: ChangeKind;
  note: string;
}

export interface GlanceAnalysis {
  title: string;
  eli5: string;
  summary: string;
  impact: string;
  risk: RiskLevel;
  files: GlanceFileNote[];
  mermaid: string;
}

export interface LlmConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
}

export interface AnalyzeOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

const SYSTEM_PROMPT = `You are a principal engineer explaining a git diff to a teammate.
Reply with a single JSON object only. No markdown fences. No prose outside JSON.

JSON schema:
{
  "title": "short noun-phrase title of the change",
  "eli5": "2-4 sentences. Explain what changed and why it matters as if to a smart beginner. No jargon unless you define it.",
  "summary": "one technical paragraph covering the actual code changes",
  "impact": "who/what is affected, migration risk, tests to run",
  "risk": "low | medium | high",
  "files": [{ "path": "path", "kind": "added|modified|deleted|renamed", "note": "one-line description" }],
  "mermaid": "a Mermaid flowchart of the change, not the whole system"
}

Mermaid rules:
- First line: flowchart TD
- Node IDs: start with a letter, then only [A-Za-z0-9_]
- Labels must be double-quoted: Auth["Auth service"]
- Group related nodes with subgraph id["Layer name"] ... end
- Use class added|modified|deleted|renamed on changed nodes
- No click, href, javascript, style init directives, or HTML except <br/>
- At most 24 nodes. Prefer relationships between changed modules.
- Never invent files that are not in the diff.`;

const RISKS = new Set<RiskLevel>(["low", "medium", "high"]);
const KINDS = new Set<ChangeKind>(["added", "modified", "deleted", "renamed"]);

export function resolveLlmConfig(options: AnalyzeOptions): LlmConfig {
  const baseURL =
    emptyToUndef(options.baseUrl) ??
    emptyToUndef(process.env.GIT_GLANCE_BASE_URL) ??
    emptyToUndef(process.env.OPENAI_BASE_URL) ??
    detectBaseUrl();

  const apiKey =
    emptyToUndef(options.apiKey) ??
    emptyToUndef(process.env.GIT_GLANCE_API_KEY) ??
    emptyToUndef(process.env.OPENAI_API_KEY) ??
    emptyToUndef(process.env.OPENROUTER_API_KEY) ??
    emptyToUndef(process.env.GROQ_API_KEY) ??
    emptyToUndef(process.env.GEMINI_API_KEY) ??
    emptyToUndef(process.env.GOOGLE_API_KEY) ??
    emptyToUndef(process.env.GOOGLE_GENERATIVE_AI_API_KEY) ??
    (isLocalCompatible(baseURL) ? "ollama" : undefined);

  if (!apiKey) {
    throw new Error(
      "missing API key. Set OPENAI_API_KEY or GEMINI_API_KEY, or pass --api-key. For Ollama: --base-url http://127.0.0.1:11434/v1 --model llama3.2",
    );
  }

  const model =
    emptyToUndef(options.model) ??
    emptyToUndef(process.env.GIT_GLANCE_MODEL) ??
    emptyToUndef(process.env.OPENAI_MODEL) ??
    defaultModel(baseURL);

  return baseURL ? { apiKey, baseURL, model } : { apiKey, model };
}

export async function analyzeDiff(
  payload: DiffPayload,
  options: AnalyzeOptions,
): Promise<GlanceAnalysis> {
  const config = resolveLlmConfig(options);
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultHeaders: openRouterHeaders(config.baseURL),
  });

  const userPrompt = [
    `Repository: ${payload.repoName}`,
    `Branch: ${payload.branch}`,
    payload.prompt,
  ].join("\n");

  const content = await completeJson(client, config.model, userPrompt);
  const parsed = parseJsonObject(content);
  return normalizeAnalysis(parsed, payload.files);
}

async function completeJson(client: OpenAI, model: string, userPrompt: string): Promise<string> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  let content = await createCompletion(client, model, messages, true);

  try {
    parseJsonObject(content);
    return content;
  } catch {
    messages.push(
      { role: "assistant", content },
      {
        role: "user",
        content:
          "Your previous reply was not valid JSON. Reply again with one JSON object matching the schema and nothing else.",
      },
    );
    content = await createCompletion(client, model, messages, true);
    parseJsonObject(content);
    return content;
  }
}

async function createCompletion(
  client: OpenAI,
  model: string,
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  jsonMode: boolean,
): Promise<string> {
  try {
    const completion = await client.chat.completions.create({
      model,
      messages,
      temperature: 0.2,
      ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
    });
    const text = completion.choices[0]?.message?.content?.trim();
    if (!text) {
      throw new Error("empty model response");
    }
    return text;
  } catch (error) {
    if (jsonMode && isFormatUnsupported(error)) {
      return createCompletion(client, model, messages, false);
    }
    throw new Error(formatLlmError(error));
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  const candidate = extractJsonLiteral(text);
  let value: unknown;
  try {
    value = JSON.parse(candidate) as unknown;
  } catch {
    throw new Error("model returned invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("model JSON was not an object");
  }
  return value as Record<string, unknown>;
}

function extractJsonLiteral(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? trimmed).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("model response did not contain a JSON object");
  }
  return body.slice(start, end + 1);
}

function normalizeAnalysis(raw: Record<string, unknown>, files: DiffFile[]): GlanceAnalysis {
  const riskRaw = asString(raw.risk).toLowerCase();
  const risk: RiskLevel = RISKS.has(riskRaw as RiskLevel) ? (riskRaw as RiskLevel) : "medium";

  const notes = parseFileNotes(raw.files);
  const notesByPath = new Map(notes.map((note) => [note.path, note]));
  const merged: GlanceFileNote[] = files.map((file) => {
    const existing = notesByPath.get(file.path);
    return {
      path: file.path,
      kind: existing && KINDS.has(existing.kind) ? existing.kind : file.kind,
      note: existing?.note ?? "",
    };
  });

  const title = asString(raw.title).trim() || fallbackTitle(files);
  const eli5 = asString(raw.eli5).trim() || "This diff could not be summarized.";
  const summary = asString(raw.summary).trim();
  const impact = asString(raw.impact).trim();
  const mermaid = asString(raw.mermaid).trim();

  return { title, eli5, summary, impact, risk, files: merged, mermaid };
}

function parseFileNotes(value: unknown): GlanceFileNote[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const notes: GlanceFileNote[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const rec = item as Record<string, unknown>;
    const path = asString(rec.path).trim();
    if (!path) {
      continue;
    }
    const kindRaw = asString(rec.kind).toLowerCase();
    const kind: ChangeKind = KINDS.has(kindRaw as ChangeKind)
      ? (kindRaw as ChangeKind)
      : "modified";
    notes.push({ path, kind, note: asString(rec.note).trim() });
  }
  return notes;
}

function fallbackTitle(files: DiffFile[]): string {
  if (files.length === 0) {
    return "Empty diff";
  }
  if (files.length === 1) {
    return files[0]?.path ?? "Diff overview";
  }
  return `${files.length} files changed`;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function emptyToUndef(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function detectBaseUrl(): string | undefined {
  if (process.env.OPENROUTER_API_KEY) {
    return "https://openrouter.ai/api/v1";
  }
  if (process.env.GROQ_API_KEY) {
    return "https://api.groq.com/openai/v1";
  }
  if (
    !process.env.OPENAI_API_KEY &&
    (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY)
  ) {
    return "https://generativelanguage.googleapis.com/v1beta/openai/";
  }
  return undefined;
}

function defaultModel(baseURL: string | undefined): string {
  const url = (baseURL ?? "").toLowerCase();
  if (url.includes("openrouter.ai")) {
    return "openai/gpt-4o-mini";
  }
  if (url.includes("groq.com")) {
    return "llama-3.3-70b-versatile";
  }
  if (isGoogleCompatible(baseURL)) {
    return "gemini-3.6-flash";
  }
  if (isLocalCompatible(baseURL)) {
    return "llama3.2";
  }
  return "gpt-4o-mini";
}

function isGoogleCompatible(baseURL: string | undefined): boolean {
  if (!baseURL) {
    return false;
  }
  const url = baseURL.toLowerCase();
  return url.includes("generativelanguage.googleapis.com") || url.includes("aiplatform.googleapis.com");
}

function isLocalCompatible(baseURL: string | undefined): boolean {
  if (!baseURL) {
    return false;
  }
  const url = baseURL.toLowerCase();
  return (
    url.includes("11434") ||
    url.includes("ollama") ||
    url.includes("localhost") ||
    url.includes("127.0.0.1")
  );
}

function openRouterHeaders(baseURL: string | undefined): Record<string, string> | undefined {
  if (!baseURL || !baseURL.toLowerCase().includes("openrouter.ai")) {
    return undefined;
  }
  return {
    "HTTP-Referer": "https://github.com/git-glance/git-glance",
    "X-Title": "git-glance",
  };
}

function isFormatUnsupported(error: unknown): boolean {
  const message = formatLlmError(error).toLowerCase();
  return (
    message.includes("response_format") ||
    message.includes("json_object") ||
    message.includes("400")
  );
}

function formatLlmError(error: unknown): string {
  if (error && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    const status = rec.status;
    const inner = rec.error;
    if (inner && typeof inner === "object") {
      const msg = (inner as Record<string, unknown>).message;
      if (typeof msg === "string" && msg.trim()) {
        return typeof status === "number" ? `${status} ${msg}` : msg;
      }
    }
    if (typeof rec.message === "string" && rec.message.trim()) {
      return rec.message;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "LLM request failed";
}
