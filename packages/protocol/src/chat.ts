// Bots, chat, model sources, library, usage and push schemas (P2: FR-UI-01..04, FR-BOT-01..05,
// D-07, D-18). Shared by server and clients.
import { z } from 'zod';

const Id = z.string().min(3).max(64).regex(/^[a-z]+_[A-Za-z0-9_-]+$/);

// ---- Model sources (D-07, FR-BOT-04)
export const ModelSourceKind = z.enum([
  'local', // OpenAI-compatible server on the LAN or this host (llama.cpp, Ollama, LM Studio, vLLM)
  'openai', // OpenAI API key
  'anthropic', // Anthropic API key
  'openai-compatible', // any OpenAI-compatible API with a key
  'claude-subscription', // Claude subscription through the official Claude Code CLI (owner only)
  'chatgpt-subscription', // ChatGPT subscription through the official Codex CLI (owner only)
]);
export type ModelSourceKind = z.infer<typeof ModelSourceKind>;
export const SUBSCRIPTION_KINDS: readonly ModelSourceKind[] = ['claude-subscription', 'chatgpt-subscription'];

export const ModelSource = z.object({
  id: z.string(),
  kind: ModelSourceKind,
  name: z.string(),
  baseUrl: z.string().nullable(),
  hasKey: z.boolean(),
  /** subscription sources: whether the CLI is signed in */
  signedIn: z.boolean().optional(),
  createdAt: z.number(),
});
export type ModelSource = z.infer<typeof ModelSource>;

export const CreateModelSourceReq = z.object({
  kind: ModelSourceKind,
  name: z.string().trim().min(1).max(64),
  baseUrl: z.string().url().max(300).optional(),
  apiKey: z.string().min(1).max(500).optional(),
  /** claude-subscription: the long-lived token printed by `claude setup-token` */
  token: z.string().min(10).max(2000).optional(),
});
export const UpdateModelSourceReq = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  baseUrl: z.string().url().max(300).optional(),
  apiKey: z.string().min(1).max(500).optional(),
  token: z.string().min(10).max(2000).optional(),
});

// ---- Bots (FR-BOT-01, FR-UI-03)
export const Engine = z.enum(['claude-agent-sdk', 'codex', 'opencode']);
export type Engine = z.infer<typeof Engine>;

export const Bot = z.object({
  id: z.string(),
  name: z.string(),
  avatar: z.string(),
  instructions: z.string(),
  sourceId: z.string().nullable(),
  model: z.string(),
  engine: Engine,
  tools: z.array(z.string()),
  primary: z.boolean(),
  proactive: z.boolean(),
  /** per-Bot pause of proactivity (FR-PRO-06) */
  paused: z.boolean(),
  hostControl: z.boolean(),
  notify: z.enum(['all', 'off']),
  createdAt: z.number(),
});
export type Bot = z.infer<typeof Bot>;

/**
 * Tools a Bot may be given. delegate: hand tasks to other Bots (P2). code: run a coding engine
 * in the Bot's computer (P3, FR-CODE-*). computer: see and use the Bot's own desktop (P3).
 * host: control the server's own desktop, only when Host control is on (D-12, FR-PC-09).
 */
export const BOT_TOOLS = ['delegate', 'code', 'computer', 'host'] as const;

export const CreateBotReq = z.object({
  name: z.string().trim().min(1).max(48),
  avatar: z.string().max(8).optional(),
  instructions: z.string().max(20_000).optional(),
  sourceId: z.string().max(64).nullable().optional(),
  model: z.string().max(200).optional(),
  engine: Engine.optional(),
  tools: z.array(z.enum(BOT_TOOLS)).max(16).optional(),
});
export const UpdateBotReq = CreateBotReq.partial().extend({
  proactive: z.boolean().optional(),
  paused: z.boolean().optional(),
  hostControl: z.boolean().optional(),
  notify: z.enum(['all', 'off']).optional(),
});

// ---- Conversations and messages (FR-UI-01, FR-UI-02, FR-BOT-03)
export const Conversation = z.object({
  id: z.string(),
  kind: z.enum(['direct', 'group']),
  title: z.string(),
  botIds: z.array(z.string()),
  updatedAt: z.number(),
  lastPreview: z.string(),
  unread: z.number(),
});
export type Conversation = z.infer<typeof Conversation>;

export const CreateGroupReq = z.object({
  title: z.string().trim().min(1).max(80),
  botIds: z.array(Id).min(1).max(12),
});
export const UpdateGroupReq = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  botIds: z.array(Id).min(1).max(12).optional(),
});
export const OpenDirectReq = z.object({ botId: Id });

export const Attachment = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
});
export type Attachment = z.infer<typeof Attachment>;

