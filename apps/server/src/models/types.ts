// Provider-neutral chat types for the model router (D-07, FR-BOT-04).

export interface TextPart { type: 'text'; text: string }
export interface ImagePart { type: 'image'; mime: string; dataB64: string }
export type UserPart = TextPart | ImagePart;

export interface ToolCall { id: string; name: string; input: unknown }

export type ModelMessage =
  | { role: 'user'; content: UserPart[] }
  | { role: 'assistant'; text: string; toolCalls?: ToolCall[]; /** provider-native blocks to replay inside one tool loop */ native?: unknown }
  | { role: 'tool'; toolCallId: string; content: string; isError?: boolean; /** screenshots from computer tools */ images?: ImagePart[]; /** this result carries outside content (NFR-SEC-11); never sent to the model */ taint?: 'work' | 'outside' };

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object) */
  parameters: Record<string, unknown>;
}

export interface Usage { inputTokens: number; outputTokens: number; costUsd: number | null }

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; text: string; toolCalls: ToolCall[]; usage: Usage | null; stop: 'end' | 'tool_use' | 'max_tokens' | 'refusal'; native?: unknown };

export interface ChatRequest {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
}

export interface ModelProvider {
  /** Streams one model turn. The last event is always 'done'. */
  stream(req: ChatRequest): AsyncIterable<StreamEvent>;
  /** Model ids the source offers, if it can list them. */
  listModels(signal: AbortSignal): Promise<string[]>;
}

export class ProviderError extends Error {
  constructor(readonly code: 'auth' | 'rate_limited' | 'bad_request' | 'unavailable' | 'not_signed_in' | 'failed', message: string) {
    super(message);
  }
}
