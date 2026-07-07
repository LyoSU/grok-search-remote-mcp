import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerRequest, ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
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
const ACCESS_TOKEN_TTL_MS = 60 * 60_000; // 1 hour (short-lived, per OAuth 2.1)
const REFRESH_TOKEN_TTL_MS = 30 * 86_400_000; // 30 days
const AUTH_CODE_TTL_MS = 5 * 60_000; // 5 minutes
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

// The shared secret that authenticates the resource owner at /authorize.
// Defaults to AUTH_CLIENT_SECRET so no extra config is required.
const AUTH_ACCESS_PASSWORD = process.env.AUTH_ACCESS_PASSWORD || AUTH_CLIENT_SECRET;

// Access tokens with expiry (short-lived)
const activeTokens = new Map<string, number>(); // token -> expiresAt

// Refresh tokens with expiry, bound to the client they were issued to
const refreshTokens = new Map<string, { expiresAt: number; clientId: string }>();

// Authorization codes (short-lived), bound to client + PKCE challenge
const authCodes = new Map<string, {
  expiresAt: number;
  clientId: string;
  redirectUri: string | null;
  codeChallenge: string; // "" when the client did not use PKCE
  resource: string | null;
}>();

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
  refreshTokens?: Array<[string, { expiresAt: number; clientId: string }]>;
  clients: Array<[string, { clientSecret: string; clientName: string; redirectUris: string[]; createdAt: number }]>;
}

function loadAuthStore(): void {
  try {
    const raw = readFileSync(AUTH_STORE_PATH, "utf-8");
    const data: AuthStore = JSON.parse(raw);
    const now = Date.now();
    // Reject any persisted access token whose remaining lifetime exceeds the
    // current short-lived ceiling — this drops long tokens minted by earlier
    // versions before access tokens were made short-lived.
    const maxRemaining = ACCESS_TOKEN_TTL_MS + 60_000;
    let loaded = 0;
    let dropped = 0;
    for (const [token, expiresAt] of data.tokens || []) {
      if (expiresAt > now && expiresAt - now <= maxRemaining) {
        activeTokens.set(token, expiresAt);
        loaded++;
      } else if (expiresAt > now) {
        dropped++;
      }
    }
    for (const [rt, info] of data.refreshTokens || []) {
      if (info.expiresAt > now) refreshTokens.set(rt, info);
    }
    for (const [id, info] of data.clients || []) {
      registeredClients.set(id, info);
    }
    if (loaded > 0 || dropped > 0 || (data.clients?.length ?? 0) > 0) {
      log("info", "auth_store_loaded", {
        tokens: loaded,
        dropped_legacy_tokens: dropped,
        refresh_tokens: refreshTokens.size,
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
      refreshTokens: [...refreshTokens.entries()],
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
  let expiredRefresh = 0;

  for (const [token, expiresAt] of activeTokens) {
    if (now > expiresAt) { activeTokens.delete(token); expiredTokens++; }
  }
  for (const [code, { expiresAt }] of authCodes) {
    if (now > expiresAt) { authCodes.delete(code); expiredCodes++; }
  }
  for (const [rt, { expiresAt }] of refreshTokens) {
    if (now > expiresAt) { refreshTokens.delete(rt); expiredRefresh++; }
  }

  if (expiredTokens > 0 || expiredCodes > 0 || expiredRefresh > 0) {
    log("info", "cleanup", {
      expired_tokens: expiredTokens,
      expired_codes: expiredCodes,
      expired_refresh: expiredRefresh,
      active_tokens: activeTokens.size,
      registered_clients: registeredClients.size,
    });
    saveAuthStore();
  }
}, CLEANUP_INTERVAL_MS);

// ─── OAuth Helpers ────────────────────────────────────────────────────────────

// Verify a PKCE code_verifier against a stored S256 code_challenge.
function verifyPkceS256(verifier: string, challenge: string): boolean {
  const hash = createHash("sha256").update(verifier).digest("base64url");
  if (hash.length !== challenge.length) return false;
  return timingSafeEqual(Buffer.from(hash), Buffer.from(challenge));
}

// Escape untrusted values before reflecting them into the consent HTML page.
function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// A redirect_uri is only acceptable if it is HTTPS or a loopback address,
// preventing open-redirect abuse of the authorization endpoint.
function isSafeRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    return (u.protocol === "http:") && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
  } catch {
    return false;
  }
}

// Issue a short-lived access token and persist it.
function issueAccessToken(): { token: string; expiresIn: number } {
  const token = randomBytes(48).toString("hex");
  activeTokens.set(token, Date.now() + ACCESS_TOKEN_TTL_MS);
  return { token, expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000) };
}

