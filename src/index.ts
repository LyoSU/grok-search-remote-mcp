import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  getConfig,
  callGrokResponses,
  extractTextFromOutput,
  extractRawOutput,
} from "./grok-client.js";
import type { GrokWebSearchTool, GrokXSearchTool, GrokTool } from "./types.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const SEARCH_SYSTEM_PROMPT = `You are a search assistant. Your job is to search the web or X (Twitter) for the user's query and return a comprehensive, well-structured answer with sources. Always cite URLs where possible. Be concise but thorough. Answer in the same language the user uses.`;

const PORT = parseInt(process.env.PORT || "3000", 10);

// ─── Tool registration helper ───────────────────────────────────────────────
// In stateless mode we create a fresh McpServer per request to avoid
// request‑ID collisions between concurrent clients.

function createServer(): McpServer {
  const server = new McpServer({
    name: "grok-search-mcp-server",
    version: "1.0.0",
  });

  // ── grok_web_search ─────────────────────────────────────────────────────

  server.registerTool(
    "grok_web_search",
    {
      title: "Grok Web Search",
      description: `Search the web using Grok AI with real-time web search capabilities.
Grok will search the internet, browse pages, and synthesize a comprehensive answer with sources.`,
      inputSchema: {
        query: z.string().min(1).max(2000).describe("The search query to send to Grok"),
        allowed_domains: z.array(z.string()).max(5).optional()
          .describe("Only search within these domains (max 5)"),
        excluded_domains: z.array(z.string()).max(5).optional()
          .describe("Exclude these domains from search (max 5)"),
        look_back_days: z.number().int().positive().optional()
          .describe("Only return results from the last N days"),
        system_prompt: z.string().max(4000).optional()
          .describe("Override the default system prompt for Grok"),
        raw_output: z.boolean().default(false)
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
        if (params.allowed_domains?.length) webSearchTool.allowedDomains = params.allowed_domains;
        if (params.excluded_domains?.length) webSearchTool.excludedDomains = params.excluded_domains;
        if (params.look_back_days) webSearchTool.lookBackDays = params.look_back_days;

        const tools: GrokTool[] = [webSearchTool];
        const systemPrompt = params.system_prompt || SEARCH_SYSTEM_PROMPT;
        const response = await callGrokResponses(config, params.query, tools, systemPrompt);

        if (response.error) {
          return {
            content: [{ type: "text", text: `Grok API error: ${response.error.message} (${response.error.type})` }],
            isError: true,
          };
        }

        const text = params.raw_output
          ? extractRawOutput(response.output)
          : extractTextFromOutput(response.output);

        if (!text.trim()) {
          return {
            content: [{ type: "text", text: `Grok returned an empty response. Raw output:\n${extractRawOutput(response.output)}` }],
          };
        }

        return { content: [{ type: "text", text }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── grok_x_search ───────────────────────────────────────────────────────

  server.registerTool(
    "grok_x_search",
    {
      title: "Grok X (Twitter) Search",
      description: `Search X (Twitter) posts, users, and threads using Grok AI.
Grok will search X platform content and synthesize a comprehensive answer.`,
      inputSchema: {
        query: z.string().min(1).max(2000).describe("The search query for X platform"),
        allowed_handles: z.array(z.string()).optional()
          .describe("Only search posts from these X handles (without @)"),
        blocked_handles: z.array(z.string()).optional()
          .describe("Exclude posts from these X handles"),
        from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe("Start date for search range (YYYY-MM-DD)"),
        to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe("End date for search range (YYYY-MM-DD)"),
        system_prompt: z.string().max(4000).optional()
          .describe("Override the default system prompt"),
        raw_output: z.boolean().default(false)
          .describe("Return raw API response blocks"),
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
        if (params.allowed_handles?.length) xSearchTool.allowed_x_handles = params.allowed_handles;
        if (params.blocked_handles?.length) xSearchTool.blocked_x_handles = params.blocked_handles;
        if (params.from_date) xSearchTool.from_date = params.from_date;
        if (params.to_date) xSearchTool.to_date = params.to_date;

        const tools: GrokTool[] = [xSearchTool];
        const systemPrompt = params.system_prompt || SEARCH_SYSTEM_PROMPT;
        const response = await callGrokResponses(config, params.query, tools, systemPrompt);

        if (response.error) {
          return {
            content: [{ type: "text", text: `Grok API error: ${response.error.message} (${response.error.type})` }],
            isError: true,
          };
        }

        const text = params.raw_output
          ? extractRawOutput(response.output)
          : extractTextFromOutput(response.output);

        if (!text.trim()) {
          return {
            content: [{ type: "text", text: `Grok returned an empty response. Raw output:\n${extractRawOutput(response.output)}` }],
          };
        }

        return { content: [{ type: "text", text }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  // ── grok_search (combined) ──────────────────────────────────────────────

  server.registerTool(
    "grok_search",
    {
      title: "Grok Combined Search",
      description: `Search both the web and X (Twitter) simultaneously using Grok AI.
Grok will use both web search and X search tools to find the most comprehensive answer.`,
      inputSchema: {
        query: z.string().min(1).max(2000).describe("The search query"),
        system_prompt: z.string().max(4000).optional()
          .describe("Override the default system prompt"),
        raw_output: z.boolean().default(false)
          .describe("Return raw API response blocks"),
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
        const tools: GrokTool[] = [{ type: "web_search" }, { type: "x_search" }];
        const systemPrompt = params.system_prompt || SEARCH_SYSTEM_PROMPT;
        const response = await callGrokResponses(config, params.query, tools, systemPrompt);

        if (response.error) {
          return {
            content: [{ type: "text", text: `Grok API error: ${response.error.message} (${response.error.type})` }],
            isError: true,
          };
        }

        const text = params.raw_output
          ? extractRawOutput(response.output)
          : extractTextFromOutput(response.output);

        if (!text.trim()) {
          return {
            content: [{ type: "text", text: `Grok returned an empty response. Raw output:\n${extractRawOutput(response.output)}` }],
          };
        }

        return { content: [{ type: "text", text }] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );

  return server;
}

// ─── Express App ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health check for Coolify / load balancers
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", server: "grok-search-mcp-server", version: "1.0.0" });
});

// MCP endpoint — stateless: new server + transport per request
app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET /mcp — not supported in stateless mode
app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST." },
    id: null,
  });
});

// DELETE /mcp — not supported in stateless mode
app.delete("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
});

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`grok-search-mcp-server (remote/HTTP) listening on port ${PORT}`);
  console.log(`MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
  console.log(`Health check: http://0.0.0.0:${PORT}/health`);
});
