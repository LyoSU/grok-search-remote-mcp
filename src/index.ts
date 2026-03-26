import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  getConfig,
  callGrokResponses,
  parseGrokOutput,
  extractRawOutput,
} from "./grok-client.js";
import type { GrokWebSearchTool, GrokXSearchTool, GrokTool } from "./types.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const SEARCH_SYSTEM_PROMPT = `You are a search assistant. Your job is to search the web or X (Twitter) for the user's query and return a comprehensive, well-structured answer with sources. Always cite URLs where possible. Be concise but thorough. Answer in the same language the user uses.`;

const MAX_BODY_SIZE = 1024 * 1024; // 1MB
const TOKEN_TTL_MS = 365 * 86_400_000; // 1 year
const MAX_REGISTERED_CLIENTS = 100;
const CLEANUP_INTERVAL_MS = 300_000; // 5 min

// ─── Logging ────────────────────────────────────────────────────────────────

function log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), level, msg, ...data };
  console.error(JSON.stringify(entry));
}

function getClientIp(req: IncomingMessage): string {
  return (req.headers["cf-connecting-ip"] as string)
    || (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
    || req.socket.remoteAddress
    || "unknown";
}

function logRequest(req: IncomingMessage, statusCode: number, durationMs: number): void {
  log("info", "http_request", {
    method: req.method,
    url: req.url,
    status: statusCode,
    ip: getClientIp(req),
    ua: req.headers["user-agent"],
    duration_ms: durationMs,
  });
}

// ─── Server Factory ─────────────────────────────────────────────────────────
// Create a fresh McpServer per request to avoid "Already connected" errors
// when concurrent requests arrive.

function createMcpServer(): McpServer {
  const srv = new McpServer({
    name: "grok-search-mcp-server",
    version: "1.0.0",
  });
  registerTools(srv);
  return srv;
}

// ─── OAuth State ────────────────────────────────────────────────────────────

const AUTH_CLIENT_ID = process.env.AUTH_CLIENT_ID || "";
const AUTH_CLIENT_SECRET = process.env.AUTH_CLIENT_SECRET || "";

// Tokens with expiry
const activeTokens = new Map<string, number>(); // token -> expiresAt

// Authorization codes (short-lived)
const authCodes = new Map<string, { expiresAt: number }>();

// Dynamically registered OAuth clients
const registeredClients = new Map<string, {
  clientSecret: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}>();

// ─── Token & Client Persistence ─────────────────────────────────────────────
// Persist tokens and registered clients to a JSON file so they survive restarts.

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_STORE_PATH = process.env.AUTH_STORE_PATH || join(__dirname, "..", ".auth-store.json");

interface AuthStore {
  tokens: Array<[string, number]>;
  clients: Array<[string, { clientSecret: string; clientName: string; redirectUris: string[]; createdAt: number }]>;
}

function loadAuthStore(): void {
  try {
    const raw = readFileSync(AUTH_STORE_PATH, "utf-8");
    const data: AuthStore = JSON.parse(raw);
    const now = Date.now();
    let loaded = 0;
    for (const [token, expiresAt] of data.tokens || []) {
      if (expiresAt > now) {
        activeTokens.set(token, expiresAt);
        loaded++;
      }
    }
    for (const [id, info] of data.clients || []) {
      registeredClients.set(id, info);
    }
    if (loaded > 0 || (data.clients?.length ?? 0) > 0) {
      log("info", "auth_store_loaded", {
        tokens: loaded,
        clients: data.clients?.length ?? 0,
        path: AUTH_STORE_PATH,
      });
    }
  } catch {
    // File doesn't exist yet or is corrupted — start fresh
  }
}

function saveAuthStore(): void {
  try {
    const data: AuthStore = {
      tokens: [...activeTokens.entries()],
      clients: [...registeredClients.entries()],
    };
    mkdirSync(dirname(AUTH_STORE_PATH), { recursive: true });
    writeFileSync(AUTH_STORE_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    log("warn", "auth_store_save_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

// Load persisted auth state on startup
loadAuthStore();

function isAuthEnabled(): boolean {
  return AUTH_CLIENT_ID.length > 0 && AUTH_CLIENT_SECRET.length > 0;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function checkBearer(req: IncomingMessage): boolean {
  if (!isAuthEnabled()) return true;
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return false;
  const token = auth.slice(7);
  const expiresAt = activeTokens.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    activeTokens.delete(token);
    return false;
  }
  return true;
}

// Periodic cleanup of expired tokens, codes, and clients
setInterval(() => {
  const now = Date.now();
  let expiredTokens = 0;
  let expiredCodes = 0;

  for (const [token, expiresAt] of activeTokens) {
    if (now > expiresAt) { activeTokens.delete(token); expiredTokens++; }
  }
  for (const [code, { expiresAt }] of authCodes) {
    if (now > expiresAt) { authCodes.delete(code); expiredCodes++; }
  }

  if (expiredTokens > 0 || expiredCodes > 0) {
    log("info", "cleanup", {
      expired_tokens: expiredTokens,
      expired_codes: expiredCodes,
      active_tokens: activeTokens.size,
      registered_clients: registeredClients.size,
    });
    saveAuthStore();
  }
}, CLEANUP_INTERVAL_MS);

// ─── Stats ──────────────────────────────────────────────────────────────────

const stats = {
  totalRequests: 0,
  toolCalls: { grok_web_search: 0, grok_x_search: 0, grok_search: 0 } as Record<string, number>,
  errors: 0,
  startedAt: new Date().toISOString(),
};

// ─── Progress Notifications ─────────────────────────────────────────────────
// Sends periodic progress notifications to keep the MCP connection alive
// while waiting for slow xAI API responses (prevents client-side timeouts).

const PROGRESS_INTERVAL_MS = 5_000; // Send heartbeat every 5 seconds

interface ProgressSender {
  stop(): void;
}

function startProgressNotifications(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  toolName: string,
  deepResearch = false,
): ProgressSender {
  const progressToken = extra._meta?.progressToken;
  // If client didn't request progress, nothing to do
  if (!progressToken) {
    return { stop() {} };
  }

  let tick = 0;
  const messages = deepResearch
    ? [
        `Deep research with 4 agents: ${toolName}...`,
        "Multi-agent team is researching in parallel...",
        "Agents are synthesizing findings...",
        "Still working, multi-agent takes longer...",
        "Almost there...",
      ]
    : [
        `Searching with ${toolName}...`,
        "Waiting for Grok API response...",
        "Still processing, please wait...",
        "Grok is thinking...",
        "Almost there...",
      ];

  const interval = setInterval(async () => {
    tick++;
    const message = messages[Math.min(tick - 1, messages.length - 1)];
    try {
      await extra.sendNotification({
        method: "notifications/progress" as const,
        params: {
          progressToken,
          progress: tick,
          total: tick + 1, // indeterminate: total always ahead
          message,
        },
      });
    } catch {
      // Client may not support progress — ignore silently
    }
  }, PROGRESS_INTERVAL_MS);

  return {
    stop() {
      clearInterval(interval);
    },
  };
}

// ─── Shared response handler ────────────────────────────────────────────────

function handleGrokResponse(
  response: { error?: { message: string; type: string }; output: unknown[] },
  rawOutput: boolean,
  toolName: string,
  query: string,
  startTime: number,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  const durationMs = Date.now() - startTime;

  if (response.error) {
    stats.errors++;
    log("error", "grok_api_error", {
      tool: toolName, query,
      error_type: response.error.type,
      error_message: response.error.message,
      duration_ms: durationMs,
    });
    return {
      content: [{ type: "text", text: `Grok API error: ${response.error.message} (${response.error.type})` }],
      isError: true,
    };
  }

  if (rawOutput) {
    log("info", "tool_call_ok", { tool: toolName, query, raw: true, duration_ms: durationMs });
    return {
      content: [{ type: "text", text: extractRawOutput(response.output as GrokContentBlock[]) }],
    };
  }

  const parsed = parseGrokOutput(response as GrokResponse);

  if (!parsed.text.trim()) {
    log("warn", "grok_empty_response", { tool: toolName, query, duration_ms: durationMs });
    return {
      content: [{
        type: "text",
        text: `Grok returned an empty response. Raw output:\n${extractRawOutput(response.output as GrokContentBlock[])}`,
      }],
    };
  }

  log("info", "tool_call_ok", {
    tool: toolName, query,
    citations: parsed.citations.length,
    text_length: parsed.text.length,
    duration_ms: durationMs,
  });

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

// ─── Import types for casts ─────────────────────────────────────────────────

import type { GrokContentBlock, GrokResponse } from "./types.js";

// ─── Tool Registration ─────────────────────────────────────────────────────

function registerTools(server: McpServer): void {

// ─── Tool: grok_web_search ──────────────────────────────────────────────────

server.registerTool(
  "grok_web_search",
  {
    title: "Grok Web Search",
    description: `Search the web using Grok AI with real-time web search capabilities.

Grok will search the internet, browse pages, and synthesize a comprehensive answer with sources and citations.

Returns:
  Two content blocks: (1) synthesized answer text, (2) SOURCES block with URLs.

IMPORTANT: You MUST preserve and cite the source URLs from the SOURCES block in your response to the user. Always include clickable links.`,
    inputSchema: {
      query: z.string().min(1).max(2000).describe("The search query to send to Grok"),
      allowed_domains: z.array(z.string()).max(5).optional()
        .describe("Only search within these domains (max 5)"),
      excluded_domains: z.array(z.string()).max(5).optional()
        .describe("Exclude these domains from search (max 5)"),
      look_back_days: z.number().int().positive().optional()
        .describe("Only return results from the last N days"),
      deep_research: z.boolean().default(false)
        .describe("Use multi-agent model (4 parallel agents) for deeper, more comprehensive research. Slower but better for complex queries."),
      system_prompt: z.string().max(4000).optional()
        .describe("Override the default system prompt for Grok"),
      raw_output: z.boolean().default(false)
        .describe("Return raw API response blocks instead of extracted text"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (params, extra) => {
    const startTime = Date.now();
    stats.totalRequests++;
    stats.toolCalls.grok_web_search++;
    log("info", "tool_call", { tool: "grok_web_search", query: params.query, deep_research: params.deep_research });

    const progress = startProgressNotifications(extra, "grok_web_search", params.deep_research);
    try {
      const config = getConfig();
      const webSearchTool: GrokWebSearchTool = { type: "web_search" };
      if (params.allowed_domains?.length) webSearchTool.allowedDomains = params.allowed_domains;
      if (params.excluded_domains?.length) webSearchTool.excludedDomains = params.excluded_domains;
      if (params.look_back_days) webSearchTool.lookBackDays = params.look_back_days;

      const response = await callGrokResponses(config, params.query, [webSearchTool], {
        systemPrompt: params.system_prompt || SEARCH_SYSTEM_PROMPT,
        signal: extra.signal,
        multiAgent: params.deep_research ? "quick" : undefined,
      });
      return handleGrokResponse(response, params.raw_output, "grok_web_search", params.query, startTime);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      stats.errors++;
      log("error", "tool_call_error", { tool: "grok_web_search", query: params.query, error: msg, duration_ms: Date.now() - startTime });
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
    } finally {
      progress.stop();
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

Returns:
  Two content blocks: (1) synthesized answer text, (2) SOURCES block with URLs.

IMPORTANT: You MUST preserve and cite the source URLs from the SOURCES block in your response to the user. Always include clickable links.`,
    inputSchema: {
      query: z.string().min(1).max(2000).describe("The search query for X platform"),
      allowed_handles: z.array(z.string()).optional().describe("Only search posts from these X handles (without @)"),
      blocked_handles: z.array(z.string()).optional().describe("Exclude posts from these X handles"),
      from_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Start date (YYYY-MM-DD)"),
      to_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End date (YYYY-MM-DD)"),
      deep_research: z.boolean().default(false)
        .describe("Use multi-agent model (4 parallel agents) for deeper, more comprehensive research. Slower but better for complex queries."),
      system_prompt: z.string().max(4000).optional().describe("Override the default system prompt"),
      raw_output: z.boolean().default(false).describe("Return raw API response blocks"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (params, extra) => {
    const startTime = Date.now();
    stats.totalRequests++;
    stats.toolCalls.grok_x_search++;
    log("info", "tool_call", { tool: "grok_x_search", query: params.query, deep_research: params.deep_research });

    const progress = startProgressNotifications(extra, "grok_x_search", params.deep_research);
    try {
      const config = getConfig();
      const xSearchTool: GrokXSearchTool = { type: "x_search" };
      if (params.allowed_handles?.length) xSearchTool.allowed_x_handles = params.allowed_handles;
      if (params.blocked_handles?.length) xSearchTool.blocked_x_handles = params.blocked_handles;
      if (params.from_date) xSearchTool.from_date = params.from_date;
      if (params.to_date) xSearchTool.to_date = params.to_date;

      const response = await callGrokResponses(config, params.query, [xSearchTool], {
        systemPrompt: params.system_prompt || SEARCH_SYSTEM_PROMPT,
        signal: extra.signal,
        multiAgent: params.deep_research ? "quick" : undefined,
      });
      return handleGrokResponse(response, params.raw_output, "grok_x_search", params.query, startTime);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      stats.errors++;
      log("error", "tool_call_error", { tool: "grok_x_search", query: params.query, error: msg, duration_ms: Date.now() - startTime });
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
    } finally {
      progress.stop();
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

Returns:
  Two content blocks: (1) synthesized answer text, (2) SOURCES block with URLs.

IMPORTANT: You MUST preserve and cite the source URLs from the SOURCES block in your response to the user. Always include clickable links.`,
    inputSchema: {
      query: z.string().min(1).max(2000).describe("The search query"),
      deep_research: z.boolean().default(false)
        .describe("Use multi-agent model (4 parallel agents) for deeper, more comprehensive research. Slower but better for complex queries."),
      system_prompt: z.string().max(4000).optional().describe("Override the default system prompt"),
      raw_output: z.boolean().default(false).describe("Return raw API response blocks"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (params, extra) => {
    const startTime = Date.now();
    stats.totalRequests++;
    stats.toolCalls.grok_search++;
    log("info", "tool_call", { tool: "grok_search", query: params.query, deep_research: params.deep_research });

    const progress = startProgressNotifications(extra, "grok_search", params.deep_research);
    try {
      const config = getConfig();
      const tools: GrokTool[] = [{ type: "web_search" }, { type: "x_search" }];
      const response = await callGrokResponses(config, params.query, tools, {
        systemPrompt: params.system_prompt || SEARCH_SYSTEM_PROMPT,
        signal: extra.signal,
        multiAgent: params.deep_research ? "quick" : undefined,
      });
      return handleGrokResponse(response, params.raw_output, "grok_search", params.query, startTime);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      stats.errors++;
      log("error", "tool_call_error", { tool: "grok_search", query: params.query, error: msg, duration_ms: Date.now() - startTime });
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
    } finally {
      progress.stop();
    }
  }
);

} // end registerTools

// ─── HTTP Server ────────────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  const srv = createMcpServer();
  const transport = new StdioServerTransport();
  await srv.connect(transport);
  log("info", "server_started", { transport: "stdio" });
}

async function runHTTP(): Promise<void> {
  const port = parseInt(process.env.PORT || "3100", 10);
  const configuredBaseUrl = process.env.BASE_URL?.replace(/[?/]+$/, "") || "";

  function getBaseUrl(req: IncomingMessage): string {
    // Always prefer configured BASE_URL to prevent header poisoning
    if (configuredBaseUrl) return configuredBaseUrl;
    const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${port}`;
    const proto = req.headers["x-forwarded-proto"] || "http";
    return `${proto}://${host}`;
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqStart = Date.now();

    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    // Patch res.end to log (skip health checks)
    const origEnd = res.end.bind(res);
    res.end = function (...args: unknown[]) {
      const result = (origEnd as Function)(...args);
      if (req.url !== "/health") logRequest(req, res.statusCode, Date.now() - reqStart);
      return result;
    } as typeof res.end;

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
      if (registeredClients.size >= MAX_REGISTERED_CLIENTS) {
        log("warn", "oauth_register_limit", { count: registeredClients.size });
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "too_many_clients" }));
        return;
      }

      try {
        const body = await readBody(req);
        const data = JSON.parse(body);
        const clientName = typeof data.client_name === "string" ? data.client_name.slice(0, 128) : "mcp-client";
        const redirectUris = Array.isArray(data.redirect_uris)
          ? data.redirect_uris.filter((u: unknown) => typeof u === "string").slice(0, 5) as string[]
          : [];

        const newClientId = randomBytes(16).toString("hex");
        const newClientSecret = randomBytes(32).toString("hex");

        registeredClients.set(newClientId, {
          clientSecret: newClientSecret,
          clientName,
          redirectUris,
          createdAt: Date.now(),
        });

        log("info", "oauth_register", { client_id: newClientId, client_name: clientName });
        saveAuthStore();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          client_id: newClientId,
          client_secret: newClientSecret,
          client_name: clientName,
          redirect_uris: redirectUris,
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
      const clientId = url.searchParams.get("client_id");

      // Validate redirect_uri against registered client
      if (redirectUri && clientId) {
        const client = registeredClients.get(clientId);
        const isStaticClient = clientId === AUTH_CLIENT_ID;
        if (!isStaticClient && client && client.redirectUris.length > 0) {
          if (!client.redirectUris.includes(redirectUri)) {
            log("warn", "oauth_authorize_bad_redirect", { client_id: clientId, redirect_uri: redirectUri });
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_redirect_uri" }));
            return;
          }
        }
      }

      const code = randomBytes(32).toString("hex");
      authCodes.set(code, { expiresAt: Date.now() + 300_000 });

      log("info", "oauth_authorize", { client_id: clientId, redirect_uri: redirectUri });

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

        let clientId = params.get("client_id");
        let clientSecret = params.get("client_secret");

        // Support Basic auth header
        const basicAuth = req.headers.authorization;
        if (basicAuth?.startsWith("Basic ")) {
          const decoded = Buffer.from(basicAuth.slice(6), "base64").toString();
          const colonIdx = decoded.indexOf(":");
          if (colonIdx > 0) {
            clientId = clientId || decoded.slice(0, colonIdx);
            clientSecret = clientSecret || decoded.slice(colonIdx + 1);
          }
        }

        log("info", "oauth_token", { grant_type: grantType, client_id: clientId });

        // Validate client credentials (constant-time comparison)
        const isStaticClient = !!clientId && !!clientSecret
          && safeEqual(clientId, AUTH_CLIENT_ID)
          && safeEqual(clientSecret, AUTH_CLIENT_SECRET);
        const registeredInfo = clientId ? registeredClients.get(clientId) : undefined;
        const isRegisteredValid = !!registeredInfo
          && (!clientSecret || safeEqual(clientSecret, registeredInfo.clientSecret));

        if (grantType === "client_credentials") {
          if (isAuthEnabled() && !isStaticClient && !isRegisteredValid) {
            log("warn", "oauth_token_rejected", { client_id: clientId, reason: "invalid_client" });
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_client" }));
            return;
          }
        }

        if (grantType === "client_credentials" || grantType === "authorization_code") {
          if (grantType === "authorization_code") {
            const code = params.get("code");
            if (!code || !authCodes.has(code)) {
              log("warn", "oauth_token_rejected", { client_id: clientId, reason: "invalid_grant" });
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "invalid_grant" }));
              return;
            }
            authCodes.delete(code);
          }

          const token = randomBytes(48).toString("hex");
          activeTokens.set(token, Date.now() + TOKEN_TTL_MS);
          saveAuthStore();

          log("info", "oauth_token_issued", { client_id: clientId, grant_type: grantType });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            access_token: token,
            token_type: "bearer",
            expires_in: TOKEN_TTL_MS / 1000,
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

    // ── Health (no sensitive data) ────────────────────────────────────────
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "grok-search-mcp-server", version: "1.0.0" }));
      return;
    }

    // ── Stats (protected) ─────────────────────────────────────────────────
    if (req.method === "GET" && req.url === "/stats") {
      if (!checkBearer(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...stats,
        uptime_seconds: Math.floor((Date.now() - new Date(stats.startedAt).getTime()) / 1000),
        active_tokens: activeTokens.size,
        registered_clients: registeredClients.size,
      }));
      return;
    }

    // ── MCP (protected) ───────────────────────────────────────────────────
    if (req.method === "POST" && req.url === "/mcp") {
      if (!checkBearer(req)) {
        log("warn", "mcp_unauthorized", { ip: getClientIp(req) });
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

        const srv = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });

        res.on("close", () => transport.close());
        await srv.connect(transport);
        await transport.handleRequest(req, res, parsed);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log("error", "mcp_error", { error: msg });
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: msg }));
        }
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Use POST /mcp" }));
  });

  httpServer.listen(port, () => {
    log("info", "server_started", {
      transport: "http",
      port,
      base_url: configuredBaseUrl || "(auto-detect)",
      auth: isAuthEnabled() ? "enabled" : "disabled",
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
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