// Issue a rotating refresh token bound to a client.
function issueRefreshToken(clientId: string): string {
  const rt = randomBytes(48).toString("hex");
  refreshTokens.set(rt, { expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS, clientId });
  return rt;
}

// Minimal, self-contained consent/login page for the authorization endpoint.
function renderConsentPage(fields: Record<string, string>, error?: string): string {
  const hidden = Object.entries(fields)
    .filter(([, v]) => v)
    .map(([k, v]) => `<input type="hidden" name="${htmlEscape(k)}" value="${htmlEscape(v)}">`)
    .join("\n      ");
  const errorBlock = error ? `<p class="err">${htmlEscape(error)}</p>` : "";
  return `<!doctype html>
<html lang="uk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize · Grok Search MCP</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center;
      font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: #0b0d12; color: #e7e9ee; }
    .card { width: min(92vw, 380px); padding: 32px; border-radius: 16px;
      background: #151922; border: 1px solid #232937; box-shadow: 0 20px 60px rgba(0,0,0,.4); }
    h1 { margin: 0 0 4px; font-size: 20px; }
    p.sub { margin: 0 0 24px; color: #97a0b3; font-size: 13px; }
    label { display: block; margin: 0 0 8px; font-size: 13px; color: #b7bfce; }
    input[type=password] { width: 100%; padding: 12px 14px; border-radius: 10px;
      border: 1px solid #2b3242; background: #0f131b; color: #e7e9ee; font-size: 15px; }
    input[type=password]:focus { outline: none; border-color: #4c8dff; }
    button { width: 100%; margin-top: 18px; padding: 12px; border: 0; border-radius: 10px;
      background: #4c8dff; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
    button:hover { background: #3a7bf0; }
    .err { margin: 0 0 16px; padding: 10px 12px; border-radius: 8px;
      background: #3a1720; border: 1px solid #6b2434; color: #ff9db0; font-size: 13px; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Grok Search MCP</h1>
    <p class="sub">Enter the access secret to authorize this client.</p>
    ${errorBlock}
    <form method="POST" action="/authorize">
      ${hidden}
      <label for="password">Access secret</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
      <button type="submit">Authorize</button>
    </form>
  </main>
</body>
</html>`;
}

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

  // Extra origins allowed to talk to the MCP endpoint from a browser.
  const extraAllowedOrigins = new Set(
    (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
  );

  // DNS-rebinding protection: a browser Origin must match our own host or an
  // explicit allowlist. Non-browser clients send no Origin and are allowed.
  function isOriginAllowed(req: IncomingMessage, baseUrl: string): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (extraAllowedOrigins.has(origin)) return true;
    try {
      return new URL(origin).host === new URL(baseUrl).host;
    } catch {
      return false;
    }
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

    // ── OAuth Protected Resource Metadata (RFC 9728) ──────────────────────
    // Clients discover the resource FIRST, then follow authorization_servers
    // to the authorization-server metadata below. Both the bare path and the
    // "/mcp"-suffixed path are served, since clients try either.
    if (
      req.method === "GET" &&
      (req.url === "/.well-known/oauth-protected-resource" ||
        req.url === "/.well-known/oauth-protected-resource/mcp")
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        resource: `${baseUrl}/mcp`,
        authorization_servers: [baseUrl],
        bearer_methods_supported: ["header"],
      }));
      return;
    }

    // ── OAuth Discovery ───────────────────────────────────────────────────
    if (req.method === "GET" && req.url === "/.well-known/oauth-authorization-server") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
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
    // GET renders the consent page; POST authenticates the resource owner via
    // the shared access secret and only then issues an authorization code.
    if (req.url?.split("?")[0] === "/authorize" && (req.method === "GET" || req.method === "POST")) {
      // Collect parameters from either the query string (GET) or the form body (POST).
      let src: URLSearchParams;
      if (req.method === "POST") {
        src = new URLSearchParams(await readBody(req));
      } else {
        src = new URL(req.url, baseUrl).searchParams;
      }

      const responseType = src.get("response_type") || "code";
      const clientId = src.get("client_id") || "";
      const redirectUri = src.get("redirect_uri");
      const state = src.get("state");
      const codeChallenge = src.get("code_challenge") || "";
      const codeChallengeMethod = src.get("code_challenge_method") || "";
      const resource = src.get("resource");
      const scope = src.get("scope") || "";

      const fields: Record<string, string> = {
        response_type: responseType,
        client_id: clientId,
        redirect_uri: redirectUri || "",
        state: state || "",
        code_challenge: codeChallenge,
        code_challenge_method: codeChallengeMethod,
        resource: resource || "",
        scope,
      };

      if (responseType !== "code") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unsupported_response_type" }));
        return;
      }

      // Reject unusable redirect targets up front (open-redirect protection).
      if (redirectUri) {
        if (!isSafeRedirectUri(redirectUri)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_redirect_uri" }));
          return;
        }
        const client = registeredClients.get(clientId);
        if (client && client.redirectUris.length > 0 && !client.redirectUris.includes(redirectUri)) {
          log("warn", "oauth_authorize_bad_redirect", { client_id: clientId, redirect_uri: redirectUri });
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_redirect_uri" }));
          return;
        }
      }

      // PKCE is mandatory (OAuth 2.1 / MCP): the authorization request must
      // carry an S256 code_challenge, otherwise a stolen code could be redeemed.
      if (!codeChallenge || codeChallengeMethod !== "S256") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_request", error_description: "PKCE required: send code_challenge with code_challenge_method=S256" }));
        return;
      }

      // GET → show the login/consent form.
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderConsentPage(fields));
        return;
      }

      // POST → authenticate the resource owner with the shared access secret.
      const password = src.get("password") || "";
      if (!AUTH_ACCESS_PASSWORD || !safeEqual(password, AUTH_ACCESS_PASSWORD)) {
        log("warn", "oauth_authorize_denied", { client_id: clientId, ip: getClientIp(req) });
        res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderConsentPage(fields, "Incorrect access secret."));
        return;
      }

      const code = randomBytes(32).toString("hex");
      authCodes.set(code, {
        expiresAt: Date.now() + AUTH_CODE_TTL_MS,
        clientId,
        redirectUri: redirectUri || null,
        codeChallenge,
        resource: resource || null,
      });
      log("info", "oauth_authorize_granted", { client_id: clientId, redirect_uri: redirectUri, pkce: !!codeChallenge });

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

        const isStaticClient = !!clientId && !!clientSecret
          && safeEqual(clientId, AUTH_CLIENT_ID)
          && safeEqual(clientSecret, AUTH_CLIENT_SECRET);
        const registeredInfo = clientId ? registeredClients.get(clientId) : undefined;

        const sendTokens = (withRefresh: boolean): void => {
          const { token, expiresIn } = issueAccessToken();
          const payload: Record<string, unknown> = {
            access_token: token,
            token_type: "bearer",
            expires_in: expiresIn,
          };
          if (withRefresh) payload.refresh_token = issueRefreshToken(clientId || "");
          saveAuthStore();
          log("info", "oauth_token_issued", { client_id: clientId, grant_type: grantType });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        };

        // ── client_credentials: machine-to-machine, static client ONLY ──────
        if (grantType === "client_credentials") {
          if (isAuthEnabled() && !isStaticClient) {
            log("warn", "oauth_token_rejected", { client_id: clientId, reason: "invalid_client" });
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_client" }));
            return;
          }
          sendTokens(false);
          return;
        }

        // ── authorization_code: consumes a code minted at /authorize ─────────
        if (grantType === "authorization_code") {
          const code = params.get("code") || "";
          const entry = authCodes.get(code);
          if (!entry || entry.expiresAt < Date.now()) {
            if (entry) authCodes.delete(code);
            log("warn", "oauth_token_rejected", { client_id: clientId, reason: "invalid_grant" });
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }
          authCodes.delete(code); // single use

          // Bind the code to the client and redirect_uri it was issued for.
          const redirectUri = params.get("redirect_uri");
          if ((entry.clientId && clientId && entry.clientId !== clientId)
            || (entry.redirectUri && redirectUri !== entry.redirectUri)) {
            log("warn", "oauth_token_rejected", { client_id: clientId, reason: "grant_mismatch" });
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }

          // PKCE is mandatory: every code carries an S256 challenge, verify it.
          const verifier = params.get("code_verifier") || "";
          if (!entry.codeChallenge || !verifier || !verifyPkceS256(verifier, entry.codeChallenge)) {
            log("warn", "oauth_token_rejected", { client_id: clientId, reason: "pkce_failed" });
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }

          // A registered confidential client MUST authenticate with its secret
          // (present AND matching) — an absent secret is not an escape hatch.
          if (registeredInfo?.clientSecret
            && (!clientSecret || !safeEqual(clientSecret, registeredInfo.clientSecret))) {
            log("warn", "oauth_token_rejected", { client_id: clientId, reason: "invalid_client" });
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_client" }));
            return;
          }

          sendTokens(true);
          return;
        }

        // ── refresh_token: rotate and re-issue ──────────────────────────────
        if (grantType === "refresh_token") {
          const rt = params.get("refresh_token") || "";
          const info = refreshTokens.get(rt);
          if (!info || info.expiresAt < Date.now()) {
            if (info) refreshTokens.delete(rt);
            log("warn", "oauth_token_rejected", { client_id: clientId, reason: "invalid_grant" });
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }
          // The refresh token is bound to the client it was issued to.
          if (clientId && info.clientId && clientId !== info.clientId) {
            log("warn", "oauth_token_rejected", { client_id: clientId, reason: "client_mismatch" });
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }

          // Confidential clients (static or a registered client with a secret)
          // MUST authenticate to rotate a refresh token.
          const boundIsStatic = !!info.clientId && !!AUTH_CLIENT_ID && safeEqual(info.clientId, AUTH_CLIENT_ID);
          const boundRegistered = info.clientId ? registeredClients.get(info.clientId) : undefined;
          const requiredSecret = boundIsStatic ? AUTH_CLIENT_SECRET : boundRegistered?.clientSecret;
          if (requiredSecret && (!clientSecret || !safeEqual(clientSecret, requiredSecret))) {
            log("warn", "oauth_token_rejected", { client_id: info.clientId, reason: "invalid_client" });
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_client" }));
            return;
          }

          refreshTokens.delete(rt); // rotation: old refresh token is invalidated
          clientId = info.clientId; // new tokens stay bound to the original client
          sendTokens(true);
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
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
        });
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
      if (!isOriginAllowed(req, baseUrl)) {
        log("warn", "mcp_forbidden_origin", { origin: req.headers.origin, ip: getClientIp(req) });
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden_origin" }));
        return;
      }
      if (!checkBearer(req)) {
        log("warn", "mcp_unauthorized", { ip: getClientIp(req) });
        res.writeHead(401, {
          "Content-Type": "application/json",
          "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
        });
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

    // This server does not offer an SSE stream or client-terminated sessions,
    // so per the Streamable HTTP spec GET/DELETE on the MCP endpoint are 405.
    if (req.url === "/mcp" && (req.method === "GET" || req.method === "DELETE")) {
      res.writeHead(405, { "Content-Type": "application/json", "Allow": "POST" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
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
