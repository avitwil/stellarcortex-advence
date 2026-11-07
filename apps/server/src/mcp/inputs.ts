// Input a server asks for in the middle of a tool call (elicitation, FR-MCP-02/03). Requests
// wait for the user in the chat where the Bot is working; nothing is answered on the user's
// behalf. Form requests that ask for secrets are declined: secrets go through URL mode only.
import type { McpInput, McpInputAnswer } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { HttpError } from '../http.js';
import { newId } from '../ids.js';

export const INPUT_TIMEOUT_MS = 10 * 60_000;

/** Field names, titles or descriptions that look like a request for a secret. */
const SECRET = /pass(word|phrase|code)?\b|secret|token|api[\s_-]?key|private[\s_-]?key|credential|\bpin\b|otp|2fa|cvv|card number|סיסמ|סוד|טוקן|מפתח/i;

export interface ElicitParams {
  mode?: 'form' | 'url';
  message: string;
  requestedSchema?: Record<string, unknown>;
  url?: string;
  elicitationId?: string;
}

export interface ElicitAnswer { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }

export interface InputScope { userId: string; serverId: string; serverName: string; botId: string | null; convId: string | null }

interface Pending { input: McpInput; userId: string; resolve: (a: ElicitAnswer) => void; timer: NodeJS.Timeout }

export function asksForSecret(schema: Record<string, unknown> | undefined, message: string): boolean {
  if (SECRET.test(message) && /\b(enter|type|provide|give|paste)\b|הזן|הקלד/i.test(message)) return true;
  // Field names, titles and the password format. Descriptions are left out: they often say what
  // not to enter ("do not give us your PIN").
  const props = (schema?.properties ?? {}) as Record<string, { title?: unknown; format?: unknown }>;
  for (const [k, v] of Object.entries(props)) {
    if (SECRET.test(k) || SECRET.test(String(v?.title ?? '')) || v?.format === 'password') return true;
  }
  return false;
}

export class InputBroker {
  private pending = new Map<string, Pending>();

  constructor(private ctx: AppContext, private now: () => number = Date.now) {}

  list(userId: string): McpInput[] {
    return [...this.pending.values()].filter((p) => p.userId === userId).map((p) => p.input);
  }

  /** Waits for the user. Resolves with "cancel" on timeout or when the tool call is stopped. */
  ask(scope: InputScope, p: ElicitParams, signal?: AbortSignal): Promise<ElicitAnswer> {
    const mode = p.mode === 'url' ? 'url' : 'form';
    if (mode === 'form' && asksForSecret(p.requestedSchema, p.message)) {
      this.ctx.log.warn({ server: scope.serverId }, 'mcp form elicitation asked for a secret; declined');
      return Promise.resolve({ action: 'decline' });
    }
    if (mode === 'url' && !/^https:\/\//i.test(p.url ?? '')) return Promise.resolve({ action: 'decline' });
    const id = newId('inp');
    const at = this.now();
    const input: McpInput = {
      id,
      serverId: scope.serverId,
      serverName: scope.serverName,
      botId: scope.botId,
      convId: scope.convId,
      mode,
      message: p.message.slice(0, 2000),
      schema: mode === 'form' ? (p.requestedSchema ?? { type: 'object', properties: {} }) : null,
      url: mode === 'url' ? p.url! : null,
      createdAt: at,
      expiresAt: at + INPUT_TIMEOUT_MS,
    };
    return new Promise<ElicitAnswer>((resolve) => {
      const finish = (a: ElicitAnswer) => {
        const cur = this.pending.get(id);
        if (!cur) return;
        clearTimeout(cur.timer);
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        this.ctx.bus.publish(scope.userId, 'mcp.input', { id, done: true });
        resolve(a);
      };
      const onAbort = () => finish({ action: 'cancel' });
      const timer = setTimeout(() => finish({ action: 'cancel' }), INPUT_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { input, userId: scope.userId, resolve: finish, timer });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.ctx.bus.publish(scope.userId, 'mcp.input', input);
    });
  }

  answer(userId: string, id: string, a: McpInputAnswer): void {
    const p = this.pending.get(id);
    if (!p || p.userId !== userId) throw new HttpError(404, 'not_found');
    if (a.action === 'accept' && p.input.mode === 'form') {
      const props = (p.input.schema?.properties ?? {}) as Record<string, unknown>;
      const content: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(a.content ?? {})) if (k in props) content[k] = v;
      const required = (p.input.schema?.required ?? []) as string[];
      if (required.some((k) => content[k] === undefined || content[k] === '')) throw new HttpError(400, 'missing_fields');
      p.resolve({ action: 'accept', content });
      return;
    }
    p.resolve({ action: a.action });
  }

  close(): void {
    for (const p of this.pending.values()) p.resolve({ action: 'cancel' });
  }
}
