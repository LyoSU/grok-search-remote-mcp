import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
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

// ─── OAuth ──────────────────────────────────────────────────────────────────

const AUTH_CLIENT_ID = process.env.AUTH_CLIENT_ID || "";
const AUTH_CLIENT_SECRET = process.env.AUTH_CLIENT_SECRET || "";
const activeTokens = new Set<string>();

function isAuthEnabled(): boolean {
  return AUTH_CLIENT_ID.length > 0 && AUTH_CLIENT_SECRET.length > 0;
}

function checkBearer(req: IncomingMessage): boolean {
  if (!isAuthEnabled()) return true;
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return false;
  return activeTokens.has(auth.slice(7));
}

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

  const content: Array<{ type: "text"; text: string }> = [
    { type: "text", text: parsed.text },
  ];

  if (parsed.citations.length > 0) {
    const sourcesBlock = parsed.citations
      .map((c, i) => `[${i + 1}] ${c.title || c.url}\n    ${c.url}`)
      .join("\n");
    content.push({
      type: "text",
      text: `SOURCES (you MUST include these URLs as citations in your response):\n${sourcesBlock}`,
    });
  }

  return { content };
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
  Two content blocks: (1) synthesized answer text, (2) SOURCES block with URLs.

IMPORTANT: You MUST preserve and cite the source URLs from the SOURCES block in your response to the user. Always include clickable links.`,
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
  Two content blocks: (1) synthesized answer text, (2) SOURCES block with URLs.

IMPORTANT: You MUST preserve and cite the source URLs from the SOURCES block in your response to the user. Always include clickable links.`,
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
  Two content blocks: (1) synthesized answer text, (2) SOURCES block with URLs.

IMPORTANT: You MUST preserve and cite the source URLs from the SOURCES block in your response to the user. Always include clickable links.`,
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
  const configuredBaseUrl = process.env.BASE_URL?.replace(/[?/]+$/, "") || "";

  function getBaseUrl(req: IncomingMessage): string {
    if (configuredBaseUrl) return configuredBaseUrl;
    const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${port}`;
    const proto = req.headers["x-forwarded-proto"] || "http";
    return `${proto}://${host}`;
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const baseUrl = getBaseUrl(req);

    // ── OAuth Discovery ───────────────────────────────────────────────────
    if (req.method === "GET" && req.url === "/.well-known/oauth-authorization-server") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "client_credentials"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        code_challenge_methods_supported: ["S256"],
      }));
      return;
    }

    // ── OAuth Register (dynamic client registration) ──────────────────────
    if (req.method === "POST" && req.url === "/register") {
      try {
        const body = await readBody(req);
        const data = JSON.parse(body);
        const newClientId = randomBytes(16).toString("hex");
        const newClientSecret = randomBytes(32).toString("hex");

        registeredClients.set(newClientId, {
          clientSecret: newClientSecret,
          clientName: data.client_name || "mcp-client",
          redirectUris: data.redirect_uris || [],
        });

        console.error(`OAuth: registered client ${newClientId} (${data.client_name || "mcp-client"})`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          client_id: newClientId,
          client_secret: newClientSecret,
          client_name: data.client_name || "mcp-client",
          redirect_uris: data.redirect_uris || [],
        }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_request" }));
      }
      return;
    }

    // ── OAuth Authorize ───────────────────────────────────────────────────
    if (req.url?.startsWith("/authorize")) {
      const url = new URL(req.url, baseUrl);
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      const code = randomBytes(32).toString("hex");

      // Store code temporarily (expires in 5 min)
      authCodes.set(code, { expiresAt: Date.now() + 300_000 });
      setTimeout(() => authCodes.delete(code), 300_000);

      if (redirectUri) {
        const redirect = new URL(redirectUri);
        redirect.searchParams.set("code", code);
        if (state) redirect.searchParams.set("state", state);
        res.writeHead(302, { Location: redirect.toString() });
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code }));
      }
      return;
    }

    // ── OAuth Token ───────────────────────────────────────────────────────
    if (req.method === "POST" && req.url === "/token") {
      try {
        const body = await readBody(req);
        const params = new URLSearchParams(body);
        const grantType = params.get("grant_type");

        console.error(`OAuth /token: grant_type=${grantType} client_id=${params.get("client_id")}`);


        let clientId = params.get("client_id");
        let clientSecret = params.get("client_secret");

        // Support Basic auth header
        const basicAuth = req.headers.authorization;
        if (basicAuth?.startsWith("Basic ")) {
          const decoded = Buffer.from(basicAuth.slice(6), "base64").toString();
          const [id, secret] = decoded.split(":");
          clientId = clientId || id;
          clientSecret = clientSecret || secret;
        }

        // Validate client credentials
        const isStaticClient = clientId === AUTH_CLIENT_ID && clientSecret === AUTH_CLIENT_SECRET;
        const isRegisteredClient = clientId ? registeredClients.has(clientId) : false;
        const registeredInfo = clientId ? registeredClients.get(clientId) : undefined;
        const isRegisteredValid = isRegisteredClient && (!clientSecret || clientSecret === registeredInfo?.clientSecret);

        if (grantType === "client_credentials") {
          // client_credentials requires valid credentials
          if (isAuthEnabled() && !isStaticClient && !isRegisteredValid) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_client" }));
            return;
          }
        }

        if (grantType === "client_credentials" || grantType === "authorization_code") {
          // For authorization_code, verify the code (PKCE flow — client_secret not required)
          if (grantType === "authorization_code") {
            const code = params.get("code");
            if (!code || !authCodes.has(code)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "invalid_grant" }));
              return;
            }
            authCodes.delete(code);
          }

          const token = randomBytes(48).toString("hex");
          activeTokens.add(token);

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            access_token: token,
            token_type: "bearer",
            expires_in: 86400,
          }));
          return;
        }

        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unsupported_grant_type" }));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_request" }));
      }
      return;
    }

    // ── Health ─────────────────────────────────────────────────────────────
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "grok-search-mcp-server" }));
      return;
    }

    // ── MCP (protected) ───────────────────────────────────────────────────
    if (req.method === "POST" && req.url === "/mcp") {
      if (!checkBearer(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized. Provide a valid Bearer token." },
          id: null,
        }));
        return;
      }

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
    if (isAuthEnabled()) {
      console.error(`OAuth enabled (client_id: ${AUTH_CLIENT_ID.slice(0, 4)}...)`);
    } else {
      console.error("OAuth disabled (no AUTH_CLIENT_ID/AUTH_CLIENT_SECRET set)");
    }
  });
}

// Authorization codes (short-lived)
const authCodes = new Map<string, { expiresAt: number }>();

// Dynamically registered OAuth clients
const registeredClients = new Map<string, { clientSecret: string; clientName: string; redirectUris: string[] }>();

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
