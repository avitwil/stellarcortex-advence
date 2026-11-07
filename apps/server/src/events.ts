// In-process event bus feeding WebSocket clients and push.
import { EventEmitter } from 'node:events';

export interface BusEvent {
  userId: string | '*';
  event: string;
  data: unknown;
}

export class Bus {
  private ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(0);
  }
  publish(userId: string | '*', event: string, data: unknown): void {
    this.ee.emit('event', { userId, event, data } satisfies BusEvent);
  }
  subscribe(fn: (e: BusEvent) => void): () => void {
    this.ee.on('event', fn);
    return () => this.ee.off('event', fn);
  }
}
