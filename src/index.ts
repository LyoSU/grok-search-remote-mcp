import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import {
  getConfig,
  callGrokResponses,
  parseGrokOutput,
  formatResultWithSources,
  extractRawOutput,
} from "./grok-client.js";
import type { GrokWebSearchTool, GrokXSearchTool, GrokTool } from "./types.js";

// ─── Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "grok-search-mcp-server",
  version: "1.0.0",
});

// ─── Constants ──────────────────────────────────────────────────────────────

const SEARCH_SYSTEM_PROMPT = `You are a search assistant. Your job is to search the web or X (Twitter) for the user's query and return a comprehensive, well-structured answer with sources. Always cite URLs where possible. Be concise but thorough. Answer in the same language the user uses.`;

// ─── Shared response handler ────────────────────────────────────────────────

function handleGrokResponse(
  response: { error?: { message: string; type: string }; output: unknown[] },
  rawOutput: boolean
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  if (response.error) {
    return {
      content: [
        {
          type: "text",
          text: `Grok API error: ${response.error.message} (${response.error.type})`,
        },
      ],
      isError: true,
    };
  }

  if (rawOutput) {
    return {
      content: [{ type: "text", text: extractRawOutput(response.output as any) }],
    };
  }

  const parsed = parseGrokOutput(response as any);

  if (!parsed.text.trim()) {
    return {
      content: [
        {
          type: "text",
          text: `Grok returned an empty response. Raw output:\n${extractRawOutput(response.output as any)}`,
        },
      ],
    };
  }

  const formatted = formatResultWithSources(parsed);
  return {
    content: [{ type: "text", text: formatted }],
  };
}

// ─── Tool: grok_web_search ──────────────────────────────────────────────────

