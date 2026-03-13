# Add Gemini Tool

This skill adds a stdio-based MCP server that exposes Google Gemini models as tools for the container agent. Claude remains the orchestrator but can call Gemini for tasks that benefit from a different model family (large context, multimodal, second opinion).

Tools added:
- `gemini_list_models` — lists available Gemini models from the API
- `gemini_generate` — sends a prompt to a specified Gemini model and returns the response

## Phase 1: Pre-flight

### Check if already applied

Check if `container/agent-runner/src/gemini-mcp-stdio.ts` exists. If it does, skip to Phase 3 (Configure).

### Get a Gemini API key

The user needs a Gemini API key from Google AI Studio:

> You need a Gemini API key. Get one free at https://aistudio.google.com/app/apikey — no credit card required for the free tier (Gemini 2.0 Flash is free up to generous limits).

## Phase 2: Apply Code Changes

### Create the MCP server

Create `container/agent-runner/src/gemini-mcp-stdio.ts` with:
- `gemini_list_models` tool: calls `GET https://generativelanguage.googleapis.com/v1beta/models?key={GEMINI_API_KEY}`, filters for `generateContent`-capable models
- `gemini_generate` tool: calls `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_API_KEY}`, supports optional `system` instruction
- Logs prefixed with `[GEMINI]` to stderr
- Reads `GEMINI_API_KEY` from environment; returns helpful error if not set

### Wire into index.ts

In `container/agent-runner/src/index.ts`:

1. Add `'mcp__gemini__*'` to `allowedTools`
2. Add to `mcpServers`:
```typescript
gemini: {
  command: 'node',
  args: [path.join(path.dirname(mcpServerPath), 'gemini-mcp-stdio.js')],
  env: {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  },
},
```

### Surface Gemini logs in container-runner.ts

In `src/container-runner.ts`, find the `[OLLAMA]` log surfacing line and extend it:
```typescript
if (line.includes('[OLLAMA]') || line.includes('[GEMINI]')) {
```

### Update .env.example

Add `GEMINI_API_KEY=` alongside `OLLAMA_HOST=`.

### Copy to per-group agent-runner

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/gemini-mcp-stdio.ts "$dir/"
  cp container/agent-runner/src/index.ts "$dir/"
done
```

### Build

```bash
npm run build
./container/build.sh
```

## Phase 3: Configure

Add the API key to `.env`:

```bash
GEMINI_API_KEY=your-key-here
```

Then reload the service so the key is picked up:

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist && launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test via chat

Send: `use gemini to tell me the capital of France`

The agent should call `gemini_list_models`, pick a model (e.g. `gemini-3.0-flash`), then call `gemini_generate`.

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i gemini
```

Look for:
- `[GEMINI] >>> Generating with gemini-2.0-flash` — generation started
- `[GEMINI] <<< Done` — generation completed

## Troubleshooting

### "GEMINI_API_KEY is not set"

Add `GEMINI_API_KEY=your-key` to `.env` and reload the service.

### "Gemini error (400)"

The model name is wrong. Call `gemini_list_models` first and use the exact model name from the list (without the `models/` prefix).

### "Gemini error (429)"

Rate limit hit on the free tier. Use `gemini-3.0-flash` (highest free quota) or add billing to the Google Cloud project.

### Agent doesn't use Gemini tools

Be explicit: "use the gemini_generate tool with gemini-2.0-flash to answer: ..."
