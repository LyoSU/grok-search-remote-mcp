import type {
  GrokRequestBody,
  GrokResponse,
  GrokResponseInput,
  GrokTool,
  GrokContentBlock,
  GrokAnnotation,
  SearchConfig,
  ParsedGrokResult,
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

/**
 * Extract text + citations from Grok response.
 *
 * Grok Responses API returns:
 *   output[N] = { type: "message", content: [{ type: "output_text", text: "...", annotations: [...] }] }
 * or sometimes output_text blocks directly in the output array.
 *
 * With include: ["inline_citations"], the text itself contains [[1]](url) references.
 * Annotations contain { type: "url_citation", url, title, start_index, end_index }.
 * Top-level response.citations contains all encountered URLs.
 */
export function parseGrokOutput(response: GrokResponse): ParsedGrokResult {
  const textParts: string[] = [];
  const citationMap = new Map<string, string>(); // url -> title

  function extractFromBlock(block: GrokContentBlock): void {
    // Direct output_text block
    if (block.type === "output_text" && typeof block.text === "string") {
      textParts.push(block.text);
      collectAnnotations(block.annotations);
      return;
    }

    // Message wrapper with content array
    if (block.type === "message" && Array.isArray(block.content)) {
      for (const inner of block.content as GrokContentBlock[]) {
        if (inner.type === "output_text" && typeof inner.text === "string") {
          textParts.push(inner.text);
          collectAnnotations(inner.annotations);
        } else if (inner.type === "text" && typeof inner.text === "string") {
          textParts.push(inner.text);
        }
      }
      return;
    }

    // Fallback: text blocks
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }

  function collectAnnotations(annotations?: GrokAnnotation[]): void {
    if (!annotations) return;
    for (const ann of annotations) {
      if (ann.type === "url_citation" && typeof ann.url === "string") {
        const title = typeof ann.title === "string" ? ann.title : "";
        // Keep first title we see for each URL
        if (!citationMap.has(ann.url)) {
          citationMap.set(ann.url, title);
        }
      }
    }
  }

  for (const block of response.output) {
    extractFromBlock(block);
  }

  // Also collect top-level citations (URLs agent visited)
  if (Array.isArray(response.citations)) {
    for (const url of response.citations) {
      if (typeof url === "string" && !citationMap.has(url)) {
        citationMap.set(url, "");
      }
    }
  }

  const citations = Array.from(citationMap.entries()).map(([url, title]) => ({
    url,
    title,
  }));

  return {
    text: textParts.join("\n\n"),
    citations,
  };
}

/**
 * Format the result as text with a sources section at the bottom.
 */
export function formatResultWithSources(result: ParsedGrokResult): string {
  let output = result.text;

  if (result.citations.length > 0) {
    output += "\n\n---\n**Sources:**\n";
    for (let i = 0; i < result.citations.length; i++) {
      const c = result.citations[i];
      const label = c.title || c.url;
      output += `${i + 1}. ${label}\n   ${c.url}\n`;
    }
  }

  return output;
}

/**
 * Extract the full raw output for debugging/transparency.
 */
export function extractRawOutput(output: GrokContentBlock[]): string {
  return JSON.stringify(output, null, 2);
}
