import type { DiffFile } from "./diff.js";

const MAX_DIAGRAM_CHARS = 24_000;
const MAX_FALLBACK_NODES = 24;

const RESERVED_IDS = new Set(["end", "graph", "subgraph", "flowchart", "class", "click"]);

export function sanitizeMermaid(raw: string, files: DiffFile[]): string {
  let src = stripFences(raw).replace(/\r\n/g, "\n").trim();

  src = src.replace(/^\s*click\s+.+$/gim, "");
  src = src.replace(/javascript:/gi, "");
  src = src.replace(/%%\{[\s\S]*?\}%%/g, "");

  src = preserveBreaksThenStripTags(src);
  src = quoteUnquotedLabels(src);
  src = rewriteReservedIds(src);

  if (!hasDiagramHeader(src)) {
    src = src ? `flowchart TD\n${src}` : "";
  }

  const body = src.replace(/^(?:flowchart|graph)[^\n]*\n/i, "").trim();
  if (!body || src.length < 16) {
    return fallbackDiagram(files);
  }

  if (src.length > MAX_DIAGRAM_CHARS) {
    return fallbackDiagram(files);
  }

  return src.trim();
}

export function fallbackDiagram(files: DiffFile[]): string {
  const limited = files.slice(0, MAX_FALLBACK_NODES);
  if (limited.length === 0) {
    return 'flowchart TD\n  empty["No file-level changes"]';
  }

  const nodes = limited.map((file, index) => {
    const id = `n${index}`;
    const label = escapeLabel(file.path);
    return `    ${id}["${label}"]:::${file.kind}`;
  });

  return [
    "flowchart TD",
    '  subgraph delta["Changed files"]',
    ...nodes,
    "  end",
    "  classDef added fill:#14532d,stroke:#16a34a,color:#dcfce7",
    "  classDef modified fill:#78350f,stroke:#d97706,color:#fef3c7",
    "  classDef deleted fill:#7f1d1d,stroke:#dc2626,color:#fee2e2",
    "  classDef renamed fill:#1e3a5f,stroke:#0284c7,color:#e0f2fe",
  ].join("\n");
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:mermaid|mmd|json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return trimmed.replace(/^```(?:mermaid|mmd)?\s*/i, "").replace(/```$/i, "").trim();
}

function hasDiagramHeader(src: string): boolean {
  return /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|C4Context)\b/m.test(
    src,
  );
}

function preserveBreaksThenStripTags(src: string): string {
  const withBreaks = src.replace(/<\s*br\s*\/?\s*>/gi, "<br/>");
  return withBreaks.replace(/<(?!br\s*\/?)[^>]+>/gi, "");
}

function quoteUnquotedLabels(src: string): string {
  // Mermaid labels with (), :, /, or spaces break the parser unless quoted.
  return src.replace(/([A-Za-z][\w-]*|[\w-]+)\s*\[\s*(?!")([^\]\n]+?)\s*\]/g, (_match, id: string, label: string) => {
    return `${id}["${escapeLabel(label)}"]`;
  });
}

function rewriteReservedIds(src: string): string {
  return src.replace(/(^|[\s;])([A-Za-z][\w-]*)(\s*(?:\[|\(|\{))/gm, (match, pre: string, id: string, rest: string) => {
    if (!RESERVED_IDS.has(id.toLowerCase())) {
      return match;
    }
    return `${pre}${id}_node${rest}`;
  });
}

function escapeLabel(label: string): string {
  return label.replace(/"/g, "#quot;").replace(/[[\]]/g, "").replace(/\n/g, "<br/>");
}