export const Message = z.object({
  id: z.string(),
  conversationId: z.string(),
  /** 'user' messages carry userId; 'bot' messages carry botId */
  author: z.enum(['user', 'bot', 'system']),
  userId: z.string().nullable(),
  botId: z.string().nullable(),
  text: z.string(),
  parentId: z.string().nullable(),
  attachments: z.array(Attachment),
  mentions: z.array(z.string()),
  reactions: z.array(z.object({ emoji: z.string(), count: z.number(), mine: z.boolean() })),
  status: z.enum(['done', 'streaming', 'error']),
  error: z.string().nullable(),
  replyCount: z.number(),
  /** coding engine activity shown with the reply (FR-CODE-04) */
  steps: z.array(z.object({
    id: z.string(), kind: z.enum(['command', 'diff', 'tool', 'plan']), title: z.string(), body: z.string(),
    status: z.enum(['running', 'done', 'failed']), exitCode: z.number().nullable(),
  })).optional(),
  createdAt: z.number(),
});
export type Message = z.infer<typeof Message>;

export const SendMessageReq = z.object({
  text: z.string().max(100_000),
  parentId: Id.nullable().optional(),
  attachmentIds: z.array(Id).max(10).optional(),
  /** client-generated id so a retried send is not duplicated */
  clientId: z.string().min(8).max(64),
});
export const ReactReq = z.object({ emoji: z.string().min(1).max(16) });
export const DraftReq = z.object({ text: z.string().max(100_000) });

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const UploadAttachmentReq = z.object({
  name: z.string().trim().min(1).max(255),
  mime: z.string().min(3).max(120).regex(/^[\w.+-]+\/[\w.+-]+$/),
  /** base64 of the file, at most MAX_ATTACHMENT_BYTES decoded */
  dataB64: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4),
});
export const AttachmentData = Attachment.extend({ dataB64: z.string() });
export type AttachmentData = z.infer<typeof AttachmentData>;

// ---- Library (FR-UI-04)
export const LibraryItem = z.object({
  id: z.string(),
  botId: z.string().nullable(),
  kind: z.enum(['page', 'image', 'video', 'file', 'link']),
  title: z.string(),
  url: z.string().nullable(),
  attachmentId: z.string().nullable(),
  messageId: z.string().nullable(),
  conversationId: z.string().nullable(),
  createdAt: z.number(),
});
export type LibraryItem = z.infer<typeof LibraryItem>;

// ---- Usage (FR-BOT-05)
export const UsageRow = z.object({
  botId: z.string(),
  sourceKind: ModelSourceKind,
  sourceId: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  /** null when the provider does not report cost */
  costUsd: z.number().nullable(),
  turns: z.number(),
});
export type UsageRow = z.infer<typeof UsageRow>;

// ---- Search (FR-UI-01)
export const SearchResult = z.object({
  messages: z.array(z.object({ id: z.string(), conversationId: z.string(), snippet: z.string(), createdAt: z.number() })),
  bots: z.array(z.object({ id: z.string(), name: z.string() })),
  groups: z.array(z.object({ id: z.string(), title: z.string() })),
  files: z.array(z.object({ id: z.string(), title: z.string(), conversationId: z.string().nullable() })),
  routines: z.array(z.object({ id: z.string(), title: z.string() })),
});
export type SearchResult = z.infer<typeof SearchResult>;

// ---- Push (D-18): the payload is only "wake up" plus an id, never content.
export const RegisterPushReq = z.object({
  endpoint: z.string().url().max(1000),
});
export const PushPayload = z.object({ t: z.literal('wake'), id: z.string() });
export const Notifications = z.object({
  /** ntfy server the Android app's UnifiedPush distributor uses (D-18) */
  pushServer: z.string().nullable(),
  /** app-wide mute for this user */
  muted: z.boolean(),
  /** whether this device has a push endpoint registered */
  registered: z.boolean(),
});
export type Notifications = z.infer<typeof Notifications>;
export const NotificationsPatch = z.object({
  muted: z.boolean().optional(),
  /** owner only; null turns push off */
  pushServer: z.string().url().max(300).nullable().optional(),
}).strict();

// ---- Subscription sign-in (D-07c): ChatGPT through the Codex CLI device login
export const DeviceLogin = z.object({
  state: z.enum(['starting', 'waiting', 'done', 'failed']),
  url: z.string().nullable(),
  code: z.string().nullable(),
  error: z.string().nullable(),
});
export type DeviceLogin = z.infer<typeof DeviceLogin>;

// ---- Activity log (base)
export const ActivityEntry = z.object({
  id: z.string(),
  at: z.number(),
  botId: z.string().nullable(),
  /** rendered by the client from its i18n strings: activity.kinds.<kind> */
  kind: z.string(),
  params: z.record(z.string(), z.string()),
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

// ---- WebSocket events for chat (server -> client)
export const CHAT_EVENTS = {
  messageCreated: 'message.created',
  messageDelta: 'message.delta',
  messageDone: 'message.done',
  messageUpdated: 'message.updated',
  conversationUpdated: 'conversation.updated',
  libraryAdded: 'library.added',
  botUpdated: 'bot.updated',
} as const;
