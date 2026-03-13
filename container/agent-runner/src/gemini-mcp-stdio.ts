/**
 * Gemini MCP Server for NanoClaw
 * Exposes Google Gemini models as tools for the container agent.
 * Requires GEMINI_API_KEY environment variable.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function log(msg: string): void {
  console.error(`[GEMINI] ${msg}`);
}

interface GeminiModel {
  name: string;
  displayName: string;
  description: string;
  supportedGenerationMethods: string[];
}

interface GeminiListResponse {
  models: GeminiModel[];
}

interface GeminiContent {
  parts: Array<{ text: string }>;
  role: string;
}

interface GeminiCandidate {
  content: GeminiContent;
  finishReason: string;
  tokenCount?: number;
}

interface GeminiGenerateResponse {
  candidates: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

const server = new McpServer({
  name: 'gemini',
  version: '1.0.0',
});

server.tool(
  'gemini_list_models',
  'List available Google Gemini models. Use this to see which models are available before calling gemini_generate.',
  {},
  async () => {
    if (!GEMINI_API_KEY) {
      return {
        content: [{ type: 'text' as const, text: 'GEMINI_API_KEY is not set. Add it to .env and restart the service.' }],
        isError: true,
      };
    }

    log('Listing models...');
    try {
      const res = await fetch(`${GEMINI_BASE}/models?key=${GEMINI_API_KEY}`);
      if (!res.ok) {
        const err = await res.text();
        return {
          content: [{ type: 'text' as const, text: `Gemini API error (${res.status}): ${err}` }],
          isError: true,
        };
      }

      const data = await res.json() as GeminiListResponse;
      const models = (data.models || []).filter(m =>
        m.supportedGenerationMethods?.includes('generateContent')
      );

      if (models.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No generateContent-capable models found.' }] };
      }

      const list = models
        .map(m => `- ${m.name.replace('models/', '')} — ${m.displayName}`)
        .join('\n');

      log(`Found ${models.length} models`);
      return { content: [{ type: 'text' as const, text: `Available Gemini models:\n${list}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to connect to Gemini API: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'gemini_generate',
  'Send a prompt to a Google Gemini model and get a response. Supports real-time web search via Google Search grounding (set search: true). Good for web searches, current events, large context tasks, or a second opinion. Use gemini_list_models first to see available models.',
  {
    model: z.string().describe('The model name (e.g., "gemini-3.0-flash", "gemini-2.5-pro"). Use gemini_list_models to see the current list.'),
    prompt: z.string().describe('The prompt to send to the model'),
    system: z.string().optional().describe('Optional system instruction to set model behavior'),
    search: z.boolean().optional().describe('Enable Google Search grounding for real-time web results. Use for web searches, current events, news, prices, or any question that needs up-to-date information.'),
  },
  async (args) => {
    if (!GEMINI_API_KEY) {
      return {
        content: [{ type: 'text' as const, text: 'GEMINI_API_KEY is not set. Add it to .env and restart the service.' }],
        isError: true,
      };
    }

    const modelId = args.model.replace(/^models\//, '');
    log(`>>> Generating with ${modelId} (${args.prompt.length} chars, search=${args.search ?? false})...`);

    try {
      const body: Record<string, unknown> = {
        contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
      };

      if (args.system) {
        body.systemInstruction = { parts: [{ text: args.system }] };
      }

      if (args.search) {
        body.tools = [{ googleSearch: {} }];
      }

      const url = `${GEMINI_BASE}/models/${modelId}:generateContent?key=${GEMINI_API_KEY}`;
      const start = Date.now();
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        return {
          content: [{ type: 'text' as const, text: `Gemini error (${res.status}): ${errText}` }],
          isError: true,
        };
      }

      const data = await res.json() as GeminiGenerateResponse;
      const candidate = data.candidates?.[0];
      const text = candidate?.content?.parts?.map(p => p.text).join('') || '';
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const tokens = data.usageMetadata?.totalTokenCount;

      const meta = `\n\n[${modelId} | ${elapsed}s${tokens ? ` | ${tokens} tokens` : ''}]`;
      log(`<<< Done: ${modelId} | ${elapsed}s${tokens ? ` | ${tokens} tokens` : ''} | ${text.length} chars`);

      return { content: [{ type: 'text' as const, text: text + meta }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to call Gemini API: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
