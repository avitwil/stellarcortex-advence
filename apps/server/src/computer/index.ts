// P3 services: Bot computers, the live view proxy and the Bot tools that use them.
import type { AppContext } from '../context.js';
import { PodmanHost } from '../models/host.js';
import type { Chat } from '../chat/index.js';
import { BotTools } from '../chat/tools.js';
import { ComputerManager, containerName } from './manager.js';
import { networkArgs, type ContainerRuntime, type RuntimeInfo } from './runtime.js';
import { VncProxy } from './vnc.js';

export interface Computers {
  manager: ComputerManager;
  vnc: VncProxy;
  close(): void;
}

/** Used when the server runs without containers (tests with local fake CLIs). */
export class NoRuntime implements ContainerRuntime {
  async info(): Promise<RuntimeInfo> {
    return { available: false, version: null, error: 'runtime_missing', rootless: false, pasta: false };
  }
  async gpu() { return false; }
  async imageExists() { return false; }
  async buildImage(): Promise<void> { throw new Error('no runtime'); }
  async inspect() { return null; }
  async create(): Promise<void> { throw new Error('no runtime'); }
  async start(): Promise<void> { throw new Error('no runtime'); }
  async stop(): Promise<void> {}
  async remove(): Promise<void> {}
  async setSecret(): Promise<void> {}
  async removeSecret(): Promise<void> {}
  exec(): never { throw new Error('no runtime'); }
  interactive(): never { throw new Error('no runtime'); }
  async diskUsage() { return 0; }
}

export function createComputers(ctx: AppContext, chat: Chat, runtime: ContainerRuntime, o: { imageDir?: string; image?: string } = {}): Computers {
  const manager = new ComputerManager(ctx, runtime, o);
  const podman = ctx.processHost instanceof PodmanHost ? ctx.processHost : null;
  let info: RuntimeInfo | null = null;
  void manager.runtimeInfo().then((i) => (info = i));
  // Subscription CLIs and engines run in the Bot's live computer when it is up (D-08).
  podman?.attach({
    running: (botId) => manager.state(botId).state === 'running',
    container: containerName,
    network: () => (info ? networkArgs(info, []).args : []),
  });
  chat.runtime.setTools(new BotTools(ctx, {
    sources: chat.sources, store: chat.store, usage: chat.usage, activity: chat.activity,
    computers: manager, needsComputer: podman !== null,
  }));
  const vnc = new VncProxy(ctx, manager, (botId) => chat.bots.ownerOf(botId));

  // FR-PC-07: the computers of all Bots start with the server when auto-start is on.
  const all = ctx.db.prepare('SELECT id, user_id FROM bots WHERE archived_at IS NULL').all() as { id: string; user_id: string }[];
  void manager.init(all.map((b) => ({ id: b.id, userId: b.user_id })));

  return {
    manager,
    vnc,
    close() {
      vnc.close();
      manager.close();
    },
  };
}
