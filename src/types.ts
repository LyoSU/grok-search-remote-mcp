// xAI Responses API types

export interface GrokResponseInput {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface GrokWebSearchTool {
  type: "web_search";
  allowedDomains?: string[];
  excludedDomains?: string[];
  lookBackDays?: number;
}

export interface GrokXSearchTool {
  type: "x_search";
  allowed_x_handles?: string[];
  blocked_x_handles?: string[];
  from_date?: string;
  to_date?: string;
}

export type GrokTool = GrokWebSearchTool | GrokXSearchTool;

export interface GrokRequestBody {
  model: string;
  input: GrokResponseInput[];
  tools: GrokTool[];
  temperature?: number;
  max_output_tokens?: number;
  instructions?: string;
  include?: string[];
  reasoning?: { effort: "low" | "medium" | "high" | "xhigh" };
}

export interface UrlCitation {
  type: "url_citation";
  url: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}

export interface GrokAnnotation {
  type: string;
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
  [key: string]: unknown;
}

export interface GrokOutputTextBlock {
  type: "output_text";
  text: string;
  annotations?: GrokAnnotation[];
}

export interface GrokContentBlock {
  type: string;
  text?: string;
  name?: string;
  content?: unknown;
  call_id?: string;
  id?: string;
  status?: string;
  annotations?: GrokAnnotation[];
  [key: string]: unknown;
}

export interface GrokResponse {
  id: string;
  output: GrokContentBlock[];
  citations?: string[];
  error?: {
    message: string;
    type: string;
    code?: string;
  };
}

export interface SearchConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface ParsedGrokResult {
  text: string;
  citations: Array<{ url: string; title: string }>;
}
