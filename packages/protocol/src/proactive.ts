// Proactive Bots (P6): routines with their triggers (FR-PRO-02, FR-UI-06), run history,
// suggestion cards (FR-PRO-04), actions held for the user's approval (NFR-SEC-11) and the
// pause switches (FR-PRO-06).
import { z } from 'zod';

const Id = z.string().min(1).max(64);
const Tz = z.string().min(1).max(64);

export const TRIGGER_KINDS = ['schedule', 'mail', 'calendar', 'watch', 'webhook', 'mcp', 'digest'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const Trigger = z.discriminatedUnion('kind', [
  /** cron-like: minute hour day-of-month month day-of-week, in the user's time zone */
  z.object({ kind: z.literal('schedule'), cron: z.string().trim().min(9).max(120), tz: Tz }).strict(),
  /** new mail in Gmail matching a search filter (polled) */
  z.object({ kind: z.literal('mail'), filter: z.string().max(500).default('') }).strict(),
  /** a calendar event starts within `leadMinutes` */
  z.object({ kind: z.literal('calendar'), leadMinutes: z.number().int().min(1).max(24 * 60).default(15) }).strict(),
  /** files changed in Drive (name filter) or in a folder of the Bot's computer */
  z.object({ kind: z.literal('watch'), source: z.enum(['drive', 'computer']), path: z.string().max(500).default('') }).strict(),
  /** an HTTPS POST to this routine's secret address */
  z.object({ kind: z.literal('webhook') }).strict(),
  /** an MCP server says a resource changed */
  z.object({ kind: z.literal('mcp'), serverId: Id, uri: z.string().min(1).max(2000) }).strict(),
  /** once a day at HH:MM */
  z.object({ kind: z.literal('digest'), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), tz: Tz }).strict(),
]);
export type Trigger = z.infer<typeof Trigger>;

export const RunStatus = z.enum(['queued', 'running', 'done', 'error', 'stopped', 'skipped']);
export type RunStatus = z.infer<typeof RunStatus>;

export const Routine = z.object({
  id: z.string(),
  botId: z.string(),
  name: z.string(),
  instructions: z.string(),
  trigger: Trigger,
  paused: z.boolean(),
  nextRun: z.number().nullable(),
  lastRun: z.object({ at: z.number(), status: RunStatus }).nullable(),
  /** webhook routines: the address to POST to (the secret part is shown only on creation) */
  webhookUrl: z.string().nullable(),
  createdAt: z.number(),
});
export type Routine = z.infer<typeof Routine>;

export const RoutineCreate = z.object({
  botId: Id,
  name: z.string().trim().min(1).max(80),
  instructions: z.string().trim().min(1).max(20_000),
  trigger: Trigger,
}).strict();
export type RoutineCreate = z.infer<typeof RoutineCreate>;

export const RoutinePatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  instructions: z.string().trim().min(1).max(20_000).optional(),
  trigger: Trigger.optional(),
  paused: z.boolean().optional(),
}).strict();

export const RoutineRun = z.object({
  id: z.string(),
  routineId: z.string().nullable(),
  botId: z.string(),
  status: RunStatus,
  /** what started it, in a few words (for example the mail subject) */
  trigger: z.string(),
  /** the chat and message that hold the output */
  convId: z.string().nullable(),
  messageId: z.string().nullable(),
  error: z.string().nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
});
export type RoutineRun = z.infer<typeof RoutineRun>;

export const Suggestion = z.object({
  id: z.string(),
  botId: z.string(),
  title: z.string(),
  detail: z.string(),
  rank: z.number().int(),
  status: z.enum(['open', 'running', 'done', 'dismissed']),
  runId: z.string().nullable(),
  createdAt: z.number(),
});
export type Suggestion = z.infer<typeof Suggestion>;

/** A tool call a non-proactive Bot made after reading outside content; it runs only if the user allows it. */
export const HeldAction = z.object({
  id: z.string(),
  botId: z.string(),
  convId: z.string(),
  tool: z.string(),
  /** the exact input, shown in full */
  input: z.string(),
  createdAt: z.number(),
});
export type HeldAction = z.infer<typeof HeldAction>;

export const ProactiveState = z.object({ paused: z.boolean() });
export type ProactiveState = z.infer<typeof ProactiveState>;

export const PROACTIVE_EVENTS = {
  routine: 'routine.updated',
  run: 'routine.run',
  suggestion: 'suggestion.updated',
  held: 'held.updated',
  state: 'proactive.state',
} as const;