server.registerTool(
  "grok_web_search",
  {
    title: "Grok Web Search",
    description: `Search the web using Grok AI with real-time web search capabilities.

Grok will search the internet, browse pages, and synthesize a comprehensive answer with sources and citations.

Args:
  - query (string): The search query
  - allowed_domains (string[], optional): Only search within these domains (max 5)
  - excluded_domains (string[], optional): Exclude these domains from search (max 5)
  - look_back_days (number, optional): Only return results from the last N days
  - system_prompt (string, optional): Override the default system prompt for Grok
  - raw_output (boolean, optional): Return raw API response instead of extracted text

Returns:
  Text with Grok's synthesized answer including inline citations and a Sources section listing all referenced URLs.`,
    inputSchema: {
      query: z
        .string()
        .min(1, "Query must not be empty")
        .max(2000, "Query must not exceed 2000 characters")
        .describe("The search query to send to Grok"),
      allowed_domains: z
        .array(z.string())
        .max(5)
        .optional()
        .describe("Only search within these domains (max 5). Cannot be used with excluded_domains."),
      excluded_domains: z
        .array(z.string())
        .max(5)
        .optional()
        .describe("Exclude these domains from search (max 5). Cannot be used with allowed_domains."),
      look_back_days: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Only return results from the last N days"),
      system_prompt: z
        .string()
        .max(4000)
        .optional()
        .describe("Override the default system prompt for Grok"),
      raw_output: z
        .boolean()
        .default(false)
        .describe("Return raw API response blocks instead of extracted text"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const config = getConfig();

      const webSearchTool: GrokWebSearchTool = { type: "web_search" };
      if (params.allowed_domains?.length) {
        webSearchTool.allowedDomains = params.allowed_domains;
      }
      if (params.excluded_domains?.length) {
        webSearchTool.excludedDomains = params.excluded_domains;
      }
      if (params.look_back_days) {
        webSearchTool.lookBackDays = params.look_back_days;
      }

      const tools: GrokTool[] = [webSearchTool];
      const systemPrompt = params.system_prompt || SEARCH_SYSTEM_PROMPT;
      const response = await callGrokResponses(config, params.query, tools, systemPrompt);
      return handleGrokResponse(response, params.raw_output);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: grok_x_search ───────────────────────────────────────────────────

server.registerTool(
  "grok_x_search",
  {
    title: "Grok X (Twitter) Search",
    description: `Search X (Twitter) posts, users, and threads using Grok AI.

Grok will search X platform content and synthesize a comprehensive answer with citations.

Args:
  - query (string): The search query
  - allowed_handles (string[], optional): Only search posts from these X handles
  - blocked_handles (string[], optional): Exclude posts from these X handles
  - from_date (string, optional): Start date in YYYY-MM-DD format
  - to_date (string, optional): End date in YYYY-MM-DD format
  - system_prompt (string, optional): Override the default system prompt
  - raw_output (boolean, optional): Return raw API response

Returns:
  Text with Grok's synthesized answer from X content, including inline citations and a Sources section.`,
    inputSchema: {
      query: z
        .string()
        .min(1, "Query must not be empty")
        .max(2000, "Query must not exceed 2000 characters")
        .describe("The search query for X platform"),
      allowed_handles: z
        .array(z.string())
        .optional()
        .describe("Only search posts from these X handles (without @)"),
      blocked_handles: z
        .array(z.string())
        .optional()
        .describe("Exclude posts from these X handles"),
      from_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
        .optional()
        .describe("Start date for search range (YYYY-MM-DD)"),
      to_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
        .optional()
        .describe("End date for search range (YYYY-MM-DD)"),
      system_prompt: z.string().max(4000).optional().describe("Override the default system prompt"),
      raw_output: z.boolean().default(false).describe("Return raw API response blocks"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const config = getConfig();

      const xSearchTool: GrokXSearchTool = { type: "x_search" };
      if (params.allowed_handles?.length) {
        xSearchTool.allowed_x_handles = params.allowed_handles;
      }
      if (params.blocked_handles?.length) {
        xSearchTool.blocked_x_handles = params.blocked_handles;
      }
      if (params.from_date) {
        xSearchTool.from_date = params.from_date;
      }
      if (params.to_date) {
        xSearchTool.to_date = params.to_date;
      }

      const tools: GrokTool[] = [xSearchTool];
      const systemPrompt = params.system_prompt || SEARCH_SYSTEM_PROMPT;
      const response = await callGrokResponses(config, params.query, tools, systemPrompt);
      return handleGrokResponse(response, params.raw_output);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: grok_search ─────────────────────────────────────────────────────

server.registerTool(
  "grok_search",
  {
    title: "Grok Combined Search",
    description: `Search both the web and X (Twitter) simultaneously using Grok AI.

Grok will use both web search and X search tools to find the most comprehensive answer with citations.

Args:
  - query (string): The search query
  - system_prompt (string, optional): Override the default system prompt
  - raw_output (boolean, optional): Return raw API response

Returns:
  Text with Grok's synthesized answer from both web and X sources, including inline citations and a Sources section.`,
    inputSchema: {
      query: z
        .string()
        .min(1)
        .max(2000)
        .describe("The search query"),
      system_prompt: z.string().max(4000).optional().describe("Override the default system prompt"),
      raw_output: z.boolean().default(false).describe("Return raw API response blocks"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params) => {
    try {
      const config = getConfig();

      const tools: GrokTool[] = [
        { type: "web_search" },
        { type: "x_search" },
      ];
      const systemPrompt = params.system_prompt || SEARCH_SYSTEM_PROMPT;
      const response = await callGrokResponses(config, params.query, tools, systemPrompt);
      return handleGrokResponse(response, params.raw_output);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  }
);

// ─── Start ──────────────────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("grok-search-mcp-server running on stdio");
}

async function runHTTP(): Promise<void> {
  const port = parseInt(process.env.PORT || "3100", 10);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "grok-search-mcp-server" }));
      return;
    }

    if (req.method === "POST" && req.url === "/mcp") {
      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });

        res.on("close", () => transport.close());
        await server.connect(transport);
        await transport.handleRequest(req, res, parsed);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: msg }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Use POST /mcp" }));
  });

  httpServer.listen(port, () => {
    console.error(`grok-search-mcp-server running on http://0.0.0.0:${port}/mcp`);
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

const transportMode = process.env.TRANSPORT || "stdio";
if (transportMode === "http") {
  runHTTP().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
} else {
  runStdio().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
