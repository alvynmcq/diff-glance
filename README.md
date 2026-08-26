# git-glance

Zero-config CLI that turns a git diff into an ELI5 summary and an interactive Mermaid architecture diagram, then serves a local dark-mode viewer.

## Requirements

- Node.js 18+
- `git` on `PATH`
- An OpenAI-compatible API key (OpenAI, Google Gemini, OpenRouter, Groq, or Ollama)

## Install

```bash
npx git-glance
```

```bash
npm install -g git-glance
```

From this repo:

```bash
npm install
npm run build
node bin/git-glance.js
```

## Usage

```bash
git-glance
git-glance --staged
git-glance main
git-glance main HEAD
git-glance --commit HEAD
git-glance --json
git-glance -o glance.html
```

```
Options:
  -s, --staged            Analyze staged changes only
  -c, --commit <sha>      Analyze a specific commit
  -m, --model <id>        Model id
  --base-url <url>        OpenAI-compatible API base URL
  --api-key <key>         API key
  -p, --port <n>          Viewer port (0 = ephemeral)
  --host <host>           Viewer bind host
  --no-open               Do not open a browser
  --json                  Print analysis JSON to stdout
  --max-chars <n>         Max diff characters sent to the model
  -o, --output <file>     Write an HTML report instead of serving
```

Default range is `HEAD` vs the worktree (staged + unstaged), plus untracked files.

## Providers

| Provider   | Env / flags |
| ---------- | ----------- |
| OpenAI     | `OPENAI_API_KEY` |
| Google AI  | `GEMINI_API_KEY` or `GOOGLE_API_KEY` (default model: `gemini-3.6-flash`) |
| OpenRouter | `OPENROUTER_API_KEY` |
| Groq       | `GROQ_API_KEY` |
| Ollama     | `--base-url http://127.0.0.1:11434/v1 --model llama3.2` |
| Custom     | `--base-url` + `--api-key` |

Get a Gemini key from [Google AI Studio](https://aistudio.google.com/app/apikey). Then:

```bash
export GEMINI_API_KEY=your-key
git-glance
git-glance --model gemini-3.6-flash
```

Optional env vars: `GIT_GLANCE_API_KEY`, `GIT_GLANCE_BASE_URL`, `GIT_GLANCE_MODEL`.

Anthropic models work through any OpenAI-compatible gateway (for example OpenRouter: `--model anthropic/claude-sonnet-4`). Vertex AI works with `--base-url` pointed at your OpenAI-compatible Vertex endpoint.

Set `GIT_GLANCE_DEBUG=1` to print stack traces.

## Build

```bash
npm run build
npm run typecheck
```
