// Bot computer, coding engines and host control (P3: FR-PC-01..09, FR-UI-05, FR-CODE-01..05).
import { z } from 'zod';

// ---- Bot computer (D-09, D-10)
export const ComputerStateKind = z.enum([
  'unavailable', // no container runtime on this server (chat still works, FR-PC-06)
  'preparing', // the image is building or the container is being created
  'starting',
  'running',
  'stopped',
  'disk_full', // over its disk limit; stopped until the limit is raised (FR-PC-05)
  'error',
]);
export type ComputerStateKind = z.infer<typeof ComputerStateKind>;

export const ComputerLimits = z.object({
  cpus: z.number().min(0.5).max(64),
  memoryMb: z.number().int().min(512).max(262_144),
  diskGb: z.number().int().min(1).max(4096),
});
export type ComputerLimits = z.infer<typeof ComputerLimits>;

export const ComputerState = z.object({
  botId: z.string(),
  state: ComputerStateKind,
  /** 0..1 while preparing, when known */
  progress: z.number().nullable(),
  /** short machine code for the UI (for example "runtime_missing", "image_build_failed") */
  detail: z.string().nullable(),
  /** the owner has taken over the mouse and keyboard; the Bot's computer actions wait */
  takeover: z.boolean(),
  gpu: z.boolean(),
  limits: ComputerLimits,
});
export type ComputerState = z.infer<typeof ComputerState>;

/** Short-lived VNC credentials for the live view (FR-UI-05). */
export const ComputerView = z.object({ password: z.string() });
export type ComputerView = z.infer<typeof ComputerView>;

export const ComputerSettings = z.object({
  runtime: z.object({ available: z.boolean(), version: z.string().nullable(), error: z.string().nullable() }),
  image: z.object({ present: z.boolean(), building: z.boolean(), progress: z.number().nullable(), error: z.string().nullable() }),
  /** owner toggle: start Bot computers when the server starts (FR-PC-07) */
  autoStart: z.boolean(),
  defaults: ComputerLimits,
  gpu: z.boolean(),
  /** whether containers are cut off from the host (pasta without the host gateway, NFR-SEC-08) */
  hostIsolated: z.boolean(),
});
export type ComputerSettings = z.infer<typeof ComputerSettings>;

export const ComputerSettingsPatch = z.object({
  autoStart: z.boolean().optional(),
  defaults: ComputerLimits.partial().optional(),
}).strict();

export const ComputerLimitsPatch = ComputerLimits.partial().strict();

// ---- Coding engine activity (FR-CODE-04)
export const EngineStep = z.object({
  id: z.string(),
  kind: z.enum(['command', 'diff', 'tool', 'plan']),
  /** command line, file path or tool name */
  title: z.string(),
  /** command output, unified diff or tool result (clipped) */
  body: z.string(),
  status: z.enum(['running', 'done', 'failed']),
  exitCode: z.number().nullable(),
});
export type EngineStep = z.infer<typeof EngineStep>;

export const COMPUTER_EVENTS = {
  computerUpdated: 'computer.updated',
  messageSteps: 'message.steps',
} as const;

/** WebSocket path of the live view proxy; frames are base64 RFB bytes after a signed auth frame. */
export const COMPUTER_WS_PATH = '/v1/computer/ws';
export const ComputerWsAuth = z.object({
  type: z.literal('auth'),
  deviceId: z.string(),
  token: z.string(),
  botId: z.string().max(64),
  ts: z.number(),
  nonce: z.string(),
  sig: z.string(),
});
