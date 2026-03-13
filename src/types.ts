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
}

export interface GrokContentBlock {
  type: string;
  text?: string;
  name?: string;
  content?: string;
  call_id?: string;
  id?: string;
  status?: string;
  results?: GrokSearchResult[];
  [key: string]: unknown;
}

export interface GrokSearchResult {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
  [key: string]: unknown;
}

export interface GrokResponse {
  id: string;
  output: GrokContentBlock[];
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
