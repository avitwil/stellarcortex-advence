// Model sources per user (D-07). Keys and subscription sign-ins are sealed in the secret store.
import { SUBSCRIPTION_KINDS, type ModelSource, type ModelSourceKind, type User } from '@advence/protocol';
import type { AppContext } from '../context.js';
import { HttpError } from '../http.js';
import { newId } from '../ids.js';
import type { ModelProvider } from './types.js';
import { OpenAiProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { ClaudeCliProvider, CodexCliProvider } from './cli.js';

interface SourceRow { id: string; user_id: string; kind: ModelSourceKind; name: string; base_url: string | null; created_at: number }

export const OPENAI_BASE = 'https://api.openai.com/v1';

const keyName = (id: string) => `model-key:${id}`;
const tokenName = (id: string) => `model-token:${id}`;

export class ModelSources {
  constructor(private ctx: AppContext) {}

  private row(id: string): SourceRow | undefined {
    return this.ctx.db.prepare('SELECT * FROM model_sources WHERE id = ?').get(id) as SourceRow | undefined;
  }

  private toApi(r: SourceRow): ModelSource {
    const sub = SUBSCRIPTION_KINDS.includes(r.kind);
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      baseUrl: r.base_url,
      hasKey: !sub && !!this.ctx.secrets.get(keyName(r.id)),
      ...(sub ? { signedIn: !!this.ctx.secrets.get(tokenName(r.id)) } : {}),
      createdAt: r.created_at,
    };
  }

  list(userId: string): ModelSource[] {
    return (this.ctx.db.prepare('SELECT * FROM model_sources WHERE user_id = ? ORDER BY created_at').all(userId) as SourceRow[]).map((r) => this.toApi(r));
  }

  owned(user: User, id: string): SourceRow {
    const r = this.row(id);
    if (!r || r.user_id !== user.id) throw new HttpError(404, 'not_found');
    return r;
  }

  /** Validates kind-specific rules: subscription and local servers are the owner's only (D-07c). */
  private check(user: User, kind: ModelSourceKind, baseUrl: string | undefined | null) {
    if ((SUBSCRIPTION_KINDS.includes(kind) || kind === 'local') && user.role !== 'owner') throw new HttpError(403, 'owner_only');
    if (kind === 'local') {
      if (!baseUrl) throw new HttpError(400, 'base_url_required');
      if (!/^https?:\/\//.test(baseUrl)) throw new HttpError(400, 'invalid_base_url');
    } else if (kind === 'openai-compatible') {
      if (!baseUrl || !baseUrl.startsWith('https://')) throw new HttpError(400, 'https_required');
    } else if (baseUrl) throw new HttpError(400, 'base_url_not_allowed');
  }

  create(user: User, b: { kind: ModelSourceKind; name: string; baseUrl?: string; apiKey?: string; token?: string }): ModelSource {
    this.check(user, b.kind, b.baseUrl);
    if ((b.kind === 'openai' || b.kind === 'anthropic' || b.kind === 'openai-compatible') && !b.apiKey) throw new HttpError(400, 'api_key_required');
    const id = newId('src');
    const base = b.kind === 'openai' ? OPENAI_BASE : b.kind === 'local' || b.kind === 'openai-compatible' ? b.baseUrl!.replace(/\/+$/, '') : null;
    this.ctx.db.prepare('INSERT INTO model_sources(id, user_id, kind, name, base_url, created_at) VALUES(?,?,?,?,?,?)').run(id, user.id, b.kind, b.name, base, Date.now());
    if (b.apiKey) this.ctx.secrets.set(keyName(id), b.apiKey);
    if (b.token && SUBSCRIPTION_KINDS.includes(b.kind)) this.ctx.secrets.set(tokenName(id), b.token);
    return this.toApi(this.row(id)!);
  }

  update(user: User, id: string, b: { name?: string; baseUrl?: string; apiKey?: string; token?: string }): ModelSource {
    const r = this.owned(user, id);
    if (b.baseUrl !== undefined) {
      this.check(user, r.kind, b.baseUrl);
      this.ctx.db.prepare('UPDATE model_sources SET base_url = ? WHERE id = ?').run(b.baseUrl.replace(/\/+$/, ''), id);
    }
    if (b.name) this.ctx.db.prepare('UPDATE model_sources SET name = ? WHERE id = ?').run(b.name, id);
    if (b.apiKey && !SUBSCRIPTION_KINDS.includes(r.kind)) this.ctx.secrets.set(keyName(id), b.apiKey);
    if (b.token && SUBSCRIPTION_KINDS.includes(r.kind)) this.ctx.secrets.set(tokenName(id), b.token);
    return this.toApi(this.row(id)!);
  }

  setSubscriptionToken(id: string, token: string): void {
    this.ctx.secrets.set(tokenName(id), token);
  }

  delete(user: User, id: string): void {
    this.owned(user, id);
    this.ctx.db.prepare('DELETE FROM model_sources WHERE id = ?').run(id);
    this.ctx.secrets.delete(keyName(id));
    this.ctx.secrets.delete(tokenName(id));
  }

  /**
   * Raw credentials of a Bot's source for a coding engine in its container (FR-CODE-05): the
   * values are passed to the engine process by environment name only, at run time.
   */
  credentials(botUser: User, sourceId: string): { kind: ModelSourceKind; baseUrl: string | null; secret: string | undefined } {
    const r = this.row(sourceId);
    if (!r || r.user_id !== botUser.id) throw new HttpError(409, 'model_source_missing');
    const subscription = r.kind === 'claude-subscription' || r.kind === 'chatgpt-subscription';
    if (subscription && botUser.role !== 'owner') throw new HttpError(403, 'owner_only');
    return { kind: r.kind, baseUrl: r.base_url, secret: this.ctx.secrets.get(subscription ? tokenName(r.id) : keyName(r.id)) };
  }

  /**
   * The provider for a Bot's configured source (FR-BOT-04). The source must belong to the Bot's
   * owner, and a subscription source only ever serves the server owner's own Bots (D-07c).
   */
  provider(botUser: User, botId: string, sourceId: string): { provider: ModelProvider; kind: ModelSourceKind } {
    const r = this.row(sourceId);
    if (!r || r.user_id !== botUser.id) throw new HttpError(409, 'model_source_missing');
    const f = this.ctx.fetch;
    switch (r.kind) {
      case 'local':
      case 'openai':
      case 'openai-compatible':
        return { kind: r.kind, provider: new OpenAiProvider({ baseUrl: r.base_url ?? OPENAI_BASE, apiKey: this.ctx.secrets.get(keyName(r.id)), fetch: f }) };
      case 'anthropic':
        return { kind: r.kind, provider: new AnthropicProvider({ apiKey: this.ctx.secrets.get(keyName(r.id)) ?? '', baseUrl: this.ctx.testHooks?.anthropicBaseUrl, fetch: f }) };
      case 'claude-subscription':
      case 'chatgpt-subscription': {
        if (botUser.role !== 'owner') throw new HttpError(403, 'owner_only');
        const token = this.ctx.secrets.get(tokenName(r.id));
        return r.kind === 'claude-subscription'
          ? { kind: r.kind, provider: new ClaudeCliProvider({ host: this.ctx.processHost, botId, token }) }
          : { kind: r.kind, provider: new CodexCliProvider({ host: this.ctx.processHost, botId, authJson: token }) };
      }
    }
  }
}
