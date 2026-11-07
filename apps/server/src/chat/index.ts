// P2 chat services, created once per server.
import path from 'node:path';
import type { AppContext } from '../context.js';
import { ModelSources } from '../models/sources.js';
import { CodexLogins } from '../models/login.js';
import { Bots } from './bots.js';
import { ChatStore } from './store.js';
import { Library } from './library.js';
import { UsageLog } from './usage.js';
import { Activity } from './activity.js';
import { Push, NtfySidecar } from './push.js';
import { SearchIndex } from './search.js';
import { ChatRuntime } from './runtime.js';

export interface Chat {
  bots: Bots;
  store: ChatStore;
  sources: ModelSources;
  library: Library;
  usage: UsageLog;
  activity: Activity;
  push: Push;
  search: SearchIndex;
  runtime: ChatRuntime;
  logins: CodexLogins;
  close(): Promise<void>;
}

export function createChat(ctx: AppContext): Chat {
  const bots = new Bots(ctx);
  const store = new ChatStore(ctx);
  const sources = new ModelSources(ctx);
  const library = new Library(ctx);
  const usage = new UsageLog(ctx);
  const activity = new Activity(ctx);
  const push = new Push(ctx);
  const search = new SearchIndex(ctx, store, library);
  const runtime = new ChatRuntime(ctx, { bots, store, sources, library, usage, activity, push, search });
  const logins = new CodexLogins(ctx.processHost, (id, auth) => sources.setSubscriptionToken(id, auth));

  // Replies cut off by a restart are marked, never left spinning (NFR-REL-01).
  const interrupted = store.recoverInterrupted();
  if (interrupted) ctx.log.warn({ interrupted }, 'marked interrupted replies');
  const indexed = search.rebuild();
  ctx.log.info({ indexed }, 'search index rebuilt');

  // The ntfy sidecar runs when the installer provided its binary (D-18).
  let ntfy: NtfySidecar | null = null;
  const bin = process.env.ADVENCE_NTFY_BIN;
  const base = process.env.ADVENCE_NTFY_BASE_URL;
  if (bin && base) {
    ntfy = new NtfySidecar({ binary: bin, listen: process.env.ADVENCE_NTFY_LISTEN ?? ':2586', baseUrl: base, cacheFile: path.join(ctx.config.dataDir, 'ntfy-cache.db'), log: ctx.log });
    ntfy.start();
    if (!push.server()) push.setServer(base);
  }

  return {
    bots, store, sources, library, usage, activity, push, search, runtime, logins,
    async close() {
      ntfy?.stop();
      logins.cancelAll();
      runtime.abortAll();
      await runtime.idle();
      search.close();
    },
  };
}
