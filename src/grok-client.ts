import type {
  GrokRequestBody,
  GrokResponse,
  GrokResponseInput,
  GrokTool,
  GrokContentBlock,
  SearchConfig,
} from "./types.js";

const DEFAULT_MODEL = "grok-4.20-beta-latest-reasoning";
const DEFAULT_BASE_URL = "https://api.x.ai/v1";

export function getConfig(): SearchConfig {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "XAI_API_KEY environment variable is required. Get your key at https://console.x.ai/"
    );
  }
  return {
    apiKey,
    model: process.env.GROK_MODEL || DEFAULT_MODEL,
    baseUrl: process.env.XAI_BASE_URL || DEFAULT_BASE_URL,
  };
}

export async function callGrokResponses(
  config: SearchConfig,
  query: string,
  tools: GrokTool[],
  systemPrompt?: string,
  temperature?: number
): Promise<GrokResponse> {
  const input: GrokResponseInput[] = [{ role: "user", content: query }];

  const body: GrokRequestBody = {
    model: config.model,
    input,
    tools,
    temperature: temperature ?? 0,
  };

  if (systemPrompt) {
    body.instructions = systemPrompt;
  }

  const response = await fetch(`${config.baseUrl}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `Grok API error (${response.status}): ${errText}`
    );
  }

  return (await response.json()) as GrokResponse;
}

export function extractTextFromOutput(output: GrokContentBlock[]): string {
  const parts: string[] = [];

  for (const block of output) {
    if (block.type === "message" && typeof block.content === "string") {
      parts.push(block.content);
    } else if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (
      block.type === "message" &&
      Array.isArray(block.content)
    ) {
      for (const inner of block.content as GrokContentBlock[]) {
        if (inner.type === "output_text" && typeof inner.text === "string") {
          parts.push(inner.text);
        } else if (inner.type === "text" && typeof inner.text === "string") {
          parts.push(inner.text);
        }
      }
    }
  }

  return parts.join("\n\n");
}

export function extractRawOutput(output: GrokContentBlock[]): string {
  return JSON.stringify(output, null, 2);
}
