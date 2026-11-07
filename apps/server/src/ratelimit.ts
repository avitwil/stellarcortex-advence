// Small fixed-window limiter for unauthenticated routes and failed auth attempts.
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private limit: number, private windowMs: number, private now: () => number = Date.now) {}
  take(key: string): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || h.reset <= t) {
      this.hits.set(key, { n: 1, reset: t + this.windowMs });
      if (this.hits.size > 10_000) this.gc(t);
      return true;
    }
    h.n++;
    return h.n <= this.limit;
  }
  clear(): void {
    this.hits.clear();
  }
  private gc(t: number) {
    for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
  }
}
