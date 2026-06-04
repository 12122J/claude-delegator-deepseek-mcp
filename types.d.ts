/**
 * TypeScript type definitions for claude-code-deepseek-delegator MCP server.
 *
 * Provides compile-time type checking for tool schemas, DeepSeek API parameters,
 * model registry, pricing, and JSON-RPC message formats.
 *
 * @module claude-code-deepseek-delegator
 */

// ── DeepSeek API ────────────────────────────────────────────────────────────

/** Parameters for delegating a task to DeepSeek via callDeepSeek / the deepseek tool. */
export interface DeepSeekParams {
  /** The full task/prompt to send to DeepSeek. Required. */
  prompt: string;

  /** Optional system prompt to set context/behavior. */
  system?: string;

  /**
   * DeepSeek model to use.
   * @default "deepseek-v4-pro"
   */
  model?: DeepSeekModelId;

  /**
   * Temperature (0-2). Lower = more deterministic.
   * @default 0.3
   */
  temperature?: number;

  /**
   * Max tokens in the response.
   * @default Model max output tokens
   */
  maxTokens?: number;

  /**
   * Stream the response as incremental chunks.
   * @default false
   */
  stream?: boolean;

  /**
   * Absolute file paths to read server-side and include in the prompt.
   * File contents never pass through Claude's context window.
   */
  files?: string[];
}

/** Known DeepSeek model identifiers. */
export type DeepSeekModelId =
  | 'deepseek-v4-pro'
  | 'deepseek-v4-flash'
  | 'deepseek-reasoner';

/** Response from a DeepSeek API call (streaming). */
export interface DeepSeekStreamedResponse {
  streamed: true;
  /** Array of content chunks (incremental deltas). */
  content: string[];
  model: string | null;
  usage: TokenUsage | null;
  finishReason: string;
}

/** Response from a DeepSeek API call (non-streaming). */
export interface DeepSeekNonStreamedResponse {
  streamed?: false;
  content: string;
  model: string;
  usage: TokenUsage | null;
  finishReason: string;
}

/** Union type for DeepSeek API responses. */
export type DeepSeekResponse = DeepSeekStreamedResponse | DeepSeekNonStreamedResponse;

/** Token usage information from a DeepSeek API response. */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ── Models ──────────────────────────────────────────────────────────────────

/** Descriptor for a single model in the registry. */
export interface ModelDescriptor {
  /** Human-readable model name. */
  name: string;
  /** Maximum context window size in tokens. */
  contextWindow: number;
  /** Maximum output tokens per request. */
  maxOutputTokens: number;
  /** Whether the model supports chain-of-thought / thinking. */
  thinking: boolean;
  /** Human-readable description of the model's strengths. */
  description: string;
}

/** The complete model registry mapping model IDs to their descriptors. */
export type ModelRegistry = Record<DeepSeekModelId, ModelDescriptor>;

/** Listed model entry (returned by listModels). */
export interface ModelListing {
  id: DeepSeekModelId;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  thinking: boolean;
  description: string;
}

// ── Pricing ─────────────────────────────────────────────────────────────────

/** Pricing tier: cost per 1M tokens in USD. */
export interface PricingTier {
  /** Cost per 1M input tokens (USD). */
  input: number;
  /** Cost per 1M output tokens (USD). */
  output: number;
}

/** The pricing registry mapping model IDs to their pricing tiers. */
export type PricingRegistry = Record<DeepSeekModelId, PricingTier>;

/** Savings breakdown comparing DeepSeek to Claude. */
export interface SavingsBreakdown {
  /** Absolute amount saved in USD. */
  saved: number;
  /** Percentage saved (0-100). */
  pct: number;
}

// ── MCP Tool Schemas ────────────────────────────────────────────────────────

/** JSON Schema primitive types. */
type JsonSchemaType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';

/** A JSON Schema property descriptor. */
interface JsonSchemaProperty {
  type: JsonSchemaType;
  description?: string;
  default?: unknown;
  items?: JsonSchemaProperty;
}

/** JSON Schema object definition for MCP tool input. */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/** An MCP tool definition. */
export interface McpTool {
  /** Unique tool name. */
  name: string;
  /** Human-readable description of when to use the tool. */
  description: string;
  /** JSON Schema defining the tool's input parameters. */
  inputSchema: ToolInputSchema;
}

// ── MCP / JSON-RPC 2.0 ──────────────────────────────────────────────────────

/** JSON-RPC 2.0 request object. */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id?: number;
}

/** JSON-RPC 2.0 successful response. */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result: unknown;
}

/** JSON-RPC 2.0 error response. */
export interface JsonRpcError {
  jsonrpc: '2.0';
  id: number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/** JSON-RPC 2.0 message (request, response, or error). */
export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcError;

/** MCP tool call result content item. */
export interface McpContentItem {
  type: 'text';
  text: string;
}

/** MCP tool call result. */
export interface McpToolResult {
  content: McpContentItem[];
}

/** MCP initialization result. */
export interface McpInitializeResult {
  protocolVersion: string;
  capabilities: { tools: Record<string, unknown> };
  serverInfo: {
    name: string;
    version: string;
  };
}

/** MCP tools/list result. */
export interface McpToolsListResult {
  tools: McpTool[];
}

// ── Frame Parsing ───────────────────────────────────────────────────────────

/** Result of parsing Content-Length framed messages from a buffer. */
export interface ParseFramesResult {
  /** Successfully parsed message bodies (JSON strings). */
  consumed: string[];
  /** Unconsumed remainder of the buffer. */
  remainder: string;
}

/** Callback type for parseFrames onMessage. */
export type FrameMessageCallback = (msg: JsonRpcMessage) => void;

// ── Error Types ─────────────────────────────────────────────────────────────

/** Error thrown by the DeepSeek API client. */
export interface DeepSeekError extends Error {
  name: 'DeepSeekError';
  /** HTTP status code (0 for network errors, 401 for missing key, etc.). */
  status: number;
  /** Optional response data from the API. */
  data?: unknown;
}

// ── Environment Configuration ───────────────────────────────────────────────

/** Environment variables recognized by the delegator. */
export interface DeepSeekDelegatorEnv {
  /** DeepSeek API key (required). */
  DEEPSEEK_API_KEY?: string;
  /** API hostname override. @default "api.deepseek.com" */
  DEEPSEEK_API_HOST?: string;
  /** Request timeout in milliseconds. @default 120000 */
  DEEPSEEK_TIMEOUT?: string;
  /** Max retry attempts for 5xx/429 errors. @default 2 */
  DEEPSEEK_MAX_RETRIES?: string;
  /** Suppress ANSI color output. */
  NO_COLOR?: string;
}
